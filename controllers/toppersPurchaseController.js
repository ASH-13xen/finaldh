import ToppersPurchaseRequest from '../models/ToppersPurchaseRequest.js';
import ToppersCopyPricing, { ALL_SUBJECTS } from '../models/ToppersCopyPricing.js';
import ToppersCopy from '../models/ToppersCopy.js';
import User from '../models/User.js';

// Buying Toppers Copy access - the same manual UPI-screenshot-plus-admin-approval flow as
// mcqPurchaseController.js. A plan is one subject or ALL_SUBJECTS (the bundle).

const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

const loadAdmin = async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Access denied: Admin only' });
    return null;
  }
  return user;
};

const effectivePrice = (p) => (p.useDiscount ? p.discountedPrice : p.price);

// Every plan a student could buy: the subjects that have published topics, then the bundle.
const listPlans = async ({ includeUnpublished = false } = {}) => {
  const subjects = (await ToppersCopy.distinct('subject', includeUnpublished ? {} : { published: true })).sort();
  const pricing = new Map((await ToppersCopyPricing.find({}).lean()).map(p => [p.plan, p]));
  return [...subjects, ALL_SUBJECTS].map(plan => {
    const p = pricing.get(plan);
    return {
      plan,
      price: p?.price ?? null,
      discountedPrice: p?.discountedPrice ?? 0,
      useDiscount: p?.useDiscount ?? false,
      configured: !!p
    };
  });
};

const ownsPlan = (user, plan) => {
  const owned = user.purchasedToppersSubjects || [];
  return owned.includes(ALL_SUBJECTS) || owned.includes(plan);
};

// GET /store - plans with prices, what this student owns, and their requests.
export const getToppersStore = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('email purchasedToppersSubjects').lean();
    if (!user) return res.status(404).json({ error: 'User profile not found' });
    const [plans, requests] = await Promise.all([
      listPlans(),
      ToppersPurchaseRequest.find({ userId: req.userId }).select('-screenshotData').sort({ createdAt: -1 }).lean()
    ]);
    res.json({
      isAdmin: isAdminEmail(user.email),
      plans: plans.map(p => ({ ...p, owned: ownsPlan(user, p.plan) })),
      requests
    });
  } catch (err) {
    console.error('Error loading Toppers Copy store:', err);
    res.status(500).json({ error: 'Server error loading prices' });
  }
};

// POST /purchase-requests (multipart: plan, upiTxnId?, screenshot)
export const createToppersPurchaseRequest = async (req, res) => {
  const { plan, upiTxnId } = req.body;
  const screenshotFile = req.file;

  if (!plan) return res.status(400).json({ error: 'Choose a subject or the all-subjects bundle' });
  if (!screenshotFile) return res.status(400).json({ error: 'Payment screenshot is required' });

  const cleanedTxnId = upiTxnId ? upiTxnId.trim() : '';

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User profile not found' });
    if (isAdminEmail(user.email)) {
      return res.status(400).json({ error: 'Admins do not need to purchase Toppers Copy' });
    }

    if (plan !== ALL_SUBJECTS && !(await ToppersCopy.exists({ subject: plan, published: true }))) {
      return res.status(400).json({ error: 'Unknown subject' });
    }
    if (ownsPlan(user, plan)) {
      return res.status(400).json({ error: 'You already have access to this' });
    }

    if (cleanedTxnId) {
      const escaped = cleanedTxnId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const existingTxn = await ToppersPurchaseRequest.findOne({ upiTxnId: { $regex: new RegExp(`^${escaped}$`, 'i') } });
      if (existingTxn) return res.status(400).json({ error: 'This UPI Transaction ID has already been submitted' });
    }

    const existingPending = await ToppersPurchaseRequest.findOne({ userId: req.userId, plan, status: 'pending' });
    if (existingPending) {
      return res.status(400).json({ error: 'You already have a pending purchase request for this' });
    }

    const pricing = await ToppersCopyPricing.findOne({ plan });
    if (!pricing) {
      return res.status(400).json({ error: 'Pricing is not configured for this yet. Please contact the admin.' });
    }

    const newRequest = new ToppersPurchaseRequest({
      userId: user._id,
      userEmail: user.email,
      userName: user.fullName || user.name,
      plan,
      price: effectivePrice(pricing),
      screenshotData: screenshotFile.buffer,
      screenshotContentType: screenshotFile.mimetype,
      upiTxnId: cleanedTxnId || undefined,
      status: 'pending'
    });
    newRequest.screenshotUrl = `/api/toppers-copy/purchase-requests/${newRequest._id}/screenshot`;
    await newRequest.save();

    const { screenshotData: _omit, ...request } = newRequest.toObject();
    res.json({
      message: 'Purchase request submitted successfully. It will be verified within 6-8 hours.',
      request
    });
  } catch (err) {
    console.error('Error creating Toppers Copy purchase request:', err);
    res.status(500).json({ error: 'Server error submitting purchase request' });
  }
};

