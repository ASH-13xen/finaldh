// Razorpay payment flow: order creation, signature checks, webhook, one pending request per paid order,
// admin verify / reject, and the student's rejection notice. Razorpay's API is replaced by an in-memory
// fake, so nothing leaves the machine. Needs a MongoDB (see mcq.integration.test.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('payments integration tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ADMIN_EMAIL = 'admin@test.dev';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_fakekey';
  process.env.RAZORPAY_KEY_SECRET = 'fake-key-secret';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'fake-webhook-secret';

  const { default: express } = await import('express');
  const { default: mongoose } = await import('mongoose');
  const { default: jwt } = await import('jsonwebtoken');
  const { default: paymentRoutes } = await import('../routes/paymentRoutes.js');
  const { default: courseRoutes } = await import('../routes/courseRoutes.js');
  const { default: mcqRoutes } = await import('../routes/mcqRoutes.js');
  const { default: User } = await import('../models/User.js');
  const { default: Course } = await import('../models/Course.js');
  const { default: ComboOffer } = await import('../models/ComboOffer.js');
  const { default: McqSubjectPricing } = await import('../models/McqSubjectPricing.js');
  const { default: PurchaseRequest } = await import('../models/PurchaseRequest.js');
  const { default: McqPurchaseRequest } = await import('../models/McqPurchaseRequest.js');
  const { default: Payment } = await import('../models/Payment.js');
  const { openPeopleDb, closePeopleDb, peopleConn } = await import('../config/peopleDb.js');
  const { setRazorpayClient } = await import('../config/razorpay.js');

  // ---- fake Razorpay ----
  const rzp = { orders: new Map(), payments: new Map(), captures: [] };
  let seq = 0;
  setRazorpayClient({
    orders: {
      create: async ({ amount, currency, receipt }) => {
        const order = { id: `order_${++seq}`, amount, currency, receipt };
        rzp.orders.set(order.id, order);
        return order;
      },
      fetchPayments: async (orderId) => ({ items: [...rzp.payments.values()].filter((p) => p.order_id === orderId) })
    },
    payments: {
      fetch: async (id) => {
        const p = rzp.payments.get(id);
        if (!p) throw new Error('payment not found');
        return { ...p };
      },
      capture: async (id) => {
        rzp.captures.push(id);
        const p = rzp.payments.get(id);
        p.status = 'captured';
        return { ...p };
      }
    }
  });

  // What Razorpay would do when the student pays inside Checkout
  const payOrder = (orderId, { status = 'captured', amount, method = 'upi' } = {}) => {
    const order = rzp.orders.get(orderId);
    const payment = { id: `pay_${++seq}`, order_id: orderId, amount: amount ?? order.amount, currency: 'INR', status, method, contact: '+919811122233', email: 'payer@upi.dev' };
    rzp.payments.set(payment.id, payment);
    const signature = crypto.createHmac('sha256', 'fake-key-secret').update(`${orderId}|${payment.id}`).digest('hex');
    return { razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: signature, payment };
  };

  let server;
  let base;
  const tokens = {};
  const users = {};
  let course;
  let multiPartCourse;

  const call = async (method, path, who, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    let payload;
    if (typeof body === 'string') payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  };

  const sendWebhook = (event, { signWith = 'fake-webhook-secret' } = {}) => {
    const raw = JSON.stringify(event);
    const signature = crypto.createHmac('sha256', signWith).update(raw).digest('hex');
    return call('POST', '/api/payments/razorpay/webhook', null, raw, { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature });
  };
  const capturedEvent = (payment) => ({ event: 'payment.captured', payload: { payment: { entity: payment } } });

  const makeUser = async (key, email, extra = {}) => {
    users[key] = await User.create({ googleId: `g-${key}`, email, name: key, fullName: key, ...extra });
    tokens[key] = jwt.sign({ userId: users[key]._id, email }, 'test-secret');
  };
  const reload = (key) => User.findById(users[key]._id);

  before(async () => {
    await mongoose.connect(URI, { dbName: 'payments_integration' });
    await mongoose.connection.dropDatabase();
    await openPeopleDb(URI, { dbName: 'payments_integration_people' });
    await peopleConn.dropDatabase();
    // the unique razorpayOrderId index is what keeps concurrent confirmations to one request
    await Promise.all([PurchaseRequest.init(), McqPurchaseRequest.init(), Payment.init()]);

    course = await Course.create({ courseId: 'SOC-1', name: 'Sociology 1', subject: 'Sociology', price: 999, discountedPrice: 499, useDiscount: true, fileName: 's.pdf', fileUrl: 'x' });
    multiPartCourse = await Course.create({ courseId: 'MMF', name: 'Mains Master File', subject: 'GS', price: 1999, fileName: 'm.pdf', fileUrl: 'x', fileUrls: ['a', 'b', 'c'] });
    await Course.create({ courseId: 'GEO-1', name: 'Geography 1', subject: 'Geography', price: 300, fileName: 'g.pdf', fileUrl: 'x' });
    await McqSubjectPricing.create({ subject: 'GS-1', price: 799 });

    await makeUser('admin', 'admin@test.dev');
    await makeUser('buyer', 'buyer@test.dev', { mobileNumber: '9876543210' });
    await makeUser('other', 'other@test.dev');
    await makeUser('owner', 'owner@test.dev');
    await User.updateOne({ _id: users.owner._id }, { $set: { purchasedCourses: [course._id] } });

    const app = express();
    app.use('/api/payments', paymentRoutes);
    app.use('/api/courses', express.json(), courseRoutes);
    app.use('/api/mcq', express.json(), mcqRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await closePeopleDb();
  });

  test('the server sets the price: an order is created for the course price in paise, whatever the browser sends', async () => {
    const r = await call('POST', '/api/payments/order', 'buyer', { kind: 'course', courseId: 'SOC-1', amount: 100, price: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.amount, 49900, 'discounted price ₹499');
    assert.equal(r.data.keyId, 'rzp_test_fakekey');
    assert.equal(r.data.prefill.contact, '9876543210');
    assert.equal(rzp.orders.get(r.data.orderId).amount, 49900);
    const p = await Payment.findOne({ razorpayOrderId: r.data.orderId });
    assert.equal(p.status, 'created');
    assert.equal(String(p.userId), String(users.buyer._id));
  });

  test('orders are refused for owners, admins, unknown items and badly picked combos', async () => {
    assert.equal((await call('POST', '/api/payments/order', null, { kind: 'course', courseId: 'SOC-1' })).status, 401);
    assert.equal((await call('POST', '/api/payments/order', 'owner', { kind: 'course', courseId: 'SOC-1' })).status, 400);
    assert.equal((await call('POST', '/api/payments/order', 'admin', { kind: 'course', courseId: 'SOC-1' })).status, 400);
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'course', courseId: 'NOPE' })).status, 404);
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'bogus' })).status, 400);
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'mcq_subject', subject: 'UNPRICED' })).status, 400);

    const combo = await ComboOffer.create({ label: 'Pick 1 + MMF', eligibleCourseIds: ['SOC-1', 'GEO-1'], pickCount: 1, requiredCourseIds: ['MMF'], price: 1500 });
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'combo', comboOfferId: combo._id, selectedCourseIds: ['SOC-1', 'GEO-1'] })).status, 400, 'too many picks');
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'combo', comboOfferId: combo._id, selectedCourseIds: ['MMF'] })).status, 400, 'not eligible');
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'combo', comboOfferId: 'not-an-id', selectedCourseIds: ['SOC-1'] })).status, 404);
    assert.equal((await call('POST', '/api/payments/order', 'owner', { kind: 'combo', comboOfferId: combo._id, selectedCourseIds: ['SOC-1'] })).status, 400, 'already owns a course in it');
  });

  const verifyAs = (who, kind, id) => call('POST', `/api/${kind === 'mcq' ? 'mcq' : 'courses'}/admin/purchase-requests/${id}/approve`, who);
  const rejectAs = (who, kind, id) => call('POST', `/api/${kind === 'mcq' ? 'mcq' : 'courses'}/admin/purchase-requests/${id}/reject`, who);

  test('a genuine payment creates ONE pending request for the admin and unlocks nothing until it is verified', async () => {
    const order = await call('POST', '/api/payments/order', 'buyer', { kind: 'course', courseId: 'SOC-1' });
    const paid = payOrder(order.data.orderId);

    const forged = await call('POST', '/api/payments/verify', 'buyer', { ...paid, razorpay_signature: 'f'.repeat(64) });
    assert.equal(forged.status, 400);
    assert.equal(await PurchaseRequest.countDocuments({ userId: users.buyer._id }), 0, 'a forged signature creates no request');

    const stranger = await call('POST', '/api/payments/verify', 'other', paid);
    assert.equal(stranger.status, 404, "someone else's order cannot be verified");

    const ok = await call('POST', '/api/payments/verify', 'buyer', paid);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.status, 'paid');
    assert.equal(ok.data.request.status, 'pending');
    assert.equal(ok.data.request.telegramNotificationCount, 0);

    const req = await PurchaseRequest.findById(ok.data.request._id);
    assert.equal(req.paymentMethod, 'razorpay');
    assert.equal(req.courseId, 'SOC-1');
    assert.equal(req.courseName, 'Sociology 1');
    assert.equal(req.price, 499);
    assert.equal(req.razorpayPaymentId, paid.razorpay_payment_id);
    assert.equal(req.payerContact, '+919811122233', 'the phone typed into Checkout reaches the admin');
    assert.equal(req.payerEmail, 'payer@upi.dev');
    assert.equal(req.screenshotUrl, undefined);

    assert.equal((await reload('buyer')).purchasedCourses.length, 0, 'paid but not yet verified: no access');
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'course', courseId: 'SOC-1' })).status, 400, 'cannot pay again while waiting for verification');

    // the student sees it as pending in the usual list, and can ping the admin on Telegram (max twice)
    const mine = await call('GET', '/api/courses/purchase-requests', 'buyer');
    assert.equal(mine.data.find((r) => r._id === String(req._id)).status, 'pending');
    assert.equal((await call('POST', `/api/courses/purchase-requests/${req._id}/notify-telegram`, 'buyer')).status, 200);

    const verified = await verifyAs('admin', 'course', req._id);
    assert.equal(verified.status, 200);
    const u = await reload('buyer');
    assert.deepEqual(u.purchasedCourses.map(String), [String(course._id)]);
    assert.deepEqual(u.downloadLimits.map((d) => [d.courseId, d.allowedCount]), [['SOC-1', 1]]);
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'course', courseId: 'SOC-1' })).status, 400, 'owned now');
  });

  test('verify, webhook and status check arriving together create exactly one request', async () => {
    const order = await call('POST', '/api/payments/order', 'buyer', { kind: 'course', courseId: 'MMF' });
    const paid = payOrder(order.data.orderId);

    const results = await Promise.all([
      call('POST', '/api/payments/verify', 'buyer', paid),
      sendWebhook(capturedEvent(paid.payment)),
      sendWebhook(capturedEvent(paid.payment)),
      call('GET', `/api/payments/orders/${order.data.orderId}/status`, 'buyer')
    ]);
    results.forEach((r) => assert.equal(r.status, 200));

    const reqs = await PurchaseRequest.find({ razorpayOrderId: order.data.orderId });
    assert.equal(reqs.length, 1);
    const p = await Payment.findOne({ razorpayOrderId: order.data.orderId });
    assert.equal(String(p.purchaseRequestId), String(reqs[0]._id));

    await verifyAs('admin', 'course', reqs[0]._id);
    const mmfLimits = (await reload('buyer')).downloadLimits.filter((d) => d.courseId.startsWith('MMF_')).map((d) => d.courseId).sort();
    assert.deepEqual(mmfLimits, ['MMF_0', 'MMF_1', 'MMF_2'], 'one limit per PDF part, no duplicates');
  });

  test('webhook: bad signatures are rejected; a captured payment reaches the admin even if the browser never verified', async () => {
    const order = await call('POST', '/api/payments/order', 'other', { kind: 'course', courseId: 'GEO-1' });
    const { payment } = payOrder(order.data.orderId);

    assert.equal((await sendWebhook(capturedEvent(payment), { signWith: 'wrong-secret' })).status, 400);
    assert.equal(await PurchaseRequest.countDocuments({ razorpayOrderId: order.data.orderId }), 0);

    const failed = await sendWebhook({ event: 'payment.failed', payload: { payment: { entity: { ...payment, status: 'failed', error_description: 'Bank declined' } } } });
    assert.equal(failed.status, 200);
    assert.equal((await Payment.findOne({ razorpayOrderId: order.data.orderId })).status, 'failed');

    // The student retried inside Checkout and the retry went through
    assert.equal((await sendWebhook(capturedEvent(payment))).status, 200);
    const p = await Payment.findOne({ razorpayOrderId: order.data.orderId });
    assert.equal(p.status, 'paid');
    assert.equal(p.confirmedVia, 'webhook');
    assert.equal(p.failureReason, undefined);
    const req = await PurchaseRequest.findOne({ razorpayOrderId: order.data.orderId });
    assert.equal(req.status, 'pending');
    assert.equal(req.payerContact, '+919811122233');
    assert.equal((await reload('other')).purchasedCourses.length, 0);

    assert.equal((await sendWebhook(capturedEvent({ ...payment, order_id: 'order_not_ours' }))).status, 200, 'unknown orders are acknowledged and ignored');
  });

  test('reject: no access, and the student gets a refund notice until they acknowledge it', async () => {
    const req = await PurchaseRequest.findOne({ userId: users.other._id, courseId: 'GEO-1', status: 'pending' });
    // an old UPI rejection must not suddenly produce a refund notice
    await PurchaseRequest.create({
      userId: users.other._id, userEmail: 'other@test.dev', userName: 'other', courseObjectId: course._id, courseId: 'SOC-1',
      courseName: 'Sociology 1', price: 499, courses: [course._id], screenshotUrl: '/x', status: 'rejected'
    });

    assert.equal((await rejectAs('other', 'course', req._id)).status, 403, 'students cannot reject');
    assert.equal((await rejectAs('admin', 'course', req._id)).status, 200);
    assert.equal((await reload('other')).purchasedCourses.length, 0);
    assert.ok((await PurchaseRequest.findById(req._id)).rejectedAt);

    const notices = await call('GET', '/api/payments/rejections', 'other');
    assert.equal(notices.status, 200);
    assert.equal(notices.data.rejections.length, 1);
    const [n] = notices.data.rejections;
    assert.equal(n.kind, 'course');
    assert.equal(n.itemLabel, 'Geography 1');
    assert.equal(n.amount, 300);
    assert.ok(n.paidAt);
    assert.equal((await call('GET', '/api/payments/rejections', 'buyer')).data.rejections.length, 0, 'only your own notices');

    assert.equal((await call('POST', `/api/payments/rejections/course/${n.id}/acknowledge`, 'buyer')).status, 404, "cannot dismiss someone else's notice");
    assert.equal((await call('POST', `/api/payments/rejections/bogus/${n.id}/acknowledge`, 'other')).status, 400);
    assert.equal((await call('POST', `/api/payments/rejections/course/not-an-id/acknowledge`, 'other')).status, 404);
    assert.equal((await call('POST', `/api/payments/rejections/course/${n.id}/acknowledge`, 'other')).status, 200);
    assert.equal((await call('GET', '/api/payments/rejections', 'other')).data.rejections.length, 0, 'gone once acknowledged');

    assert.equal((await call('POST', '/api/payments/order', 'other', { kind: 'course', courseId: 'GEO-1' })).status, 200, 'after a rejection they may buy again');
  });

  test('a payment for the wrong amount never reaches the admin', async () => {
    const order = await call('POST', '/api/payments/order', 'buyer', { kind: 'mcq_subject', subject: 'GS-1' });
    const short = payOrder(order.data.orderId, { amount: 100 });
    const r = await call('POST', '/api/payments/verify', 'buyer', short);
    assert.equal(r.status, 202);
    assert.equal((await sendWebhook(capturedEvent(short.payment))).status, 200);
    assert.equal(await McqPurchaseRequest.countDocuments({ razorpayOrderId: order.data.orderId }), 0);
    assert.equal((await Payment.findOne({ razorpayOrderId: order.data.orderId })).status, 'created');
  });

  test('MCQ subject: an authorized-only payment is captured, waits for the admin, then the whole subject unlocks', async () => {
    const order = await call('POST', '/api/payments/order', 'buyer', { kind: 'mcq_subject', subject: 'GS-1' });
    assert.equal(order.data.amount, 79900);
    const paid = payOrder(order.data.orderId, { status: 'authorized' });

    // The browser lost the success callback; the status check finds and captures the payment
    const status = await call('GET', `/api/payments/orders/${order.data.orderId}/status`, 'buyer');
    assert.equal(status.status, 200);
    assert.equal(status.data.status, 'paid');
    assert.ok(rzp.captures.includes(paid.payment.id), 'payment was captured');

    const req = await McqPurchaseRequest.findById(status.data.request._id);
    assert.equal(req.purchaseType, 'subject');
    assert.equal(req.subject, 'GS-1');
    assert.equal(req.price, 799);
    assert.equal(req.paymentMethod, 'razorpay');
    assert.deepEqual((await reload('buyer')).purchasedMcqSubjects, [], 'not before the admin verifies');
    assert.equal((await call('POST', '/api/payments/order', 'buyer', { kind: 'mcq_subject', subject: 'GS-1' })).status, 400, 'no second payment while pending');

    assert.equal((await call('POST', `/api/mcq/purchase-requests/${req._id}/notify-telegram`, 'buyer')).status, 200);
    assert.equal((await verifyAs('admin', 'mcq', req._id)).status, 200);
    assert.deepEqual((await reload('buyer')).purchasedMcqSubjects, ['GS-1']);
  });

  test('a student whose earlier UPI payment is still being verified cannot pay twice for it', async () => {
    await PurchaseRequest.create({
      userId: users.other._id, userEmail: 'other@test.dev', userName: 'other', courseObjectId: course._id, courseId: 'SOC-1',
      courseName: 'Sociology 1', price: 499, courses: [course._id], screenshotUrl: '/x', status: 'pending'
    });
    assert.equal((await call('POST', '/api/payments/order', 'other', { kind: 'course', courseId: 'SOC-1' })).status, 400);
  });

  test('admin approval of a legacy UPI request still grants the course through the shared grant code', async () => {
    const pending = await PurchaseRequest.findOne({ userId: users.other._id, courseId: 'SOC-1', status: 'pending' });
    assert.equal((await verifyAs('other', 'course', pending._id)).status, 403);
    const r = await verifyAs('admin', 'course', pending._id);
    assert.equal(r.status, 200);
    const u = await reload('other');
    assert.ok(u.purchasedCourses.some((id) => String(id) === String(course._id)));
    assert.ok(u.interestedCourses.includes('SOC-1'));
    assert.equal(u.downloadLimits.filter((d) => d.courseId === 'SOC-1').length, 1);
    assert.equal((await call('POST', '/api/courses/purchase-request', 'other', {})).status, 404, 'students can no longer submit UPI screenshots');
  });

  test('only admins can list payments, which carry the verification status of their request', async () => {
    assert.equal((await call('GET', '/api/payments/admin', 'buyer')).status, 403);
    const r = await call('GET', '/api/payments/admin', 'admin');
    assert.equal(r.status, 200);
    const byStatus = (s) => r.data.payments.filter((p) => p.verificationStatus === s).length;
    assert.ok(byStatus('approved') >= 3, 'SOC-1, MMF and GS-1 were verified');
    assert.ok(byStatus('rejected') >= 1, 'GEO-1 was rejected');
    assert.ok(r.data.payments.some((p) => p.status === 'created' && p.verificationStatus === null), 'unpaid orders have no request');
  });
}
