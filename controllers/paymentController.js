import Payment from '../models/Payment.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import ComboOffer from '../models/ComboOffer.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';
import PurchaseRequest from '../models/PurchaseRequest.js';
import McqPurchaseRequest from '../models/McqPurchaseRequest.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { userHasCourseAccess } from '../utils/courseAccess.js';
import { grantCourseAccess, grantMcqSubjectAccess } from '../utils/purchaseFulfillment.js';
import {
  getRazorpay,
  razorpayKeyId,
  isRazorpayConfigured,
  isValidPaymentSignature,
  isValidWebhookSignature
} from '../config/razorpay.js';

// Razorpay checkout flow:
//   1. POST /order   - we decide what is being bought and its price (never the browser), create a
//                      Razorpay order and a Payment record (status 'created').
//   2. Checkout      - the student pays in Razorpay's popup.
//   3. POST /verify  - the browser sends back Razorpay's signed result; we check the signature, confirm the
//                      payment with Razorpay and grant access.
//   Safety nets for when step 3 never arrives (tab closed, network drop):
//   - POST /razorpay/webhook - Razorpay tells us server-to-server.
//   - GET /orders/:orderId/status - asks Razorpay directly (also what makes local testing work, where
//                      webhooks can't reach localhost).
// All three paths end in settlePayment(), which grants access exactly once.

const RAZORPAY_MIN_AMOUNT = 100; // paise - Razorpay rejects orders below ₹1

class PurchaseError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const effectivePrice = (doc) => (doc.useDiscount ? doc.discountedPrice : doc.price);

// What the student is buying, resolved and priced from the database alone. Throws PurchaseError when the
// purchase isn't allowed (already owned, combo picked wrongly, pricing not set, ...).
async function resolvePurchase(user, body) {
  const { kind } = body;

  if (kind === 'course') {
    const course = await Course.findOne({ courseId: String(body.courseId || '') });
    if (!course) throw new PurchaseError(404, 'Course not found');
    if (userHasCourseAccess(user, course)) throw new PurchaseError(400, 'You have already purchased this course');

    const pendingUpi = await PurchaseRequest.exists({ userId: user._id, courseId: course.courseId, status: 'pending' });
    if (pendingUpi) throw new PurchaseError(400, 'Your earlier UPI payment for this course is still being verified');

    return { kind, itemLabel: course.name, price: effectivePrice(course), courses: [course], courseIds: [course.courseId] };
  }

  if (kind === 'combo') {
    const comboOffer = await ComboOffer.findById(body.comboOfferId).catch(() => null);
    if (!comboOffer || !comboOffer.active) throw new PurchaseError(404, 'Combo offer not found');

    const selected = body.selectedCourseIds;
    if (!Array.isArray(selected) || selected.length !== comboOffer.pickCount || selected.some((id) => typeof id !== 'string')) {
      throw new PurchaseError(400, `You must select exactly ${comboOffer.pickCount} course(s) for this combo`);
    }
    if (new Set(selected).size !== selected.length) throw new PurchaseError(400, 'Duplicate courses selected');
    if (selected.some((id) => !comboOffer.eligibleCourseIds.includes(id))) {
      throw new PurchaseError(400, 'Selected course is not eligible for this combo');
    }

    const finalCourseIds = [...selected, ...comboOffer.requiredCourseIds];
    const courses = await Course.find({ courseId: { $in: finalCourseIds } });
    if (courses.length !== finalCourseIds.length) {
      throw new PurchaseError(404, 'One or more courses in this combo are no longer available');
    }
    if (courses.some((c) => userHasCourseAccess(user, c))) {
      throw new PurchaseError(400, 'You already have access to one or more courses in this combo');
    }

    const pendingUpi = await PurchaseRequest.exists({ userId: user._id, comboOffer: comboOffer._id, status: 'pending' });
    if (pendingUpi) throw new PurchaseError(400, 'Your earlier UPI payment for this combo is still being verified');

    return {
      kind,
      itemLabel: comboOffer.label,
      price: comboOffer.price,
      courses,
      courseIds: courses.map((c) => c.courseId),
      comboOffer: comboOffer._id
    };
  }

  if (kind === 'mcq_subject') {
    const subject = String(body.subject || '');
    if (!subject) throw new PurchaseError(400, 'Subject is required');
    if (user.purchasedMcqSubjects.includes(subject)) throw new PurchaseError(400, 'You already have full access to this subject');

    const pricing = await McqSubjectPricing.findOne({ subject });
    if (!pricing) throw new PurchaseError(400, 'Pricing is not configured for this subject yet. Please contact the admin.');

    const pendingUpi = await McqPurchaseRequest.exists({ userId: user._id, purchaseType: 'subject', subject, status: 'pending' });
    if (pendingUpi) throw new PurchaseError(400, 'Your earlier UPI payment for this subject is still being verified');

    return { kind, itemLabel: `MCQ Test Series — ${subject} (all tests)`, price: effectivePrice(pricing), subject };
  }

  throw new PurchaseError(400, 'Unknown purchase type');
}

