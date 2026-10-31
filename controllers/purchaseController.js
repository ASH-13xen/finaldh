import PurchaseRequest from '../models/PurchaseRequest.js';
import { grantCourseAccess } from '../utils/purchaseFulfillment.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
// Registers the model the comboOffer populate() calls below resolve against
import '../models/ComboOffer.js';

// Legacy manual-UPI purchase requests. New purchases go through Razorpay (paymentController.js); students
// can no longer submit these, but requests already submitted stay reviewable here until the queue is clear.

// Retrieve purchase requests for the logged-in student
export const getStudentPurchaseRequests = async (req, res) => {
  try {
    const requests = await PurchaseRequest.find({ userId: req.userId })
      .select('-screenshotData')
      .sort({ createdAt: -1 })
      .populate({ path: 'courses', select: 'name courseId', model: Course })
      .populate('comboOffer', 'label price');
    res.json(requests);
  } catch (err) {
    console.error('Error fetching student purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// Retrieve all purchase requests for admin
export const getAdminPurchaseRequests = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((user.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    // Exclude screenshotData (a raw image Buffer, up to 10MB, stored per request):
    // the admin list view never uses it — screenshots are fetched on demand via
    // the dedicated getPurchaseRequestScreenshot endpoint — so including it here
    // meant loading every screenshot's full bytes into memory on every page load.
    const requests = await PurchaseRequest.find({})
      .select('-screenshotData')
      .sort({ createdAt: -1 })
      .populate({ path: 'courses', select: 'name courseId', model: Course })
      .populate('comboOffer', 'label price');
    res.json(requests);
  } catch (err) {
    console.error('Error fetching admin purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// Serve the payment screenshot stored in MongoDB (admin, or the student who submitted it)
export const getPurchaseRequestScreenshot = async (req, res) => {
  const { id } = req.params;

  try {
    const request = await PurchaseRequest.findById(id).select('userId screenshotData screenshotContentType');
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    const requester = await User.findById(req.userId);
    if (!requester) {
      return res.status(404).json({ error: 'User not found' });
    }
    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((requester.email || '').toLowerCase());
    if (!isAdmin && request.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!request.screenshotData) {
      return res.status(404).json({ error: 'No screenshot stored for this request' });
    }

    res.set('Content-Type', request.screenshotContentType || 'image/jpeg');
    res.send(request.screenshotData);
  } catch (err) {
    console.error('Error serving purchase request screenshot:', err);
    res.status(500).json({ error: 'Server error retrieving screenshot' });
  }
};

// Approve a purchase request (Admin only)
export const approvePurchaseRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been processed (Status: ${request.status})` });
    }

    const targetUser = await User.findById(request.userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Student user not found' });
    }

    // Resolve every course covered by this request (combo = multiple, legacy/single = one)
    const courseObjectIds = (request.courses && request.courses.length > 0)
      ? request.courses
      : [request.courseObjectId];
    const coursesInRequest = await Course.find({ _id: { $in: courseObjectIds } });

    await grantCourseAccess(targetUser._id, coursesInRequest);

    request.status = 'approved';
    await request.save();

    res.json({
      message: 'Purchase request approved successfully! Course added to student profile.',
      request
    });
  } catch (err) {
    console.error('Error approving purchase request:', err);
    res.status(500).json({ error: 'Server error approving purchase request' });
  }
};

// Reject a purchase request (Admin only)
export const rejectPurchaseRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been processed (Status: ${request.status})` });
    }

    request.status = 'rejected';
    await request.save();

    res.json({
      message: 'Purchase request rejected successfully.',
      request
    });
  } catch (err) {
    console.error('Error rejecting purchase request:', err);
    res.status(500).json({ error: 'Server error rejecting purchase request' });
  }
};

// Track Telegram notification clicks (limit to twice per student purchase request)
export const trackTelegramNotification = async (req, res) => {
  const { id } = req.params;

  try {
    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    // Ensure user owns this request
    if (request.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied: You do not own this purchase request' });
    }

    if (request.telegramNotificationCount >= 2) {
      return res.status(400).json({ error: 'Notification limit reached' });
    }

    request.telegramNotificationCount = (request.telegramNotificationCount || 0) + 1;
    await request.save();

    res.json({
      success: true,
      telegramNotificationCount: request.telegramNotificationCount,
      request
    });
  } catch (err) {
    console.error('Error tracking telegram notification:', err);
    res.status(500).json({ error: 'Server error tracking telegram notification' });
  }
};

// Highlight a purchase request (Admin only)
export const highlightPurchaseRequest = async (req, res) => {
  const { id } = req.params;
  const { highlight } = req.body;

  if (!['none', 'red', 'yellow'].includes(highlight)) {
    return res.status(400).json({ error: 'Invalid highlight color value. Must be none, red, or yellow.' });
  }

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2].filter(Boolean).map(e => e.toLowerCase()).includes((adminUser.email || '').toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await PurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    request.highlight = highlight;
    await request.save();

    res.json({
      message: `Purchase request highlight updated to ${highlight} successfully.`,
      request
    });
  } catch (err) {
    console.error('Error highlighting purchase request:', err);
    res.status(500).json({ error: 'Server error highlighting purchase request' });
  }
};
