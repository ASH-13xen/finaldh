// Integration tests for the MCQ backend. They need a MongoDB, so they only run when TEST_MONGODB_URI is
// set (never point it at real data - the suite creates and wipes its own collections):
//
//   TEST_MONGODB_URI=mongodb://127.0.0.1:27017/mcq_test node --test tests/
//
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('MCQ integration tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ADMIN_EMAIL = 'admin@test.dev';

  const { default: express } = await import('express');
  const { default: mongoose } = await import('mongoose');
  const { default: jwt } = await import('jsonwebtoken');
  const { default: mcqRoutes } = await import('../routes/mcqRoutes.js');
  const { default: User } = await import('../models/User.js');
  const { default: McqTest } = await import('../models/McqTest.js');
  const { default: McqQuestion } = await import('../models/McqQuestion.js');
  const { default: McqAttempt } = await import('../models/McqAttempt.js');
  const { default: McqAttemptQuota } = await import('../models/McqAttemptQuota.js');
  const { default: McqFlag } = await import('../models/McqFlag.js');
  const { default: McqReport } = await import('../models/McqReport.js');
  const { default: Message } = await import('../models/Message.js');
  const { sweepExpiredAttempts } = await import('../utils/mcqAttempts.js');
  const { applyScoring } = await import('../utils/mcqScoring.js');
  const { openPeopleDb, closePeopleDb, peopleConn } = await import('../config/peopleDb.js');

  let server;
  let base;
  const tokens = {};
  const users = {};
  let mcqTest;
  let questions;

  const api = async (method, path, who, body, raw) => {
    const headers = { Authorization: `Bearer ${tokens[who]}` };
    let payload;
    if (raw) payload = raw;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${base}/api/mcq${path}`, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  };

  const makeUser = async (key, email) => {
    users[key] = await User.create({ googleId: `g-${key}`, email, name: key, fullName: key });
    tokens[key] = jwt.sign({ userId: users[key]._id, email }, 'test-secret');
  };

  // 5 questions, correct answers A B C D A, 2 marks each, 0.33 negative ratio => -0.66 per wrong answer
  const seedTest = async (title = 'Test One') => {
    const t = await McqTest.create({ title, subject: 'GS-1', durationMinutes: 30, isPublished: true, requiresPurchase: false, marksPerQuestion: 2, negativeMarkingRatio: 0.33 });
    const answers = ['A', 'B', 'C', 'D', 'A'];
    const qs = [];
    for (let i = 0; i < 5; i++) {
      qs.push(await McqQuestion.create({
        test: t._id, order: i + 1, questionText: `Question ${i + 1}?`,
        options: ['A', 'B', 'C', 'D'].map(l => ({ label: l, text: `Option ${l} of Q${i + 1}` })),
        correctOption: answers[i], explanation: `Because ${answers[i]} is right for Q${i + 1}.`
      }));
    }
    t.questionCount = 5; t.totalMarks = 10; await t.save();
    return { t, qs };
  };

  before(async () => {
    // Each test file gets its own database so files can run in parallel without wiping each other.
    await mongoose.connect(URI, { dbName: 'mcq_integration' });
    await mongoose.connection.dropDatabase();
    // Users live in a second database (a separate cluster in production), so the tests use two as well.
    await openPeopleDb(URI, { dbName: 'mcq_integration_people' });
    await peopleConn.dropDatabase();
    await Promise.all([McqAttempt, McqAttemptQuota, McqFlag, McqReport, McqQuestion, McqTest, User, Message].map(m => m.init()));

    await makeUser('admin', 'admin@test.dev');
    for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) await makeUser(s, `${s}@test.dev`);
    ({ t: mcqTest, qs: questions } = await seedTest());

    const app = express();
    app.use(express.json());
    app.use('/api/mcq', mcqRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await closePeopleDb();
  });

  const start = (who, mode = 'test', extra = {}) => api('POST', `/tests/${mcqTest._id}/start`, who, { mode, ...extra });
  const answer = (who, attemptId, order, option, extra = {}) =>
    api('PATCH', `/attempts/${attemptId}/responses/${order}`, who, { selectedOption: option, status: 'answered', ...extra });

  test('scoring: correct = +marks, wrong = -negative, skipped = 0', () => {
    const attempt = { responses: [
      { selectedOption: 'A', correctOption: 'A', maxMarks: 2, negativeMarks: 0.66, timeSpentSeconds: 10, status: 'answered' },
      { selectedOption: 'B', correctOption: 'C', maxMarks: 2, negativeMarks: 0.66, timeSpentSeconds: 5, status: 'marked-for-review' },
      { selectedOption: null, correctOption: 'D', maxMarks: 2, negativeMarks: 0.66, timeSpentSeconds: 1, status: 'not-answered' }
    ] };
    applyScoring(attempt);
    assert.equal(attempt.totalMarksObtained, 1.34);
    assert.equal(attempt.totalMaxMarks, 6);
    assert.deepEqual([attempt.totalCorrect, attempt.totalWrong, attempt.totalUnattempted, attempt.totalMarked], [1, 1, 1, 1]);
    assert.equal(attempt.accuracyPercent, 50);
    assert.equal(attempt.totalTimeSpentSeconds, 16);
  });

  test('Test mode: timed, and the payload never contains answers or explanations', async () => {
    const r = await start('s1', 'test');
    assert.equal(r.status, 200);
    assert.equal(r.data.mode, 'test');
    assert.ok(r.data.serverDeadline, 'test mode has a server deadline');
    assert.ok(r.data.serverNow, 'server clock is sent so the timer cannot be skewed by a wrong device clock');
    assert.equal(r.data.questions.length, 5);
    const text = JSON.stringify(r.data);
    assert.ok(!text.includes('correctOption'), 'no correctOption in a live test-mode payload');
    assert.ok(!text.includes('Because'), 'no explanation in a live test-mode payload');
    assert.equal(r.data.attempts.max, 2);
    assert.equal(r.data.attempts.used, 1);
  });

  test('Test mode can never reveal an answer', async () => {
    const attempt = await McqAttempt.findOne({ user: users.s1._id });
    const r = await api('POST', `/attempts/${attempt._id}/responses/1/reveal`, 's1', { selectedOption: 'A' });
    assert.equal(r.status, 403);
    assert.ok(!JSON.stringify(r.data).includes('"correctOption"'));
  });

  test('starting again while an attempt is unfinished resumes it and does not use another attempt', async () => {
    const first = await McqAttempt.findOne({ user: users.s1._id });
    const again = await start('s1', 'test');
    assert.equal(again.data.resumed, true);
    assert.equal(String(again.data.attemptId), String(first._id));
    assert.equal(again.data.attempts.used, 1);
    // ...even if they ask for the other mode
    const other = await start('s1', 'practice');
    assert.equal(String(other.data.attemptId), String(first._id));
  });

  test('attempt limit is 2, Test and Practice combined - and results stay viewable after', async () => {
    const first = await McqAttempt.findOne({ user: users.s1._id });
    await answer('s1', first._id, 1, 'A');            // correct
    await answer('s1', first._id, 2, 'C');            // wrong (correct is B)
    const submit = await api('POST', `/attempts/${first._id}/submit`, 's1', {});
    assert.equal(submit.status, 200);

    const practice = await start('s1', 'practice');   // attempt #2 (practice)
    assert.equal(practice.status, 200);
    assert.equal(practice.data.mode, 'practice');
    assert.equal(practice.data.serverDeadline, null, 'practice has no deadline');
    assert.equal(practice.data.attempts.used, 2);
    await api('POST', `/attempts/${practice.data.attemptId}/submit`, 's1', {});

    const third = await start('s1', 'test');
    assert.equal(third.status, 403);
    assert.equal(third.data.code, 'ATTEMPT_LIMIT');
    const third2 = await start('s1', 'practice');
    assert.equal(third2.status, 403);

    const result = await api('GET', `/attempts/${first._id}/result`, 's1');
    assert.equal(result.status, 200);
    assert.equal(result.data.summary.totalMarksObtained, 1.34);
    assert.equal(result.data.questionReview[0].correctOption, 'A');
    assert.ok(result.data.questionReview[0].explanation.includes('Because'), 'review shows explanations');

    // the test list reflects it
    const list = await api('GET', `/tests?subject=GS-1`, 's1');
    const card = list.data.tests.find(t => String(t._id) === String(mcqTest._id));
    assert.deepEqual([card.attempts.used, card.attempts.remaining], [2, 0]);
    assert.equal(card.history.length, 2);
  });

  test('admin can grant an extra attempt', async () => {
    const g = await api('POST', '/admin/quota', 'admin', { email: 's1@test.dev', testId: String(mcqTest._id), action: 'grant', amount: 1 });
    assert.equal(g.status, 200);
    assert.equal(g.data.attempts.remaining, 1);
    const denied = await api('POST', '/admin/quota', 's2', { email: 's1@test.dev', testId: String(mcqTest._id), action: 'grant' });
    assert.equal(denied.status, 403, 'students cannot grant attempts');
    const ok = await start('s1', 'practice');
    assert.equal(ok.status, 200);
    await api('POST', `/attempts/${ok.data.attemptId}/submit`, 's1', {});
  });

  test('RACE: many simultaneous starts create exactly one attempt and use exactly one slot', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => start('s2', 'test')));
    assert.ok(results.every(r => r.status === 200), JSON.stringify(results.map(r => r.status)));
    assert.equal(new Set(results.map(r => String(r.data.attemptId))).size, 1);
    assert.equal(await McqAttempt.countDocuments({ user: users.s2._id }), 1);
    assert.equal((await McqAttemptQuota.findOne({ user: users.s2._id })).used, 1);
  });

  test('RACE: with one slot left, simultaneous starts still cannot exceed the limit', async () => {
    // s3 has already burned 1 attempt; fire 8 starts at once for the last slot
    const a = await start('s3', 'test');
    await api('POST', `/attempts/${a.data.attemptId}/submit`, 's3', {});
    const results = await Promise.all(Array.from({ length: 8 }, () => start('s3', 'practice')));
    assert.ok(results.every(r => r.status === 200));
    assert.equal(new Set(results.map(r => String(r.data.attemptId))).size, 1);
    assert.equal(await McqAttempt.countDocuments({ user: users.s3._id }), 2);
    assert.equal((await McqAttemptQuota.findOne({ user: users.s3._id })).used, 2);
    await api('POST', `/attempts/${results[0].data.attemptId}/submit`, 's3', {});
    assert.equal((await start('s3', 'test')).status, 403);
  });

  test('Practice mode: check answer reveals key + explanation, locks the question, and survives a resume', async () => {
    const p = await start('s4', 'practice', { timerEnabled: false });
    assert.equal(p.data.timerEnabled, false);
    const id = p.data.attemptId;
    assert.ok(!JSON.stringify(p.data).includes('Because'), 'nothing revealed until asked');

    const rev = await api('POST', `/attempts/${id}/responses/2/reveal`, 's4', { selectedOption: 'D', deltaTimeSpentSeconds: 12 });
    assert.equal(rev.status, 200);
    assert.equal(rev.data.correctOption, 'B');
    assert.equal(rev.data.isCorrect, false);
    assert.ok(rev.data.explanation.includes('Because B'));

    const locked = await answer('s4', id, 2, 'B');
    assert.equal(locked.data.locked, true, 'cannot change an answer after seeing the key');
    assert.equal((await McqAttempt.findById(id)).responses[1].selectedOption, 'D');

    const resumed = await start('s4', 'practice');
    const q2 = resumed.data.responses.find(r => r.order === 2);
    const q3 = resumed.data.responses.find(r => r.order === 3);
    assert.equal(q2.revealed, true);
    assert.equal(q2.correctOption, 'B');
    assert.equal(q3.correctOption, undefined, 'unrevealed questions stay hidden');

    const timer = await api('PATCH', `/attempts/${id}/settings`, 's4', { timerEnabled: true });
    assert.equal(timer.data.timerEnabled, true);
    await api('POST', `/attempts/${id}/submit`, 's4', {});
    const result = await api('GET', `/attempts/${id}/result`, 's4');
    assert.equal(result.data.mode, 'practice');
    assert.equal(result.data.isRanked, false);
    assert.equal(result.data.rank.value, null, 'practice never gets a rank');
  });

  test('the timer setting is Practice-only', async () => {
    const t = await start('s5', 'test');
    const r = await api('PATCH', `/attempts/${t.data.attemptId}/settings`, 's5', { timerEnabled: false });
    assert.equal(r.status, 400);
  });

  test('saveResponse validates input and clamps client-supplied time', async () => {
    const a = await McqAttempt.findOne({ user: users.s5._id, status: 'in-progress' });
    assert.equal((await answer('s5', a._id, 1, 'Z')).status, 400);
    assert.equal((await api('PATCH', `/attempts/${a._id}/responses/1`, 's5', { status: 'hacked' })).status, 400);
    assert.equal((await api('PATCH', `/attempts/${a._id}/responses/99`, 's5', { selectedOption: 'A' })).status, 404);
    assert.equal((await api('PATCH', `/attempts/${a._id}/responses/1`, 's6', { selectedOption: 'A' })).status, 403, "another student's attempt");
    await api('PATCH', `/attempts/${a._id}/responses/1`, 's5', { selectedOption: 'A', deltaTimeSpentSeconds: 999999 });
    assert.equal((await McqAttempt.findById(a._id)).responses[0].timeSpentSeconds, 1800);
  });

  test('concurrent autosaves on different questions never fail (no version conflicts)', async () => {
    const a = await McqAttempt.findOne({ user: users.s5._id, status: 'in-progress' });
    const results = await Promise.all([1, 2, 3, 4, 5, 1, 2, 3, 4, 5].map((o, i) => api('PATCH', `/attempts/${a._id}/responses/${o}`, 's5', { selectedOption: 'ABCD'[i % 4], isVisit: true, deltaTimeSpentSeconds: 2 })));
    assert.ok(results.every(r => r.status === 200), JSON.stringify(results.map(r => r.status)));
  });

  test('expired timed attempts are auto-submitted by the sweeper', async () => {
    const a = await McqAttempt.findOne({ user: users.s5._id, status: 'in-progress' });
    await McqAttempt.updateOne({ _id: a._id }, { $set: { serverDeadline: new Date(Date.now() - 10 * 60 * 1000) } });
    assert.equal(await sweepExpiredAttempts(), 1);
    assert.equal((await McqAttempt.findById(a._id)).status, 'auto-submitted');
  });

  test('flags: only for questions you have met, and answers stay hidden until you may see them', async () => {
    const q1 = String(questions[0]._id);
    assert.equal((await api('PUT', `/flags/${q1}`, 's6')).status, 403, 'never took the test');

    const live = await start('s6', 'test');
    assert.equal((await api('PUT', `/flags/${q1}`, 's6', { note: 'revise' })).status, 200);
    const during = await api('GET', '/flags', 's6');
    assert.equal(during.data.flags.length, 1);
    assert.equal(during.data.flags[0].answerVisible, false);
    assert.equal(during.data.flags[0].correctOption, undefined, 'flagging mid-test must not leak the answer');
    assert.ok(!JSON.stringify(during.data).includes('Because'));

    await api('POST', `/attempts/${live.data.attemptId}/submit`, 's6', {});
    const after = await api('GET', '/flags', 's6');
    assert.equal(after.data.flags[0].answerVisible, true);
    assert.equal(after.data.flags[0].correctOption, 'A');
    assert.equal(after.data.flags[0].note, 'revise');

    const other = await api('GET', '/flags', 's2');
    assert.equal(other.data.flags.length, 0, 'flags are per student');
  });

  test('practice sessions from flagged questions and from mistakes do not use up attempts', async () => {
    const before = (await McqAttemptQuota.findOne({ user: users.s6._id })).used;
    const f = await api('POST', '/practice/flagged', 's6', {});
    assert.equal(f.status, 200);
    assert.equal(f.data.mode, 'practice');
    assert.equal(f.data.source, 'flagged');
    assert.equal(f.data.questions.length, 1);

    const done = await McqAttempt.findOne({ user: users.s6._id, source: 'test', status: 'submitted' });
    const none = await api('POST', '/practice/mistakes', 's6', { attemptId: String(done._id) });
    assert.equal(none.status, 400, 'no wrong answers -> nothing to practice');

    // give s4 a wrong answer and practice the mistake
    const s4attempt = await McqAttempt.findOne({ user: users.s4._id });
    const m = await api('POST', '/practice/mistakes', 's4', { attemptId: String(s4attempt._id) });
    assert.equal(m.status, 200);
    assert.equal(m.data.source, 'mistakes');
    assert.equal(m.data.questions.length, 1);
    assert.equal((await McqAttemptQuota.findOne({ user: users.s6._id })).used, before);
    assert.equal((await api('POST', '/practice/mistakes', 's6', { attemptId: String(s4attempt._id) })).status, 403, "someone else's attempt");
  });

  test('REPORT -> admin accepts -> answer key changes and every affected attempt is re-scored', async () => {
    // Fresh test so the numbers are easy to reason about
    const { t, qs } = await seedTest('Report Test');
    const startIt = (who, mode) => api('POST', `/tests/${t._id}/start`, who, { mode });

    // s1 and s2 both answer Q1 with B; the key says A
    const a1 = await startIt('s2', 'test');   // s2 has a spare attempt on this NEW test
    const a2 = await startIt('s3', 'test');
    for (const [who, a] of [['s2', a1], ['s3', a2]]) {
      await answer(who, a.data.attemptId, 1, 'B');
      await api('POST', `/attempts/${a.data.attemptId}/submit`, who, {});
    }
    const beforeScore = (await McqAttempt.findById(a1.data.attemptId)).totalMarksObtained;
    assert.equal(beforeScore, -0.66);

    // a third student is still mid-test on the same question
    const live = await startIt('s4', 'test');

    const qid = String(qs[0]._id);
    const bad = await api('POST', `/questions/${qid}/report`, 's2', { reason: 'nonsense' });
    assert.equal(bad.status, 400);
    const r1 = await api('POST', `/questions/${qid}/report`, 's2', { reason: 'wrong-answer', suggestedOption: 'B', suggestedExplanation: 'B is right because...' });
    assert.equal(r1.status, 200);
    const r1b = await api('POST', `/questions/${qid}/report`, 's2', { reason: 'wrong-answer', suggestedOption: 'B', suggestedExplanation: 'B is right because...', comment: 'edited' });
    assert.equal(r1b.data.updated, true, 'reporting twice edits the same report');
    await api('POST', `/questions/${qid}/report`, 's3', { reason: 'wrong-answer', suggestedOption: 'B' });
    await api('POST', `/questions/${qid}/report`, 's4', { reason: 'wrong-answer', suggestedOption: 'C' }); // disagrees; reported mid-test
    assert.equal(await McqReport.countDocuments({ question: qs[0]._id }), 3);
    assert.equal((await api('POST', `/questions/${qid}/report`, 's6', { reason: 'typo' })).status, 403, 'never took this test');

    assert.equal((await api('GET', '/admin/reports', 's2')).status, 403);
    const count = await api('GET', '/admin/reports/count', 'admin');
    assert.equal(count.data.pending >= 3, true);

    const list = await api('GET', '/admin/reports?status=pending', 'admin');
    const group = list.data.groups.find(g => String(g.question._id) === qid);
    assert.equal(group.pendingCount, 3);
    assert.deepEqual(group.tally, { A: 0, B: 2, C: 1, D: 0 });
    assert.equal(group.question.correctOption, 'A');

    const first = group.reports.find(r => r.reporter.email === 's2@test.dev');
    assert.equal((await api('POST', `/admin/reports/${first._id}/resolve`, 's2', { action: 'accept' })).status, 403);

    const res = await api('POST', `/admin/reports/${first._id}/resolve`, 'admin', { action: 'accept', applyExplanation: true });
    assert.equal(res.status, 200);
    assert.equal(res.data.optionChanged, true);
    assert.equal(res.data.rescoredAttempts, 3, '2 finished + 1 in progress contain the question');
    assert.equal(res.data.alsoClosed, 1, "s3's identical report is closed automatically");

    const fixed = await McqQuestion.findById(qid);
    assert.equal(fixed.correctOption, 'B');
    assert.equal(fixed.explanation, 'B is right because...');
    assert.equal(fixed.answerHistory.length, 1);
    assert.equal(fixed.answerHistory[0].fromOption, 'A');

    // finished attempts were re-scored: Q1 was answered B and is now CORRECT
    const rescored = await McqAttempt.findById(a1.data.attemptId);
    assert.equal(rescored.totalMarksObtained, 2);
    assert.equal(rescored.totalCorrect, 1);
    assert.equal(rescored.totalWrong, 0);
    assert.equal(rescored.accuracyPercent, 100);
    // ...the in-progress attempt got the new key too, and will score correctly on submit
    assert.equal((await McqAttempt.findById(live.data.attemptId)).responses[0].correctOption, 'B');

    // the reporter with the disagreeing suggestion is still pending; the admin can ignore it
    const remaining = await McqReport.find({ question: qs[0]._id, status: 'pending' });
    assert.equal(remaining.length, 1);
    const ignore = await api('POST', `/admin/questions/${qid}/reports/reject-all`, 'admin', {});
    assert.equal(ignore.data.closed, 1);

    // reporters are notified through the inbox
    assert.equal(await Message.countDocuments({ recipientId: users.s2._id, text: /accepted/ }), 1);
    assert.equal(await Message.countDocuments({ recipientId: users.s3._id, text: /accepted/ }), 1);
    assert.equal(await Message.countDocuments({ recipientId: users.s4._id, text: /current answer stands/ }), 1);

    // a resolved report cannot be resolved twice
    assert.equal((await api('POST', `/admin/reports/${first._id}/resolve`, 'admin', { action: 'reject' })).status, 409);
  });

  test('admin can accept a report WITHOUT re-scoring past attempts', async () => {
    const { t, qs } = await seedTest('No Rescore Test');
    const a = await api('POST', `/tests/${t._id}/start`, 's5', { mode: 'test' });
    await answer('s5', a.data.attemptId, 2, 'C');
    await api('POST', `/attempts/${a.data.attemptId}/submit`, 's5', {});
    const before = (await McqAttempt.findById(a.data.attemptId)).totalMarksObtained;
    await api('POST', `/questions/${qs[1]._id}/report`, 's5', { reason: 'wrong-answer', suggestedOption: 'C' });
    const report = await McqReport.findOne({ question: qs[1]._id });
    const r = await api('POST', `/admin/reports/${report._id}/resolve`, 'admin', { action: 'accept', rescore: false });
    assert.equal(r.data.rescoredAttempts, 0);
    assert.equal((await McqQuestion.findById(qs[1]._id)).correctOption, 'C');
    assert.equal((await McqAttempt.findById(a.data.attemptId)).totalMarksObtained, before);
  });

  test('admin edits of a question go through the same audit + re-score path', async () => {
    const { t, qs } = await seedTest('Edit Test');
    const a = await api('POST', `/tests/${t._id}/start`, 's6', { mode: 'test' });
    await answer('s6', a.data.attemptId, 3, 'A');
    await api('POST', `/attempts/${a.data.attemptId}/submit`, 's6', {});
    const res = await api('PATCH', `/admin/tests/${t._id}/questions/${qs[2]._id}`, 'admin', { correctOption: 'A' });
    assert.equal(res.status, 200);
    assert.equal(res.data.answerChanged, true);
    assert.equal(res.data.rescoredAttempts, 1);
    assert.equal((await McqAttempt.findById(a.data.attemptId)).totalCorrect, 1);
  });

  test('CSV re-upload updates questions in place (ids survive) and retires ones students already used', async () => {
    const t = await McqTest.create({ title: 'CSV Test', subject: 'GS-1', durationMinutes: 10, isPublished: false, requiresPurchase: false });
    const csv = (rows) => 'order,question text,option a,option b,option c,option d,correct option,explanation\n' + rows.join('\n');
    const upload = async (rows) => {
      const form = new FormData();
      form.append('file', new Blob([csv(rows)], { type: 'text/csv' }), 'q.csv');
      return api('POST', `/admin/tests/${t._id}/questions/upload-csv`, 'admin', undefined, form);
    };

    const r1 = await upload(['1,First?,a,b,c,d,A,e1', '2,Second?,a,b,c,d,B,e2', '3,Third?,a,b,c,d,C,e3']);
    assert.equal(r1.status, 200);
    assert.equal(r1.data.addedCount, 3);
    const idsBefore = (await McqQuestion.find({ test: t._id }).sort({ order: 1 })).map(q => String(q._id));

    // publish + let a student attempt it
    await McqTest.updateOne({ _id: t._id }, { $set: { isPublished: true } });
    const a = await api('POST', `/tests/${t._id}/start`, 's2', { mode: 'practice' });
    await api('POST', `/attempts/${a.data.attemptId}/submit`, 's2', {});

    // fix a typo, change an answer, and drop question 3
    const r2 = await upload(['1,First? (fixed),a,b,c,d,A,e1', '2,Second?,a,b,c,d,C,e2']);
    assert.equal(r2.status, 200);
    assert.equal(r2.data.updatedCount, 2);
    assert.equal(r2.data.retiredCount, 1, 'question 3 has attempts, so it is retired not deleted');
    const now = await McqQuestion.find({ test: t._id }).sort({ order: 1 });
    assert.deepEqual(now.map(q => String(q._id)), idsBefore, 'same ids as before - flags/reports/attempts stay attached');
    assert.equal(now[0].questionText, 'First? (fixed)');
    assert.equal(now[1].correctOption, 'C');
    assert.equal(now[2].isActive, false);
    assert.equal((await McqTest.findById(t._id)).questionCount, 2);

    // new attempts only see the 2 active questions; old results still show all 3
    await McqAttemptQuota.deleteMany({ user: users.s2._id, test: t._id });
    const fresh = await api('POST', `/tests/${t._id}/start`, 's2', { mode: 'test' });
    assert.equal(fresh.data.questions.length, 2);
    const old = await api('GET', `/attempts/${a.data.attemptId}/result`, 's2');
    assert.equal(old.data.questionReview.length, 3);
  });

  test('deleting a question with attempts retires it instead of orphaning them', async () => {
    const { t, qs } = await seedTest('Delete Test');
    const a = await api('POST', `/tests/${t._id}/start`, 's5', { mode: 'test' });
    await api('POST', `/attempts/${a.data.attemptId}/submit`, 's5', {});
    const del = await api('DELETE', `/admin/tests/${t._id}/questions/${qs[0]._id}`, 'admin');
    assert.equal(del.data.retired, true);
    assert.equal((await McqQuestion.findById(qs[0]._id)).isActive, false);
    const result = await api('GET', `/attempts/${a.data.attemptId}/result`, 's5');
    assert.equal(result.data.questionReview.length, 5);
    assert.ok(result.data.questionReview[0].questionText.startsWith('Question 1'));
  });

  test('an in-progress attempt is immune to admin edits (question text comes from its own snapshot)', async () => {
    const { t, qs } = await seedTest('Snapshot Test');
    const a = await api('POST', `/tests/${t._id}/start`, 's5', { mode: 'test' });
    await McqQuestion.updateOne({ _id: qs[0]._id }, { $set: { questionText: 'CHANGED', isActive: false } });
    const again = await api('GET', `/attempts/${a.data.attemptId}`, 's5');
    assert.equal(again.data.questions.length, 5);
    assert.equal(again.data.questions[0].questionText, 'Question 1?');
    assert.equal((await answer('s5', a.data.attemptId, 1, 'A')).status, 200);
  });

  test('overview lists unfinished attempts to resume', async () => {
    const o = await api('GET', '/overview', 's5');
    assert.equal(o.status, 200);
    assert.ok(o.data.inProgress.length >= 1);
    assert.ok(o.data.inProgress[0].total > 0);
  });

  test('subjects endpoint reports per-subject progress', async () => {
    const r = await api('GET', '/subjects', 's1');
    const s = r.data.subjects.find(x => x.subject === 'GS-1');
    assert.ok(s.testsAttempted >= 1);
    assert.equal(s.freeCount, s.testCount);
  });
}
