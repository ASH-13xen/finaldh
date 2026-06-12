import PurchaseRequest from '../models/PurchaseRequest.js';
import User from '../models/User.js';
import Course from '../models/Course.js';

// Create a new purchase request for a course
export const createPurchaseRequest = async (req, res) => {
  const { courseId, upiTxnId } = req.body;
  const screenshotFile = req.file;

  if (!courseId) {
    return res.status(400).json({ error: 'Course ID is required' });
  }
  if (!upiTxnId || !upiTxnId.trim()) {
    return res.status(400).json({ error: 'UPI Transaction ID is required' });
  }
  if (!screenshotFile) {
    return res.status(400).json({ error: 'Payment screenshot is required' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const isAdmin = user.email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase();
    if (isAdmin) {
      return res.status(400).json({ error: 'Admins do not need to purchase courses' });
    }

    // Find the course by custom courseId
    const course = await Course.findOne({ courseId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Check if course is already in student's interestedCourses
    const hasPurchased = user.interestedCourses.some(
      (cId) => cId.toLowerCase() === courseId.toLowerCase()
    );
    if (hasPurchased) {
      return res.status(400).json({ error: 'You have already purchased this course' });
    }

    // Check if there is already a pending purchase request for this course by this student
    const existingPending = await PurchaseRequest.findOne({
      userId: req.userId,
      courseId,
      status: 'pending'
    });
    if (existingPending) {
      return res.status(400).json({ error: 'You already have a pending purchase request for this course' });
    }

    // Check if the UPI transaction ID has already been used (case-insensitive check)
    const existingTxn = await PurchaseRequest.findOne({
      upiTxnId: { $regex: new RegExp(`^${upiTxnId.trim()}$`, 'i') }
    });
    if (existingTxn) {
      return res.status(400).json({ error: 'This UPI Transaction ID has already been submitted' });
    }

    // screenshotUrl should be relative path from backend/ uploads statically served directory
    const screenshotUrl = `/uploads/screenshots/${screenshotFile.filename}`;

    const newRequest = new PurchaseRequest({
      userId: user._id,
      userEmail: user.email,
      userName: user.fullName || user.name,
      courseObjectId: course._id,
      courseId: course.courseId,
      courseName: course.name,
      price: course.price,
      screenshotUrl,
      upiTxnId: upiTxnId.trim(),
      status: 'pending'
    });

    await newRequest.save();

    res.json({
      message: 'Purchase request submitted successfully. It will be verified within 6-8 hours.',
      request: newRequest
    });
  } catch (err) {
    console.error('Error creating purchase request:', err);
    res.status(500).json({ error: 'Server error submitting purchase request' });
  }
};

// Retrieve purchase requests for the logged-in student
export const getStudentPurchaseRequests = async (req, res) => {
  try {
    const requests = await PurchaseRequest.find({ userId: req.userId }).sort({ createdAt: -1 });
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

    const isAdmin = user.email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase();
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin only' });
    }

    const requests = await PurchaseRequest.find({}).sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    console.error('Error fetching admin purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
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

    const isAdmin = adminUser.email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase();
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

    // Add custom courseId to interestedCourses if not already there
    if (!targetUser.interestedCourses.includes(request.courseId)) {
      targetUser.interestedCourses.push(request.courseId);
    }

    // Add courseObjectId to purchasedCourses if not already there
    if (!targetUser.purchasedCourses.includes(request.courseObjectId)) {
      targetUser.purchasedCourses.push(request.courseObjectId);
    }

    // Pre-initialize downloadLimit configuration for this course to give them 1 download access
    const existingLimit = targetUser.downloadLimits.find(d => d.courseId === request.courseId);
    if (!existingLimit) {
      targetUser.downloadLimits.push({
        courseId: request.courseId,
        downloadedCount: 0,
        allowedCount: 1
      });
    }

    request.status = 'approved';

    await targetUser.save();
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

    const isAdmin = adminUser.email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase();
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
