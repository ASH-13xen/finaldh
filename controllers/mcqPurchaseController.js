import McqPurchaseRequest from '../models/McqPurchaseRequest.js';
import User from '../models/User.js';
import McqTest from '../models/McqTest.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';

const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

// Create a new purchase request - either for a whole subject (req.body.subject, the primary
// path surfaced in the UI) or a single MCQ test (req.body.mcqTestId, kept working for any
// pre-existing callers/data).
export const createMcqPurchaseRequest = async (req, res) => {
  const { mcqTestId, subject, upiTxnId } = req.body;
  const screenshotFile = req.file;

  if (!mcqTestId && !subject) {
    return res.status(400).json({ error: 'MCQ test ID or subject is required' });
  }
  if (!screenshotFile) {
    return res.status(400).json({ error: 'Payment screenshot is required' });
  }

  const cleanedTxnId = upiTxnId ? upiTxnId.trim() : '';

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    if (isAdminEmail(user.email)) {
      return res.status(400).json({ error: 'Admins do not need to purchase MCQ tests' });
    }

    if (cleanedTxnId) {
      const existingTxn = await McqPurchaseRequest.findOne({
        upiTxnId: { $regex: new RegExp(`^${cleanedTxnId}$`, 'i') }
      });
      if (existingTxn) {
        return res.status(400).json({ error: 'This UPI Transaction ID has already been submitted' });
      }
    }

    if (subject) {
      const alreadyOwned = user.purchasedMcqSubjects.includes(subject);
      if (alreadyOwned) {
        return res.status(400).json({ error: 'You already have full access to this subject' });
      }

      const existingPending = await McqPurchaseRequest.findOne({
        userId: req.userId, purchaseType: 'subject', subject, status: 'pending'
      });
      if (existingPending) {
        return res.status(400).json({ error: 'You already have a pending purchase request for this subject' });
      }

      const pricing = await McqSubjectPricing.findOne({ subject });
      if (!pricing) {
        return res.status(400).json({ error: 'Pricing is not configured for this subject yet. Please contact the admin.' });
      }

      const newRequest = new McqPurchaseRequest({
        userId: user._id,
        userEmail: user.email,
        userName: user.fullName || user.name,
        purchaseType: 'subject',
        subject,
        price: pricing.useDiscount ? pricing.discountedPrice : pricing.price,
        screenshotData: screenshotFile.buffer,
        screenshotContentType: screenshotFile.mimetype,
        upiTxnId: cleanedTxnId || undefined,
        status: 'pending'
      });
      newRequest.screenshotUrl = `/api/mcq/purchase-requests/${newRequest._id}/screenshot`;
      await newRequest.save();

      return res.json({
        message: 'Purchase request submitted successfully. It will be verified within 6-8 hours.',
        request: newRequest
      });
    }

    const test = await McqTest.findById(mcqTestId);
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found' });
    }

    const alreadyOwned = user.purchasedMcqTests.some((id) => id.equals(test._id)) || user.purchasedMcqSubjects.includes(test.subject);
    if (alreadyOwned) {
      return res.status(400).json({ error: 'You have already purchased this test' });
    }

    const existingPending = await McqPurchaseRequest.findOne({
      userId: req.userId,
      mcqTestObjectId: test._id,
      status: 'pending'
    });
    if (existingPending) {
      return res.status(400).json({ error: 'You already have a pending purchase request for this test' });
    }

    const newRequest = new McqPurchaseRequest({
      userId: user._id,
      userEmail: user.email,
      userName: user.fullName || user.name,
      purchaseType: 'test',
      mcqTestObjectId: test._id,
      mcqTestTitle: test.title,
      price: test.useDiscount ? test.discountedPrice : test.price,
      screenshotData: screenshotFile.buffer,
      screenshotContentType: screenshotFile.mimetype,
      upiTxnId: cleanedTxnId || undefined,
      status: 'pending'
    });
    newRequest.screenshotUrl = `/api/mcq/purchase-requests/${newRequest._id}/screenshot`;

    await newRequest.save();

    res.json({
      message: 'Purchase request submitted successfully. It will be verified within 6-8 hours.',
      request: newRequest
    });
  } catch (err) {
    console.error('Error creating MCQ purchase request:', err);
    res.status(500).json({ error: 'Server error submitting purchase request' });
  }
};