async function grantPaymentAccess(payment) {
  if (payment.kind === 'mcq_subject') {
    await grantMcqSubjectAccess(payment.userId, payment.subject);
    return;
  }
  const courses = await Course.find({ _id: { $in: payment.courses } });
  await grantCourseAccess(payment.userId, courses);
}

// Marks the order paid (first caller wins) and makes sure access is granted. Safe to call any number of
// times from any of the three confirmation paths.
async function settlePayment(orderId, { paymentId, method, via }) {
  await Payment.updateOne(
    { razorpayOrderId: orderId, status: { $ne: 'paid' } },
    { $set: { status: 'paid', razorpayPaymentId: paymentId, method, paidAt: new Date(), confirmedVia: via }, $unset: { failureReason: 1 } }
  );
  const payment = await Payment.findOne({ razorpayOrderId: orderId });
  if (payment && !payment.fulfilledAt) {
    await grantPaymentAccess(payment);
    payment.fulfilledAt = new Date();
    await payment.save();
    console.log(`[Payments] ${payment.razorpayOrderId} paid via ${via}: ${payment.userEmail} unlocked "${payment.itemLabel}"`);
  }
  return payment;
}

// Makes sure Razorpay actually holds the money for this order. A payment that is only 'authorized' (when
// the account's auto-capture is off) is captured here - otherwise Razorpay refunds it after a few days
// while the student keeps the access. Returns true once the payment is captured.
async function ensureCaptured(rzpPayment, payment) {
  if (rzpPayment.order_id !== payment.razorpayOrderId) return false;
  if (Number(rzpPayment.amount) !== payment.amount || rzpPayment.currency !== payment.currency) return false;
  if (rzpPayment.status === 'captured') return true;
  if (rzpPayment.status !== 'authorized') return false;

  const razorpay = getRazorpay();
  try {
    const captured = await razorpay.payments.capture(rzpPayment.id, payment.amount, payment.currency);
    return captured.status === 'captured';
  } catch {
    // Auto-capture may have got there first, in which case Razorpay refuses a second capture
    const fresh = await razorpay.payments.fetch(rzpPayment.id);
    return fresh.status === 'captured';
  }
}

const paymentSummary = (p) => ({
  orderId: p.razorpayOrderId,
  paymentId: p.razorpayPaymentId,
  status: p.status,
  kind: p.kind,
  itemLabel: p.itemLabel,
  amount: p.amount,
  courseIds: p.courseIds,
  subject: p.subject
});

const loadOwnPayment = async (req, orderId) => {
  if (typeof orderId !== 'string' || !orderId) throw new PurchaseError(400, 'Order ID is required');
  const payment = await Payment.findOne({ razorpayOrderId: orderId });
  if (!payment || String(payment.userId) !== String(req.userId)) throw new PurchaseError(404, 'Order not found');
  return payment;
};

