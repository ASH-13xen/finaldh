import Payment from '../models/Payment.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import ComboOffer from '../models/ComboOffer.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';
import PurchaseRequest from '../models/PurchaseRequest.js';
import McqPurchaseRequest from '../models/McqPurchaseRequest.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { userHasCourseAccess } from '../utils/courseAccess.js';
import { withAccessGroups } from '../utils/purchaseFulfillment.js';
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
//   3. POST /verify  - the browser sends back Razorpay's signed result; we check the signature and confirm
//                      the payment with Razorpay.
//   Safety nets for when step 3 never arrives (tab closed, network drop):
//   - POST /razorpay/webhook - Razorpay tells us server-to-server.
//   - GET /orders/:orderId/status - asks Razorpay directly (also what makes local testing work, where
//                      webhooks can't reach localhost).
// All three paths end in settlePayment(), which hands the paid order to the admin as exactly one pending
// purchase request. Access is granted only when the admin presses Verify (purchaseController.js /
// mcqPurchaseController.js); on Reject the student is shown a refund notice (see listMyRejections).

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

    // A pending payment for this course - or for any course linked to it by a Shared access ID, which
    // would unlock this one too once verified - means paying again would be paying twice
    const covered = (await withAccessGroups([course])).map((c) => c._id);
    const pending = await PurchaseRequest.exists({
      userId: user._id,
      status: 'pending',
      $or: [{ courseId: course.courseId }, { courses: { $in: covered } }, { courseObjectId: { $in: covered } }]
    });
    if (pending) throw new PurchaseError(400, 'You already have a payment covering this course waiting for verification');

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

    const pending = await PurchaseRequest.exists({ userId: user._id, comboOffer: comboOffer._id, status: 'pending' });
    if (pending) throw new PurchaseError(400, 'You already have a payment for this combo waiting for verification');

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

    const pending = await McqPurchaseRequest.exists({ userId: user._id, purchaseType: 'subject', subject, status: 'pending' });
    if (pending) throw new PurchaseError(400, 'You already have a payment for this subject waiting for verification');

    return { kind, itemLabel: `MCQ Test Series — ${subject} (all tests)`, price: effectivePrice(pricing), subject };
  }

  throw new PurchaseError(400, 'Unknown purchase type');
}

const requestModelFor = (payment) => (payment.kind === 'mcq_subject' ? McqPurchaseRequest : PurchaseRequest);

// The pending purchase request the admin verifies, shaped exactly like the requests the old UPI flow
// created, so the admin screens and the student's "Pending Verification" states work unchanged. Upserted on
// the order id (unique), so concurrent confirmations still produce a single request.
async function createVerificationRequest(payment) {
  const common = {
    userId: payment.userId,
    userEmail: payment.userEmail,
    userName: payment.userName,
    price: payment.amount / 100,
    paymentMethod: 'razorpay',
    razorpayOrderId: payment.razorpayOrderId,
    razorpayPaymentId: payment.razorpayPaymentId,
    payerContact: payment.payerContact,
    payerEmail: payment.payerEmail,
    payerMethod: payment.method,
    status: 'pending'
  };
  const fields = payment.kind === 'mcq_subject'
    ? { ...common, purchaseType: 'subject', subject: payment.subject }
    : {
        ...common,
        courseObjectId: payment.courses[0],
        courseId: payment.courseIds.join(','),
        courseName: payment.itemLabel,
        courses: payment.courses,
        comboOffer: payment.comboOffer
      };

  const Model = requestModelFor(payment);
  try {
    return await Model.findOneAndUpdate(
      { razorpayOrderId: payment.razorpayOrderId },
      { $setOnInsert: fields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // Two upserts raced and the unique index kept the second one out - the request exists, use it
    if (err?.code === 11000) return Model.findOne({ razorpayOrderId: payment.razorpayOrderId });
    throw err;
  }
}

// Marks the order paid (first caller wins) and makes sure it has been handed to the admin as a pending
// request. Safe to call any number of times from any of the three confirmation paths.
async function settlePayment(orderId, { paymentId, method, contact, email, via }) {
  await Payment.updateOne(
    { razorpayOrderId: orderId, status: { $ne: 'paid' } },
    {
      $set: { status: 'paid', razorpayPaymentId: paymentId, method, payerContact: contact, payerEmail: email, paidAt: new Date(), confirmedVia: via },
      $unset: { failureReason: 1 }
    }
  );
  const payment = await Payment.findOne({ razorpayOrderId: orderId });
  if (payment && !payment.fulfilledAt) {
    const request = await createVerificationRequest(payment);
    payment.purchaseRequestId = request._id;
    payment.fulfilledAt = new Date();
    await payment.save();
    console.log(`[Payments] ${payment.razorpayOrderId} paid via ${via}: "${payment.itemLabel}" for ${payment.userEmail} is waiting for admin verification`);
  }
  return payment;
}

// Settles from a Razorpay payment entity (API response or webhook payload)
const settleFromEntity = (orderId, entity, via) =>
  settlePayment(orderId, { paymentId: entity.id, method: entity.method, contact: entity.contact, email: entity.email, via });

// Re-runs settle for an order already marked paid (repairs a missed hand-off), using what was stored
const resettle = (payment, via) =>
  settlePayment(payment.razorpayOrderId, {
    paymentId: payment.razorpayPaymentId, method: payment.method, contact: payment.payerContact, email: payment.payerEmail, via
  });

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

// Response for a paid order: the payment plus the pending request it created (the browser needs the
// request id for "Notify Admin on Telegram", which is tracked per request)
const paidResponse = async (payment) => {
  const request = payment.purchaseRequestId
    ? await requestModelFor(payment).findById(payment.purchaseRequestId).select('status telegramNotificationCount')
    : null;
  return {
    status: 'paid',
    payment: paymentSummary(payment),
    request: request ? { _id: request._id, status: request.status, telegramNotificationCount: request.telegramNotificationCount } : null
  };
};

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
      return res.json(await paidResponse(await resettle(payment, 'verify')));
    }

    if (typeof paymentId !== 'string' || !isValidPaymentSignature(orderId, paymentId, signature)) {
      return res.status(400).json({ error: 'Payment verification failed. If money was deducted, it will be confirmed automatically or refunded by Razorpay.' });
    }

    const rzpPayment = await getRazorpay().payments.fetch(paymentId);
    if (!(await ensureCaptured(rzpPayment, payment))) {
      // Signed but not captured yet (rare) - the webhook / status check will finish it
      return res.status(202).json({ status: 'processing' });
    }

    res.json(await paidResponse(await settleFromEntity(orderId, rzpPayment, 'verify')));
  } catch (err) {
    sendError(res, err, 'Could not verify the payment. Please refresh in a minute.');
  }
};