// Retrieve purchase requests for the logged-in student
export const getStudentMcqPurchaseRequests = async (req, res) => {
  try {
    const requests = await McqPurchaseRequest.find({ userId: req.userId })
      .select('-screenshotData')
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    console.error('Error fetching student MCQ purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// Retrieve all MCQ purchase requests for admin
export const getAdminMcqPurchaseRequests = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !isAdminEmail(user.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const requests = await McqPurchaseRequest.find({})
      .select('-screenshotData')
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    console.error('Error fetching admin MCQ purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// Serve the payment screenshot stored in MongoDB (admin, or the student who submitted it)
export const getMcqPurchaseRequestScreenshot = async (req, res) => {
  const { id } = req.params;

  try {
    const request = await McqPurchaseRequest.findById(id).select('userId screenshotData screenshotContentType');
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

    const requester = await User.findById(req.userId);
    if (!requester) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!isAdminEmail(requester.email) && request.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!request.screenshotData) {
      return res.status(404).json({ error: 'No screenshot stored for this request' });
    }

    res.set('Content-Type', request.screenshotContentType || 'image/jpeg');
    res.send(request.screenshotData);
  } catch (err) {
    console.error('Error serving MCQ purchase request screenshot:', err);
    res.status(500).json({ error: 'Server error retrieving screenshot' });
  }
};

// Approve a purchase request (Admin only) - grants access via User.purchasedMcqTests
export const approveMcqPurchaseRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser || !isAdminEmail(adminUser.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await McqPurchaseRequest.findById(id);
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

    if (request.purchaseType === 'subject') {
      if (!targetUser.purchasedMcqSubjects.includes(request.subject)) {
        targetUser.purchasedMcqSubjects.push(request.subject);
      }
    } else if (!targetUser.purchasedMcqTests.some((id) => id.equals(request.mcqTestObjectId))) {
      targetUser.purchasedMcqTests.push(request.mcqTestObjectId);
    }

    request.status = 'approved';

    await targetUser.save();
    await request.save();

    res.json({
      message: request.purchaseType === 'subject'
        ? 'Purchase request approved successfully! Full subject access granted to student.'
        : 'Purchase request approved successfully! Test added to student profile.',
      request
    });
  } catch (err) {
    console.error('Error approving MCQ purchase request:', err);
    res.status(500).json({ error: 'Server error approving purchase request' });
  }
};

// Reject a purchase request (Admin only)
export const rejectMcqPurchaseRequest = async (req, res) => {
  const { id } = req.params;

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser || !isAdminEmail(adminUser.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await McqPurchaseRequest.findById(id);
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
    console.error('Error rejecting MCQ purchase request:', err);
    res.status(500).json({ error: 'Server error rejecting purchase request' });
  }
};

// Track Telegram notification clicks (limit to twice per student purchase request)
export const trackMcqTelegramNotification = async (req, res) => {
  const { id } = req.params;

  try {
    const request = await McqPurchaseRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Purchase request not found' });
    }

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
    console.error('Error tracking MCQ telegram notification:', err);
    res.status(500).json({ error: 'Server error tracking telegram notification' });
  }
};

// List every subject that has at least one MCQ test, with its current pricing (if set).
export const getSubjectPricingAdmin = async (req, res) => {
  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser || !isAdminEmail(adminUser.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const subjectsWithTests = await McqTest.distinct('subject');
    const pricingDocs = await McqSubjectPricing.find({});
    const pricingBySubject = {};
    pricingDocs.forEach(p => { pricingBySubject[p.subject] = p; });

    const subjects = subjectsWithTests.sort().map(subject => {
      const p = pricingBySubject[subject];
      return {
        subject,
        price: p?.price ?? 999,
        discountedPrice: p?.discountedPrice ?? 0,
        useDiscount: p?.useDiscount ?? false,
        configured: !!p
      };
    });

    res.json({ subjects });
  } catch (err) {
    console.error('Error listing MCQ subject pricing:', err);
    res.status(500).json({ error: 'Server error listing subject pricing' });
  }
};

// Create or update the flat bundle price for a subject (Admin only)
export const upsertSubjectPricing = async (req, res) => {
  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser || !isAdminEmail(adminUser.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const { subject } = req.params;
    const { price, discountedPrice, useDiscount } = req.body;
    if (price === undefined || price === null || isNaN(Number(price))) {
      return res.status(400).json({ error: 'A valid price is required' });
    }

    const pricing = await McqSubjectPricing.findOneAndUpdate(
      { subject },
      { $set: { price: Number(price), discountedPrice: Number(discountedPrice) || 0, useDiscount: !!useDiscount } },
      { new: true, upsert: true }
    );

    res.json({ pricing });
  } catch (err) {
    console.error('Error updating MCQ subject pricing:', err);
    res.status(500).json({ error: 'Server error updating subject pricing' });
  }
};

// Highlight a purchase request (Admin only)
export const highlightMcqPurchaseRequest = async (req, res) => {
  const { id } = req.params;
  const { highlight } = req.body;

  if (!['none', 'red', 'yellow'].includes(highlight)) {
    return res.status(400).json({ error: 'Invalid highlight color value. Must be none, red, or yellow.' });
  }

  try {
    const adminUser = await User.findById(req.userId);
    if (!adminUser || !isAdminEmail(adminUser.email)) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const request = await McqPurchaseRequest.findById(id);
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
    console.error('Error highlighting MCQ purchase request:', err);
    res.status(500).json({ error: 'Server error highlighting purchase request' });
  }
};