const sendError = (res, err, fallback) => {
  if (err instanceof PurchaseError) return res.status(err.status).json({ error: err.message });
  console.error(`[Payments] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
};

// POST /api/payments/order  { kind: 'course', courseId } | { kind: 'combo', comboOfferId, selectedCourseIds } | { kind: 'mcq_subject', subject }
export const createOrder = async (req, res) => {
  if (!isRazorpayConfigured()) {
    return res.status(503).json({ error: 'Online payments are not available right now. Please try again later.' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User profile not found' });
    if (isAdminEmail(user.email)) return res.status(400).json({ error: 'Admins do not need to purchase anything' });

    const item = await resolvePurchase(user, req.body || {});
    const amount = Math.round(Number(item.price) * 100);
    if (!Number.isFinite(amount) || amount < RAZORPAY_MIN_AMOUNT) {
      return res.status(400).json({ error: 'This item does not have a valid price yet. Please contact the admin.' });
    }

    const payment = new Payment({
      userId: user._id,
      userEmail: user.email,
      userName: user.fullName || user.name,
      kind: item.kind,
      itemLabel: item.itemLabel,
      courses: (item.courses || []).map((c) => c._id),
      courseIds: item.courseIds || [],
      comboOffer: item.comboOffer,
      subject: item.subject,
      amount,
      currency: 'INR'
    });

    const order = await getRazorpay().orders.create({
      amount,
      currency: 'INR',
      receipt: String(payment._id),
      notes: { paymentRecordId: String(payment._id), userEmail: user.email, item: item.itemLabel.slice(0, 250) }
    });
    payment.razorpayOrderId = order.id;
    await payment.save();

    res.json({
      keyId: razorpayKeyId(),
      orderId: order.id,
      amount,
      currency: 'INR',
      itemLabel: item.itemLabel,
      prefill: { name: user.fullName || user.name, email: user.email, contact: user.mobileNumber || '' }
    });
  } catch (err) {
    sendError(res, err, 'Could not start the payment. Please try again.');
  }
};

// POST /api/payments/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature } - straight from Checkout's success handler
export const verifyPayment = async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};

  try {
    const payment = await loadOwnPayment(req, orderId);
    if (payment.status === 'paid') {
      const settled = await settlePayment(orderId, { paymentId: payment.razorpayPaymentId, method: payment.method, via: 'verify' });
      return res.json({ status: 'paid', payment: paymentSummary(settled) });
    }

    if (typeof paymentId !== 'string' || !isValidPaymentSignature(orderId, paymentId, signature)) {
      return res.status(400).json({ error: 'Payment verification failed. If money was deducted, it will be confirmed automatically or refunded by Razorpay.' });
    }

    const rzpPayment = await getRazorpay().payments.fetch(paymentId);
    if (!(await ensureCaptured(rzpPayment, payment))) {
      // Signed but not captured yet (rare) - the webhook / status check will finish it
      return res.status(202).json({ status: 'processing' });
    }

    const settled = await settlePayment(orderId, { paymentId, method: rzpPayment.method, via: 'verify' });
    res.json({ status: 'paid', payment: paymentSummary(settled) });
  } catch (err) {
    sendError(res, err, 'Could not verify the payment. Please refresh in a minute.');
  }
};

// GET /api/payments/orders/:orderId/status - asks Razorpay whether this order has been paid
export const getPaymentStatus = async (req, res) => {
  try {
    const payment = await loadOwnPayment(req, req.params.orderId);
    if (payment.status === 'paid') {
      const settled = await settlePayment(payment.razorpayOrderId, { paymentId: payment.razorpayPaymentId, method: payment.method, via: 'status-check' });
      return res.json({ status: 'paid', payment: paymentSummary(settled) });
    }

    const { items = [] } = await getRazorpay().orders.fetchPayments(payment.razorpayOrderId);
    for (const rzpPayment of items) {
      if (await ensureCaptured(rzpPayment, payment)) {
        const settled = await settlePayment(payment.razorpayOrderId, { paymentId: rzpPayment.id, method: rzpPayment.method, via: 'status-check' });
        return res.json({ status: 'paid', payment: paymentSummary(settled) });
      }
    }

    res.json({ status: payment.status, payment: paymentSummary(payment) });
  } catch (err) {
    sendError(res, err, 'Could not check the payment status. Please try again.');
  }
};

// POST /api/payments/razorpay/webhook - called by Razorpay, not the browser. req.body is the raw Buffer
// (see paymentRoutes.js): the signature covers the exact bytes Razorpay sent.
export const razorpayWebhook = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!isValidWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    console.warn('[Payments] Webhook rejected: bad or missing signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
    const entity = event?.payload?.payment?.entity;
    const orderId = entity?.order_id || event?.payload?.order?.entity?.id;
    const payment = orderId ? await Payment.findOne({ razorpayOrderId: orderId }) : null;

    // Not one of ours (payment links, other integrations on the same account) - acknowledge and move on
    if (!payment || !entity) return res.json({ ok: true, ignored: true });

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      if (await ensureCaptured(entity, payment)) {
        await settlePayment(orderId, { paymentId: entity.id, method: entity.method, via: 'webhook' });
      } else {
        console.warn(`[Payments] Webhook ${event.event} for ${orderId} did not match the order (amount/currency/status) - not granted`);
      }
    } else if (event.event === 'payment.failed') {
      await Payment.updateOne(
        { razorpayOrderId: orderId, status: 'created' },
        { $set: { status: 'failed', failureReason: entity.error_description || entity.error_reason || 'Payment failed' } }
      );
    }

    res.json({ ok: true });
  } catch (err) {
    // A 5xx makes Razorpay retry the webhook later
    console.error('[Payments] Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// GET /api/payments/admin - every Razorpay order, newest first
export const listPaymentsAdmin = async (req, res) => {
  try {
    const payments = await Payment.find({}).sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ payments });
  } catch (err) {
    sendError(res, err, 'Could not load payments');
  }
};
