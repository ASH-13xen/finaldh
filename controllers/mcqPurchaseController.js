import McqPurchaseRequest from '../models/McqPurchaseRequest.js';
import { grantMcqSubjectAccess, grantMcqTestAccess } from '../utils/purchaseFulfillment.js';
import User from '../models/User.js';
import McqTest from '../models/McqTest.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';

const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

// Legacy manual-UPI MCQ purchase requests. New subject purchases go through Razorpay (paymentController.js);
// students can no longer submit these, but requests already submitted stay reviewable until the queue is clear.

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
      await grantMcqSubjectAccess(targetUser._id, request.subject);
    } else {
      await grantMcqTestAccess(targetUser._id, request.mcqTestObjectId);
    }

    request.status = 'approved';
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
