// Toppers Copy paywall: free-preview questions, per-subject + bundle purchases, masked PDF.
// Needs a MongoDB: TEST_MONGODB_URI=mongodb://... node --test --test-force-exit tests/toppersPaywall.integration.test.mjs
// (force-exit: the imported controllers leave handles open after the tests finish).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('toppers paywall integration tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ADMIN_EMAIL = 'admin@test.dev';
  process.env.R2_BUCKET_NAME = 'test-bucket';

  const { default: express } = await import('express');
  const { default: mongoose } = await import('mongoose');
  const { default: jwt } = await import('jsonwebtoken');
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { r2Client } = await import('../config/r2.js');
  const { default: routes } = await import('../routes/toppersCopyRoutes.js');
  const { default: User } = await import('../models/User.js');
  const { default: ToppersCopy } = await import('../models/ToppersCopy.js');
  const { default: ToppersPyq } = await import('../models/ToppersPyq.js');
  const { ALL_SUBJECTS } = await import('../models/ToppersCopyPricing.js');

  let server, base, admin, student, gs1, gs2;

  // A 6-page "compendium" whose page N reads "PAGE-N", served from a stubbed R2.
  const makePdf = async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 6; i++) pdf.addPage([300, 400]).drawText(`PAGE-${i}`, { x: 50, y: 200, font, size: 20 });
    return pdf.save({ useObjectStreams: false });
  };
  const pageHasText = async (bytes, n) => {
    const pdf = await PDFDocument.load(bytes);
    const page = pdf.getPage(n - 1);
    return page.node.Contents() !== undefined;
  };

  const tokenFor = (u) => jwt.sign({ userId: u._id, email: u.email }, 'test-secret');
  const call = async (method, path, user, { body, form } = {}) => {
    const headers = { Authorization: `Bearer ${tokenFor(user)}` };
    let payload;
    if (form) payload = form;
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(5000) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const buy = (plan, txn) => {
    const form = new FormData();
    form.append('plan', plan);
    form.append('upiTxnId', txn);
    form.append('screenshot', new Blob([Buffer.from('fake-png')], { type: 'image/png' }), 'pay.png');
    return call('POST', '/api/toppers-copy/purchase-requests', student, { form });
  };

  const topic = (subject, name) => ({
    subject, syllabusSection: 'S', topic: name, published: true, pdfKey: 'r2://compendium.pdf', pdfPageCount: 6,
    questions: [
      { questionText: `${name} Q1`, order: 0, answers: [{ name: 'A', startPage: 1, endPage: 2 }], aiAnalysis: { generatedAt: new Date(), keywords: ['k'] } },
      { questionText: `${name} Q2`, order: 1, answers: [{ name: 'B', startPage: 3, endPage: 4 }], aiAnalysis: { generatedAt: new Date(), keywords: ['k'] } },
    ],
  });

  before(async () => {
    // A unique db name rather than dropDatabase(), which can stall behind the models' index builds.
    await mongoose.connect(URI, { dbName: `tc_paywall_${Date.now()}` });

    const pdfBytes = await makePdf();
    // Owners get the stream piped through; the preview path reads the whole object.
    r2Client.send = async () => {
      const Body = Readable.from([Buffer.from(pdfBytes)]);
      Body.transformToByteArray = async () => pdfBytes;
      return { Body, ContentLength: pdfBytes.length };
    };

    admin = await User.create({ googleId: 'g-admin', email: 'admin@test.dev', name: 'Admin' });
    student = await User.create({ googleId: 'g-stu', email: 'stu@test.dev', name: 'Stu' });
    gs1 = await ToppersCopy.create(topic('GS-1', 'Art'));
    gs2 = await ToppersCopy.create(topic('GS-2', 'Polity'));
    await ToppersPyq.create({ subject: 'GS-1', topic: 'Art', questionText: 'Art PYQ', year: 2020, dedupeKey: 'k1',
      pyqAnswer: { openingLine: 'hi', published: true, generatedAt: new Date() } });

    const app = express();
    app.use(express.json());
    app.use('/api/toppers-copy', routes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.closeAllConnections();
    server?.close();
    await mongoose.disconnect();
  });

  test('without a purchase every question is locked: titles only, no answers or analysis', async () => {
    const { status, data } = await call('GET', `/api/toppers-copy/${gs1._id}`, student);
    assert.equal(status, 200);
    assert.equal(data.toppersCopy.owned, false);
    for (const q of data.toppersCopy.questions) {
      assert.equal(q.locked, true);
      assert.deepEqual(q.answers, []);
      assert.equal(q.aiAnalysis, null);
      assert.equal(q.answerCount, 1);
      assert.ok(q.questionText);
    }
    assert.equal(data.relatedPyqs[0].pyqAnswer, null);
    assert.equal(data.relatedPyqs[0].pyqAnswerStatus, 'locked');
    assert.equal((await call('GET', `/api/toppers-copy/${gs1._id}/pdf`, student)).status, 403);
  });

  test('an admin-marked free question opens in full, and the PDF only carries its pages', async () => {
    const qid = gs1.questions[0]._id;
    assert.equal((await call('PATCH', `/api/toppers-copy/admin/${gs1._id}/questions/${qid}/free-preview`, student, { body: { freePreview: true } })).status, 403);
    assert.equal((await call('PATCH', `/api/toppers-copy/admin/${gs1._id}/questions/${qid}/free-preview`, admin, { body: { freePreview: true } })).status, 200);

    const { data } = await call('GET', `/api/toppers-copy/${gs1._id}`, student);
    const [free, paid] = data.toppersCopy.questions;
    assert.equal(free.locked, false);
    assert.equal(free.freePreview, true);
    assert.equal(free.answers.length, 1);
    assert.ok(free.aiAnalysis);
    assert.equal(paid.locked, true);
    assert.equal(data.relatedPyqs[0].pyqAnswer?.openingLine, 'hi');

    const topics = await call('GET', '/api/toppers-copy/topics?subject=GS-1', student);
    assert.equal(topics.data.owned, false);
    assert.equal(topics.data.topics[0].freeCount, 1);

    const pdf = await call('GET', `/api/toppers-copy/${gs1._id}/pdf`, student);
    assert.equal(pdf.status, 200);
    const loaded = await PDFDocument.load(pdf.data);
    assert.equal(loaded.getPageCount(), 6);
    assert.equal(await pageHasText(pdf.data, 1), true);
    assert.equal(await pageHasText(pdf.data, 2), true);
    assert.equal(await pageHasText(pdf.data, 3), false);
    assert.equal(await pageHasText(pdf.data, 6), false);
  });

  test('a subject purchase is priced, requested, approved, and unlocks only that subject', async () => {
    assert.equal((await buy('GS-1', 'TXN-1')).status, 400); // no price yet
    assert.equal((await call('PUT', '/api/toppers-copy/admin/pricing/GS-1', admin, { body: { price: 499, discountedPrice: 299, useDiscount: true } })).status, 200);
    assert.equal((await call('PUT', `/api/toppers-copy/admin/pricing/${ALL_SUBJECTS}`, admin, { body: { price: 1499 } })).status, 200);
    assert.equal((await call('PUT', '/api/toppers-copy/admin/pricing/Nope', admin, { body: { price: 1 } })).status, 400);

    const store = await call('GET', '/api/toppers-copy/store', student);
    assert.deepEqual(store.data.plans.map((p) => p.plan), ['GS-1', 'GS-2', ALL_SUBJECTS]);

    const req = await buy('GS-1', 'TXN-1');
    assert.equal(req.status, 200);
    assert.equal(req.data.request.price, 299);
    assert.equal(req.data.request.screenshotData, undefined);
    assert.equal((await buy('GS-1', 'TXN-2')).status, 400); // already pending
    assert.equal((await buy('GS-2', 'txn-1')).status, 400); // txn id reused

    assert.equal((await call('POST', `/api/toppers-copy/admin/purchase-requests/${req.data.request._id}/approve`, student)).status, 403);
    assert.equal((await call('POST', `/api/toppers-copy/admin/purchase-requests/${req.data.request._id}/approve`, admin)).status, 200);

    const gs1Doc = await call('GET', `/api/toppers-copy/${gs1._id}`, student);
    assert.ok(gs1Doc.data.toppersCopy.questions.every((q) => !q.locked && q.answers.length === 1));
    const fullPdf = await call('GET', `/api/toppers-copy/${gs1._id}/pdf`, student);
    assert.equal(await pageHasText(fullPdf.data, 3), true);

    const gs2Doc = await call('GET', `/api/toppers-copy/${gs2._id}`, student);
    assert.ok(gs2Doc.data.toppersCopy.questions.every((q) => q.locked));
    assert.equal((await buy('GS-1', 'TXN-3')).status, 400); // already owned
  });

  test('the all-subjects bundle unlocks every subject', async () => {
    const req = await buy(ALL_SUBJECTS, 'TXN-ALL');
    assert.equal(req.status, 200);
    assert.equal(req.data.request.price, 1499);
    await call('POST', `/api/toppers-copy/admin/purchase-requests/${req.data.request._id}/approve`, admin);

    const gs2Doc = await call('GET', `/api/toppers-copy/${gs2._id}`, student);
    assert.equal(gs2Doc.data.toppersCopy.owned, true);
    assert.ok(gs2Doc.data.toppersCopy.questions.every((q) => !q.locked));
    const store = await call('GET', '/api/toppers-copy/store', student);
    assert.ok(store.data.plans.every((p) => p.owned));
  });
}
