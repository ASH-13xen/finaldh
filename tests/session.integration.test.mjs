// Single-active-session rules (utils/session.js + authMiddleware). Needs a MongoDB (see mcq.integration.test.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('session integration tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ADMIN_EMAIL = 'admin@test.dev';

  const { default: express } = await import('express');
  const { default: mongoose } = await import('mongoose');
  const { default: jwt } = await import('jsonwebtoken');
  const { default: authRoutes } = await import('../routes/authRoutes.js');
  const { completeLogin } = await import('../controllers/authController.js');
  const { default: userRoutes } = await import('../routes/userRoutes.js');
  const { default: User } = await import('../models/User.js');
  const { openPeopleDb, closePeopleDb, peopleConn } = await import('../config/peopleDb.js');

  let server;
  let base;
  const HOUR = 60 * 60 * 1000;

  const call = async (method, path, { token, body, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/128' } = {}) => {
    const headers = { 'User-Agent': ua };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  };
  const login = (email, deviceId, ua) => call('POST', '/test-login', { body: { email, deviceId }, ua });
  const profile = (token) => call('GET', '/api/user/profile', { token });
  // Pretend the account was last active `ms` ago.
  const age = (email, ms) => User.updateOne({ email }, { $set: { 'session.lastSeenAt': new Date(Date.now() - ms) } });

  before(async () => {
    await mongoose.connect(URI, { dbName: 'session_integration' });
    await mongoose.connection.dropDatabase();
    await openPeopleDb(URI, { dbName: 'session_integration_people' });
    await peopleConn.dropDatabase();

    const app = express();
    app.use(express.json());
    // Stand-in for the Google step: find-or-create the user, then the real session/token logic.
    app.post('/test-login', async (req, res) => {
      const { email } = req.body;
      const user = await User.findOne({ email }) || await User.create({ googleId: `g-${email}`, email, name: email, fullName: email });
      await completeLogin(req, res, user);
    });
    app.use('/api/auth', authRoutes);
    app.use('/api/user', userRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await mongoose.connection.dropDatabase();
    await peopleConn.dropDatabase();
    await mongoose.disconnect();
    await closePeopleDb();
  });

  test('a second device is refused while the first is active; the same device can sign back in', async () => {
    const laptop = await login('stu1@test.dev', 'laptop-0001');
    assert.equal(laptop.status, 200);
    assert.equal((await profile(laptop.data.token)).status, 200);

    const phone = await login('stu1@test.dev', 'phone-00001', 'Mozilla/5.0 (iPhone) Safari/604.1');
    assert.equal(phone.status, 409);
    assert.equal(phone.data.code, 'SESSION_ACTIVE');
    assert.equal(phone.data.device, 'Chrome on Windows');
    assert.equal(phone.data.loggedOut, false);

    const again = await login('stu1@test.dev', 'laptop-0001');
    assert.equal(again.status, 200);
    const old = await profile(laptop.data.token);
    assert.equal(old.status, 401);
    assert.equal(old.data.code, 'SESSION_REPLACED');
    assert.equal((await profile(again.data.token)).status, 200);
  });

  test('logging out ends the token but still locks other devices out for an hour', async () => {
    const { data } = await login('stu2@test.dev', 'laptop-0002');
    assert.equal((await call('POST', '/api/auth/logout', { token: data.token })).status, 200);

    const after = await profile(data.token);
    assert.equal(after.status, 401);
    assert.equal(after.data.code, 'SESSION_INVALID');

    const phone = await login('stu2@test.dev', 'phone-00002');
    assert.equal(phone.status, 409);
    assert.equal(phone.data.loggedOut, true);

    await age('stu2@test.dev', HOUR + 60 * 1000);
    assert.equal((await login('stu2@test.dev', 'phone-00002')).status, 200);
  });

  test('an hour without activity signs the session out and frees the account', async () => {
    const { data } = await login('stu3@test.dev', 'laptop-0003');
    await age('stu3@test.dev', HOUR + 60 * 1000);
    const idle = await profile(data.token);
    assert.equal(idle.status, 401);
    assert.equal(idle.data.code, 'SESSION_EXPIRED');
    assert.equal((await login('stu3@test.dev', 'phone-00003')).status, 200);
  });

  test('activity keeps the session alive (lastSeenAt moves forward)', async () => {
    const { data } = await login('stu4@test.dev', 'laptop-0004');
    await age('stu4@test.dev', 50 * 60 * 1000);
    assert.equal((await call('GET', '/api/auth/session', { token: data.token })).status, 200);
    const user = await User.findOne({ email: 'stu4@test.dev' }).lean();
    assert.ok(Date.now() - user.session.lastSeenAt.getTime() < 60 * 1000);
  });

  test('tokens without a session id (issued before this change) are refused', async () => {
    const user = await User.findOne({ email: 'stu4@test.dev' });
    const legacy = jwt.sign({ userId: user._id, email: user.email }, 'test-secret');
    const res = await profile(legacy);
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'SESSION_INVALID');
  });

  test('clients that send no deviceId count as a new device every time', async () => {
    assert.equal((await login('stu5@test.dev')).status, 200);
    assert.equal((await login('stu5@test.dev')).status, 409);
  });

  test('admins can sign in on several devices at once', async () => {
    const a = await login('admin@test.dev', 'admin-laptop');
    const b = await login('admin@test.dev', 'admin-phone1');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await profile(a.data.token)).status, 200);
    assert.equal((await profile(b.data.token)).status, 200);
  });
}