// GET /api/payments/orders/:orderId/status - asks Razorpay whether this order has been paid
export const getPaymentStatus = async (req, res) => {
  try {
    const payment = await loadOwnPayment(req, req.params.orderId);
    if (payment.status === 'paid') {
      return res.json(await paidResponse(await resettle(payment, 'status-check')));
    }

    const { items = [] } = await getRazorpay().orders.fetchPayments(payment.razorpayOrderId);
    for (const rzpPayment of items) {
      if (await ensureCaptured(rzpPayment, payment)) {
        return res.json(await paidResponse(await settleFromEntity(payment.razorpayOrderId, rzpPayment, 'status-check')));
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
        await settleFromEntity(orderId, entity, 'webhook');
      } else {
        console.warn(`[Payments] Webhook ${event.event} for ${orderId} did not match the order (amount/currency/status) - ignored`);
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

// GET /api/payments/admin - every Razorpay order, newest first, with the admin's verification status
// ('pending' / 'approved' / 'rejected') of the purchase request each paid order created
export const listPaymentsAdmin = async (req, res) => {
  try {
    const payments = await Payment.find({}).sort({ createdAt: -1 }).limit(1000).lean();

    const idsFor = (isMcq) => payments
      .filter((p) => p.purchaseRequestId && (p.kind === 'mcq_subject') === isMcq)
      .map((p) => p.purchaseRequestId);
    const [courseReqs, mcqReqs] = await Promise.all([
      PurchaseRequest.find({ _id: { $in: idsFor(false) } }).select('status').lean(),
      McqPurchaseRequest.find({ _id: { $in: idsFor(true) } }).select('status').lean()
    ]);
    const statusById = new Map([...courseReqs, ...mcqReqs].map((r) => [String(r._id), r.status]));

    res.json({
      payments: payments.map((p) => ({
        ...p,
        verificationStatus: p.purchaseRequestId ? statusById.get(String(p.purchaseRequestId)) || null : null
      }))
    });
  } catch (err) {
    sendError(res, err, 'Could not load payments');
  }
};

// Razorpay payments the admin rejected that the student hasn't acknowledged yet. The site shows each as a
// full-screen refund notice until the student presses "I understand". Legacy UPI rejections are left out:
// they predate this notice and were handled by hand.
const REJECTION_KINDS = { course: PurchaseRequest, mcq: McqPurchaseRequest };

// GET /api/payments/rejections
export const listMyRejections = async (req, res) => {
  try {
    const filter = { userId: req.userId, paymentMethod: 'razorpay', status: 'rejected', rejectionAcknowledgedAt: null };
    const [courseReqs, mcqReqs] = await Promise.all([
      PurchaseRequest.find(filter).select('courseName price createdAt rejectedAt').lean(),
      McqPurchaseRequest.find(filter).select('subject price createdAt rejectedAt').lean()
    ]);
    const rejections = [
      ...courseReqs.map((r) => ({ kind: 'course', id: r._id, itemLabel: r.courseName, amount: r.price, paidAt: r.createdAt, rejectedAt: r.rejectedAt })),
      ...mcqReqs.map((r) => ({ kind: 'mcq', id: r._id, itemLabel: `MCQ Test Series — ${r.subject}`, amount: r.price, paidAt: r.createdAt, rejectedAt: r.rejectedAt }))
    ].sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));
    res.json({ rejections });
  } catch (err) {
    sendError(res, err, 'Could not load payment notices');
  }
};

// POST /api/payments/rejections/:kind/:id/acknowledge
export const acknowledgeRejection = async (req, res) => {
  const Model = REJECTION_KINDS[req.params.kind];
  if (!Model) return res.status(400).json({ error: 'Unknown request type' });
  try {
    const result = await Model.updateOne(
      { _id: req.params.id, userId: req.userId, status: 'rejected' },
      { $set: { rejectionAcknowledgedAt: new Date() } }
    ).catch(() => null);
    if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Notice not found' });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Could not update the notice');
  }
};