// GET /purchase-requests/:id/screenshot - admin, or the student who submitted it
export const getToppersPurchaseScreenshot = async (req, res) => {
  try {
    const request = await ToppersPurchaseRequest.findById(req.params.id).select('userId screenshotData screenshotContentType');
    if (!request) return res.status(404).json({ error: 'Purchase request not found' });

    const requester = await User.findById(req.userId);
    if (!requester) return res.status(404).json({ error: 'User not found' });
    if (!isAdminEmail(requester.email) && request.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!request.screenshotData) return res.status(404).json({ error: 'No screenshot stored for this request' });

    res.set('Content-Type', request.screenshotContentType || 'image/jpeg');
    res.send(request.screenshotData);
  } catch (err) {
    console.error('Error serving Toppers Copy purchase screenshot:', err);
    res.status(500).json({ error: 'Server error retrieving screenshot' });
  }
};

// POST /purchase-requests/:id/notify-telegram - at most twice per request
export const trackToppersTelegramNotification = async (req, res) => {
  try {
    const request = await ToppersPurchaseRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Purchase request not found' });
    if (request.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied: You do not own this purchase request' });
    }
    if (request.telegramNotificationCount >= 2) {
      return res.status(400).json({ error: 'Notification limit reached' });
    }
    request.telegramNotificationCount = (request.telegramNotificationCount || 0) + 1;
    await request.save();
    res.json({ success: true, telegramNotificationCount: request.telegramNotificationCount });
  } catch (err) {
    console.error('Error tracking Toppers Copy telegram notification:', err);
    res.status(500).json({ error: 'Server error tracking telegram notification' });
  }
};

// GET /admin/purchase-requests
export const getAdminToppersPurchaseRequests = async (req, res) => {
  try {
    if (!(await loadAdmin(req, res))) return;
    const requests = await ToppersPurchaseRequest.find({}).select('-screenshotData').sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    console.error('Error fetching admin Toppers Copy purchase requests:', err);
    res.status(500).json({ error: 'Server error retrieving purchase requests' });
  }
};

// POST /admin/purchase-requests/:id/approve - grants the plan via User.purchasedToppersSubjects
export const approveToppersPurchaseRequest = async (req, res) => {
  try {
    if (!(await loadAdmin(req, res))) return;

    const request = await ToppersPurchaseRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Purchase request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been processed (Status: ${request.status})` });
    }

    const updated = await User.updateOne({ _id: request.userId }, { $addToSet: { purchasedToppersSubjects: request.plan } });
    if (!updated.matchedCount) return res.status(404).json({ error: 'Student user not found' });

    request.status = 'approved';
    await request.save();
    res.json({ message: 'Purchase request approved. Access granted to the student.', request });
  } catch (err) {
    console.error('Error approving Toppers Copy purchase request:', err);
    res.status(500).json({ error: 'Server error approving purchase request' });
  }
};

// POST /admin/purchase-requests/:id/reject
export const rejectToppersPurchaseRequest = async (req, res) => {
  try {
    if (!(await loadAdmin(req, res))) return;

    const request = await ToppersPurchaseRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Purchase request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request has already been processed (Status: ${request.status})` });
    }

    request.status = 'rejected';
    await request.save();
    res.json({ message: 'Purchase request rejected successfully.', request });
  } catch (err) {
    console.error('Error rejecting Toppers Copy purchase request:', err);
    res.status(500).json({ error: 'Server error rejecting purchase request' });
  }
};

// GET /admin/pricing - every subject (published or not) plus the bundle, with prices
export const getToppersPricingAdmin = async (req, res) => {
  try {
    if (!(await loadAdmin(req, res))) return;
    res.json({ plans: await listPlans({ includeUnpublished: true }) });
  } catch (err) {
    console.error('Error listing Toppers Copy pricing:', err);
    res.status(500).json({ error: 'Server error listing pricing' });
  }
};

// PUT /admin/pricing/:plan
export const upsertToppersPricing = async (req, res) => {
  try {
    if (!(await loadAdmin(req, res))) return;

    const { plan } = req.params;
    const { price, discountedPrice, useDiscount } = req.body;
    if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: 'A valid price is required' });
    }
    if (plan !== ALL_SUBJECTS && !(await ToppersCopy.exists({ subject: plan }))) {
      return res.status(400).json({ error: 'Unknown subject' });
    }

    const pricing = await ToppersCopyPricing.findOneAndUpdate(
      { plan },
      { $set: { price: Number(price), discountedPrice: Number(discountedPrice) || 0, useDiscount: !!useDiscount } },
      { new: true, upsert: true }
    );
    res.json({ pricing });
  } catch (err) {
    console.error('Error updating Toppers Copy pricing:', err);
    res.status(500).json({ error: 'Server error updating pricing' });
  }
};
