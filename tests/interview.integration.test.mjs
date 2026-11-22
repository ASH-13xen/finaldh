// Integration tests for /api/interview (question bank, DAF profile, predictions, mock interviews, admin
// review). Like the other suites they only run with a throwaway MongoDB:
//
//   TEST_MONGODB_URI=mongodb://127.0.0.1:27017/test node --test tests/interview.integration.test.mjs
//
// Gemini is switched off here, so this covers the no-AI paths every feature falls back to.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('interview integration tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = 'test-secret';
  process.env.ADMIN_EMAIL = 'admin@test.dev';
  process.env.GEMINI_API_KEY = ''; // set but empty, so dotenv in other modules can't load a real key
  process.env.INTERVIEW_SECTION_LIVE = 'true'; // students use the section in these tests; one test turns it off
  process.env.INTERVIEW_MOCK_ENABLED = 'true'; // the mock room is off in production for now; its tests switch it on, one test turns it off

  const { default: express } = await import('express');
  const { default: mongoose } = await import('mongoose');
  const { default: jwt } = await import('jsonwebtoken');
  const { default: interviewRoutes } = await import('../routes/interviewRoutes.js');
  const { default: User } = await import('../models/User.js');
  const { default: InterviewProfile } = await import('../models/InterviewProfile.js');
  const { default: InterviewSession } = await import('../models/InterviewSession.js');
  const { default: InterviewFamily } = await import('../models/InterviewFamily.js');
  const { default: InterviewQuestion } = await import('../models/InterviewQuestion.js');
  const { default: InterviewTranscript } = await import('../models/InterviewTranscript.js');
  const { buildCorpus } = await import('../lib/interview/corpus.js');
  const { boardMarks } = await import('../lib/interview/interviewer.js');
  const board = await import('../lib/interview/board.js');
  const { profileItems, familyItems } = await import('../lib/interview/predict.js');
  const { seedCorpus } = await import('../lib/interview/seed.js');
  const { openPeopleDb, closePeopleDb, peopleConn } = await import('../config/peopleDb.js');

  let server;
  let base;
  const tokens = {};

  const api = async (method, path, who, body) => {
    const headers = { Authorization: `Bearer ${tokens[who]}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}/api/interview${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  };

  // A small corpus in the shape the parsers produce: repeated questions across boards and years,
  // DAF-hooked questions, and a past follow-up.
  const transcript = (seq, board, profile, qs) => ({
    seq, profile: { boardRaw: board, ...profile },
    questions: qs.map((q, i) => (typeof q === 'string' ? { order: i + 1, asker: i < 2 ? 'chairman' : `m${Math.min(4, i - 1)}`, text: q } : { order: i + 1, ...q })),
    rawText: qs.map((q) => (typeof q === 'string' ? q : q.text)).join('\n')
  });
  const corpusInput = [
    {
      year: 2023, engine: 'heuristic', transcripts: [
        transcript(1, 'Dinesh Dasa', { hobbies: ['Cricket'], homeState: 'Bihar', optional: 'PSIR' }, [
          'Tell us about yourself?', 'Why civil services?', 'What is net neutrality?', 'Do you play cricket?',
          { asker: 'm3', text: 'Who is your favourite cricket player?', followUp: false, note: 'I said Dhoni, the board smiled' },
          { asker: 'm3', text: 'Why him and not Kohli?', followUp: true },
          'How do you see India-US relations?', 'What is famous in Bihar?'
        ]),
        transcript(2, 'Suman Sharma', { hobbies: ['Chess'], homeState: 'Kerala', optional: 'Sociology' }, [
          'Tell us about yourself?', 'Why civil services?', 'What is net neutrality, sir?', 'History of chess?',
          'Do you play chess online?', 'How do you see India-US relations?', 'What is famous in Kerala?'
        ])
      ]
    },
    {
      year: 2024, engine: 'heuristic', transcripts: [
        transcript(1, 'Sheel Vardhan Singh', { hobbies: ['Cricket', 'Gaming'], homeState: 'Uttar Pradesh' }, [
          'Tell us about yourself?', 'Why civil services?', 'Should online gaming be regulated?', 'Do you play cricket?',
          { asker: 'm3', text: 'Who is your favourite cricket player?' },
          { asker: 'm3', text: 'Why is test cricket losing viewers?', followUp: true },
          'What is green hydrogen?', 'How do you see India-US relations?', 'What is famous in Uttar Pradesh?'
        ]),
        transcript(2, 'B B Swain', { hobbies: ['Kabaddi'], homeState: 'Haryana' }, [
          'Tell us about yourself?', 'Why civil services?', 'History of kabaddi?', 'What is green hydrogen?',
          'Is the UN relevant today?', 'What is famous in Haryana?', 'Do you think the UN needs reform?'
        ])
      ]
    }
  ];

  before(async () => {
    await mongoose.connect(URI, { dbName: 'interview_integration' });
    await mongoose.connection.dropDatabase();
    await openPeopleDb(URI, { dbName: 'interview_integration_people' });
    await peopleConn.dropDatabase();
    await Promise.all([User, InterviewProfile, InterviewSession].map((m) => m.init()));
    await seedCorpus(buildCorpus(corpusInput));

    for (const [key, email] of [['admin', 'admin@test.dev'], ['s1', 's1@test.dev'], ['s2', 's2@test.dev'], ['v1', 'v1@test.dev']]) {
      const u = await User.create({ googleId: `g-${key}`, email, name: key, fullName: key });
      tokens[key] = jwt.sign({ userId: u._id, email }, 'test-secret');
      // v1's DAF is verified: the full question bank is open to them (others get the preview).
      if (key === 'v1') await (await import('../lib/interview/dafCheck.js')).setDafCheck(u._id, { status: 'verified' });
    }

    const app = express();
    app.use(express.json());
    app.use('/api/interview', interviewRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await closePeopleDb();
  });

  test('student data lives in the people database, the transcript corpus in the content database', async () => {
    assert.equal(InterviewProfile.db, peopleConn);
    assert.equal(InterviewSession.db, peopleConn);
    for (const M of [InterviewTranscript, InterviewQuestion, InterviewFamily]) assert.equal(M.db, mongoose.connection);
  });

  test('status reports the corpus and that AI is off', async () => {
    const r = await api('GET', '/status', 's1');
    assert.equal(r.status, 200);
    assert.equal(r.data.corpus.transcripts, 4);
    assert.deepEqual(r.data.corpus.years, [2023, 2024]);
    assert.equal(r.data.ai.available, false);
    assert.ok(r.data.sources.length >= 2, 'the transcript compilations are credited');
  });

  test('visitors without a token can look around, but nothing personal', async () => {
    assert.equal((await fetch(`${base}/api/interview/status`)).status, 200, 'the overview loads for visitors');
    for (const path of ['/profile', '/prep', '/credits', '/predictions', '/bank/facets', '/practice/attempts']) {
      assert.equal((await fetch(`${base}/api/interview${path}`)).status, 401, `${path} needs a signed-in student`);
    }
    const bad = await fetch(`${base}/api/interview/status`, { headers: { Authorization: 'Bearer not-a-token' } });
    assert.equal(bad.status, 403, 'a bad token is refused, not treated as a visitor');
  });

  test('the question bank is a preview of the most-asked questions until the DAF is verified', async () => {
    const full = await api('GET', '/bank/search?sort=asked&limit=50', 'admin');
    for (const who of ['s2', null]) {
      const r = who ? await api('GET', '/bank/search?q=net%20neutrality&year=2023', who) : { data: await (await fetch(`${base}/api/interview/bank/search?q=net%20neutrality`)).json() };
      assert.equal(r.data.preview, true, `${who || 'a visitor'} gets the preview`);
      assert.equal(r.data.previewLimit, 15);
      assert.ok(r.data.items.length <= 15);
      assert.equal(r.data.total, full.data.total, 'the preview says how many questions there are');
      assert.deepEqual(r.data.items.map((i) => i.id), full.data.items.slice(0, r.data.items.length).map((i) => i.id), 'the most asked, whatever was searched');
    }
    const v = await api('GET', '/bank/search?q=net%20neutrality', 'v1');
    assert.equal(v.data.preview, undefined, 'a verified student searches the full bank');
    assert.match(v.data.items[0].text, /net neutrality/i);
    const withFacets = await api('GET', '/bank/search?facets=1', 's2');
    assert.equal(withFacets.data.preview, true);
    assert.ok(withFacets.data.facets, 'the preview brings the filter counts, for the locked filters');
  });

  test('"From your DAF": a verified student filters the bank by their own DAF items', async () => {
    assert.equal((await api('GET', '/bank/my-daf', 's2')).status, 403, 'not before the DAF is verified');
    const none = await api('GET', '/bank/my-daf', 'v1');
    assert.equal(none.status, 200);
    assert.deepEqual(none.data.items, [], 'no DAF yet');
    assert.equal((await api('GET', '/bank/search?mine=1', 'v1')).data.total, 0);

    assert.equal((await api('PUT', '/profile', 'v1', { hobbies: ['Cricket'], homeState: 'Haryana' })).status, 200);
    // The test bank is built without the keyword table, so its questions carry no DAF keywords and nothing
    // matches here (the live bank has them); the counts and the filter still have to agree.
    const mine = await api('GET', '/bank/my-daf', 'v1');
    assert.equal(mine.status, 200);
    for (const item of mine.data.items) {
      const one = await api('GET', `/bank/search?label=${encodeURIComponent(item.filter)}&limit=50`, 'v1');
      assert.equal(one.data.total, item.questions, 'each chip count matches its filter');
    }
    const all = await api('GET', '/bank/search?mine=1&limit=50', 'v1');
    assert.equal(all.data.total, mine.data.total, '"All of my DAF" matches its count');

    // A verified DAF can't be deleted or edited (that would be a free change); it changes by re-uploading.
    assert.equal((await api('DELETE', '/profile', 'v1')).status, 403);
    assert.equal((await api('PUT', '/profile', 'v1', { hobbies: ['Chess'] })).data.needReupload, true);
    assert.deepEqual((await api('GET', '/profile', 'v1')).data.profile.hobbies, ['Cricket'], 'unchanged');
    assert.equal((await api('GET', '/credits', 'v1')).data.daf.status, 'verified', 'still verified');
    // (clean up for later tests, as an admin would)
    const { default: IP } = await import('../models/InterviewProfile.js');
    const { default: U } = await import('../models/User.js');
    await IP.updateOne({ user: (await U.findOne({ email: 'v1@test.dev' }))._id }, { $set: { hobbies: [], homeState: '', detailsSavedAt: null } });
  });

  test('the section is open to students unless INTERVIEW_SECTION_LIVE=false closes it to all but admins', async () => {
    process.env.INTERVIEW_SECTION_LIVE = '';
    assert.equal((await api('GET', '/status', 's1')).status, 200, 'open when the switch is unset');
    process.env.INTERVIEW_SECTION_LIVE = 'false';
    try {
      for (const path of ['/status', '/bank/search?q=net', '/sessions', '/profile']) {
        assert.equal((await api('GET', path, 's1')).status, 403, `${path} is refused to a student`);
        assert.equal((await api('GET', path, 'admin')).status, 200, `${path} works for an admin`);
      }
      assert.equal((await api('POST', '/sessions', 's1', { minutes: 10 })).status, 403);
    } finally {
      process.env.INTERVIEW_SECTION_LIVE = 'true';
    }
  });

  test('bank search: repeats are counted once per interview, filters narrow results', async () => {
    const r = await api('GET', '/bank/search?q=net%20neutrality', 'v1');
    assert.equal(r.status, 200);
    assert.equal(r.data.items[0].timesAsked, 2);
    assert.match(r.data.items[0].text, /net neutrality/i);

    const all = await api('GET', '/bank/search?sort=asked', 'v1');
    assert.equal(all.data.items[0].timesAsked, 4, 'the most asked question first');

    const byYear = await api('GET', '/bank/search?q=hydrogen&year=2023', 'v1');
    assert.equal(byYear.data.total, 0);
    const byBoard = await api('GET', `/bank/search?q=green%20hydrogen&board=${encodeURIComponent('B.B. Swain')}`, 'v1');
    assert.equal(byBoard.data.total, 1);

    const facets = await api('GET', '/bank/facets', 's1');
    assert.ok(facets.data.boards.some((b) => b.value === 'Sheel Vardhan Singh'));
    const trends = await api('GET', '/bank/trends', 's1');
    assert.equal(trends.status, 200);
    assert.ok(trends.data.mostAsked.length > 0);
  });

  test('a family shows where it was asked and how the board followed up; full transcripts are admin-only', async () => {
    const s = await api('GET', '/bank/search?q=favourite%20cricket%20player', 'v1');
    const fam = await api('GET', `/bank/families/${s.data.items[0].id}`, 's1');
    assert.equal(fam.status, 200);
    assert.equal(fam.data.asked.length, 2);
    assert.ok(fam.data.asked.some((a) => a.followedBy === 'Why him and not Kohli?'));
    assert.ok(fam.data.asked.some((a) => /Dhoni/.test(a.note)));
    assert.equal(fam.data.asked[0].transcriptId, undefined, 'students get no link to the full transcript');
    const adminFam = await api('GET', `/bank/families/${s.data.items[0].id}`, 'admin');
    const tid = adminFam.data.asked[0].transcriptId;
    assert.ok(tid);
    assert.equal((await api('GET', `/bank/transcripts/${tid}`, 's1')).status, 403);
    const t = await api('GET', `/bank/transcripts/${tid}`, 'admin');
    assert.equal(t.status, 200);
    assert.ok(t.data.questions.length >= 7);
    assert.equal(t.data.transcript.rawText, undefined, 'raw text stays in the admin review screens');
    const bad = await api('GET', '/bank/families/not-an-id', 's1');
    assert.equal(bad.status, 404);
  });

  test('predictions need a verified DAF, then cite past evidence for each DAF item', async () => {
    const locked = await api('GET', '/predictions', 's1');
    assert.equal(locked.status, 403, 'not before the DAF is verified');
    assert.equal(locked.data.needDafVerification, true);
    assert.equal((await api('GET', '/predictions', 'admin')).status, 400, 'admins are never gated (but need a DAF)');
    const { setDafCheck } = await import('../lib/interview/dafCheck.js');
    const { default: User } = await import('../models/User.js');
    const s1 = await User.findOne({ email: 's1@test.dev' });
    await setDafCheck(s1._id, { status: 'verified' });

    const none = await api('GET', '/predictions', 's1');
    assert.equal(none.status, 400);
    assert.equal(none.data.needsProfile, true);

    const saved = await api('PUT', '/profile', 's1', {
      homeState: 'up', hobbies: ['Cricket', 'Gaming'], optional: 'psir',
      education: [{ degree: 'B.Tech', discipline: 'Computer Science', institution: 'IIT Delhi' }], servicePreference: ['IAS', 'IFS']
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.profile.homeState, 'Uttar Pradesh');
    assert.equal(saved.data.profile.optional, 'PSIR');
    assert.ok(saved.data.items.some((i) => i.key === 'hobby:cricket'));

    const p = await api('GET', '/predictions', 's1');
    assert.equal(p.status, 200);
    assert.equal(p.data.aiUsed, false);
    const cricket = p.data.groups.find((g) => g.key === 'hobby:cricket');
    const direct = cricket.predictions.find((x) => x.kind === 'direct');
    assert.ok(direct, 'a question asked to past candidates with cricket in their DAF');
    assert.ok(direct.evidence.timesAsked >= 2);
    assert.match(direct.basisNote, /Cricket/);
    assert.ok(['high', 'medium', 'low'].includes(direct.likelihood));
    // What the screen needs: where the question comes from, a tier, and a key for tracking progress.
    assert.equal(direct.source, 'past');
    assert.ok(['certain', 'likely', 'worth'].includes(direct.tier));
    assert.match(direct.key, /^q:[a-f0-9]{16}$/);
    assert.ok(p.data.summary.questions >= p.data.summary.past);
    const order = { certain: 0, likely: 1, worth: 2 };
    for (const g of p.data.groups) {
      for (let i = 1; i < g.predictions.length; i++) assert.ok(order[g.predictions[i - 1].tier] <= order[g.predictions[i].tier], 'surest first');
    }
    const gaming = p.data.groups.find((g) => g.key === 'hobby:gaming');
    assert.ok(gaming.predictions.some((x) => /gaming/i.test(x.question)));

    const again = await api('GET', '/predictions', 's1');
    assert.equal(again.data.cached, true, 'unchanged DAF -> saved predictions');
    await setDafCheck(s1._id, { status: 'none' }); // later tests expect s1 unverified
  });

  test('practice interview: starts with the chairperson, follows the plan, ends with a basic report', async () => {
    const start = await api('POST', '/sessions', 's1', { mode: 'practice', inputMode: 'voice', minutes: 10 });
    assert.equal(start.status, 201);
    let s = start.data.session;
    assert.equal(s.current.asker, 'chairman');
    assert.ok(s.current.source.label, 'practice mode shows where the question came from');
    assert.equal(s.inputMode, 'voice');
    const askers = new Set([s.current.asker]);

    const dup = { status: 0 };
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      const idx = s.current.idx;
      const r = await api('POST', `/sessions/${s.id}/answer`, 's1', { turnIdx: idx, answer: i % 3 === 2 ? '' : 'Sir, I believe there are two sides to this. The government has taken steps, but implementation needs work, for example in my district.', answerMode: 'voice', answerSeconds: 35, skipped: i % 3 === 2 });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      if (i === 0) Object.assign(dup, await api('POST', `/sessions/${s.id}/answer`, 's1', { turnIdx: idx, answer: 'again' }));
      done = r.data.done;
      s = r.data.session;
      if (!done) askers.add(s.current.asker);
      else assert.match(r.data.closing, /end of your interview/);
    }
    assert.ok(done, 'the plan runs out and the interview closes');
    assert.equal(dup.status, 409, 'an answer to an already-answered question is refused');
    assert.ok(askers.size >= 3, `several panel members ask questions (${[...askers]})`);
    assert.ok(s.turns[0].feedback?.verdict, 'practice mode shows feedback as you go');

    const end = await api('POST', `/sessions/${s.id}/end`, 's1');
    assert.equal(end.status, 200);
    const report = end.data.session.report;
    assert.equal(report.generatedBy, 'basic');
    assert.equal(report.traits.length, 7);
    assert.ok(report.stats.answered > 0 && report.stats.skipped > 0);
    assert.equal(report.marks, null, 'no marks without scored answers (AI is off here)');

    const list = await api('GET', '/sessions', 's1');
    assert.equal(list.data.sessions[0].status, 'completed');
    const other = await api('GET', `/sessions/${s.id}`, 's2');
    assert.equal(other.status, 404, 'another student cannot open it');
  });

  test('real mode hides sources and feedback until the interview ends', async () => {
    const start = await api('POST', '/sessions', 's2', { mode: 'real', minutes: 10 });
    assert.equal(start.status, 201);
    const s = start.data.session;
    const r = await api('POST', `/sessions/${s.id}/answer`, 's2', { turnIdx: s.current.idx, answer: 'My answer.' });
    assert.equal(r.data.session.turns[0].feedback, null);
    assert.equal(r.data.session.current.source.label, '');
    const end = await api('POST', `/sessions/${s.id}/end`, 's2');
    assert.ok(end.data.session.turns[0].feedback);
    assert.ok(end.data.session.turns[1].source.label !== undefined);
    const late = await api('POST', `/sessions/${s.id}/answer`, 's2', { answer: 'x' });
    assert.equal(late.status, 409);
  });

  test('pausing stops the interview clock; the hold before Begin is not counted as a pause', async () => {
    const ALLOWANCE = board.FORMATS.quick.minutes * 60; // the safety allowance; the format decides when the interview ends
    const start = await api('POST', '/sessions', 's2', { format: 'quick' });
    const id = start.data.session.id;
    assert.equal(start.data.session.paused, false);
    assert.ok(Math.abs(start.data.session.secondsLeft - ALLOWANCE) <= 2);

    const hold = await api('POST', `/sessions/${id}/pause`, 's2', { reason: 'begin' });
    assert.equal(hold.status, 200);
    assert.equal(hold.data.session.paused, true);
    // Pretend the candidate sat on the welcome screen for two minutes.
    await InterviewSession.updateOne({ _id: id }, { $set: { pausedAt: new Date(Date.now() - 120000) } });
    const waiting = await api('GET', `/sessions/${id}`, 's2');
    assert.ok(Math.abs(waiting.data.session.secondsLeft - ALLOWANCE) <= 2, 'no time is lost while paused');
    const go = await api('POST', `/sessions/${id}/resume`, 's2');
    assert.equal(go.data.session.paused, false);
    assert.ok(Math.abs(go.data.session.secondsLeft - ALLOWANCE) <= 2, 'the clock carries on from where it stopped');
    assert.equal((await api('POST', `/sessions/${id}/resume`, 's2')).status, 200, 'resuming twice is harmless');

    await api('POST', `/sessions/${id}/pause`, 's2', { reason: 'notes' });
    await api('POST', `/sessions/${id}/resume`, 's2');
    const p1 = await api('POST', `/sessions/${id}/pause`, 's2');
    assert.equal(p1.data.session.paused, true);
    assert.equal((await api('POST', `/sessions/${id}/pause`, 's2')).data.session.paused, true, 'pausing twice is harmless');
    assert.equal((await api('POST', `/sessions/${id}/pause`, 's1')).status, 404, 'another student cannot pause it');

    // Answering restarts the clock by itself.
    const s = p1.data.session;
    const r = await api('POST', `/sessions/${id}/answer`, 's2', { turnIdx: s.current.idx, answer: 'My answer, sir.' });
    assert.equal(r.status, 200);
    assert.equal(r.data.session.paused, false);

    const end = await api('POST', `/sessions/${id}/end`, 's2');
    assert.equal(end.data.session.report.stats.pauses, 1, 'only the pause the candidate took is counted');
    assert.equal(end.data.session.report.stats.minutes, 1, 'paused time is not interview time');
    assert.equal((await api('POST', `/sessions/${id}/pause`, 's2')).status, 409, 'a finished interview cannot be paused');
  });

  test('board marks: five members out of 55 each, 275 in all, from the scored answers', () => {
    const turn = (asker, score, skipped = false) => ({ asker, skipped, answeredAt: new Date(), feedback: score == null ? {} : { score } });
    assert.equal(boardMarks({ turns: [turn('chairman', null), turn('m1', null)] }, null), null, 'nothing scored -> no marks');

    const average = boardMarks({ turns: ['chairman', 'm1', 'm2', 'm3', 'm4'].map((a) => turn(a, 5)) }, 5);
    assert.equal(average.outOf, 275);
    assert.deepEqual(average.members.map((m) => m.marks), [32, 32, 32, 32, 32], 'an average answer is about 57%');
    assert.equal(average.total, 160);
    assert.equal(average.basedOn, 5);

    const mixed = boardMarks({ turns: [turn('chairman', 9), turn('m1', 2), turn('m1', null, true), turn('m2', 7)] }, 6);
    const by = Object.fromEntries(mixed.members.map((m) => [m.id, m]));
    assert.ok(by.chairman.marks > by.m2.marks && by.m2.marks > by.m1.marks, 'each member marks the answers they heard');
    assert.equal(by.m3.marks, by.m4.marks, 'members who asked nothing go by the overall impression');
    assert.equal(by.m1.questions, 2);
    assert.equal(mixed.total, mixed.members.reduce((n, m) => n + m.marks, 0));
    for (const m of mixed.members) assert.ok(m.marks >= 14 && m.marks <= 50 && m.outOf === 55);
    assert.ok(boardMarks({ turns: [turn('m1', 10)] }, 10).total <= 250, 'even a perfect interview stays inside what real boards award');
  });

  test('formats fix the number of questions and follow-ups', async () => {
    const status = await api('GET', '/status', 's1');
    assert.deepEqual(status.data.formats.map((f) => [f.key, f.questions, f.followUps]), [['quick', 8, 4], ['standard', 14, 7], ['full', 20, 10]]);
    assert.deepEqual(status.data.temperaments.map((t) => t.key), ['cordial', 'standard', 'strict']);

    const start = await api('POST', '/sessions', 's1', { format: 'quick', temperament: 'strict', inputMode: 'voice' });
    assert.equal(start.status, 201);
    let s = start.data.session;
    assert.equal(s.format, 'quick');
    assert.equal(s.formatLabel, 'Quick drill');
    assert.equal(s.temperament, 'strict');
    assert.equal(s.interruptAfter, 100);
    assert.deepEqual([s.progress.mainTotal, s.progress.followUpBudget, s.progress.mainAsked, s.progress.followUpsUsed], [8, 4, 1, 0]);
    assert.equal(s.current.lead[0].kind, 'greeting');
    assert.match(s.current.lead[0].text, /^Good (morning|afternoon|evening)\. Please take your seat\.$/);
    assert.ok(s.current.interruptLine, 'the line for cutting a long answer short is ready');

    let done = false;
    const handovers = [];
    for (let i = 0; i < 30 && !done; i++) {
      const r = await api('POST', `/sessions/${s.id}/answer`, 's1', { turnIdx: s.current.idx, answer: 'Sir, there are two sides to it. The state has acted, but delivery on the ground is uneven, as I saw in my own district.', answerSeconds: 30 });
      done = r.data.done;
      s = r.data.session;
      if (!done) handovers.push(...s.current.lead.filter((l) => l.kind === 'handover'));
    }
    assert.ok(done);
    assert.equal(s.progress.mainAsked, 8, 'every planned question is asked');
    assert.ok(s.progress.followUpsUsed <= 4, 'never more follow-ups than the format allows');
    assert.equal(s.turns.length, 8 + s.progress.followUpsUsed);
    assert.equal(handovers.length, 4, 'the Chairperson brings in each of the four members once');
    assert.ok(handovers.every((l) => l.asker === 'chairman' && /Member [1-4]/.test(l.text)));
    assert.ok(s.turns.every((t) => t.reaction && typeof t.reaction.text === 'string'), 'the member says something after every answer');
    await api('POST', `/sessions/${s.id}/end`, 's1');

    const old = await api('POST', '/sessions', 's1', { minutes: 30 });
    assert.equal(old.data.session.format, 'full', 'the old "minutes" choice still maps to a format');
    // A full board is 20 questions; this test library holds fewer distinct ones, and the plan never repeats.
    assert.ok(old.data.session.progress.mainTotal > 14 && old.data.session.progress.mainTotal <= 20);
    assert.equal(old.data.session.progress.followUpBudget, 10);
    await api('POST', `/sessions/${old.data.session.id}/end`, 's1');
  });

  test('a pass draws a remark that depends on the temperament of the board', async () => {
    const said = {};
    for (const temperament of ['cordial', 'strict']) {
      const start = await api('POST', '/sessions', 's2', { format: 'quick', temperament });
      const s = start.data.session;
      const r = await api('POST', `/sessions/${s.id}/answer`, 's2', { turnIdx: s.current.idx, skipped: true });
      said[temperament] = r.data.session.turns[0].reaction;
      await api('POST', `/sessions/${s.id}/end`, 's2');
    }
    assert.match(said.cordial.text, /alright|No problem/i);
    assert.match(said.strict.text, /should know|basic question/i);
    assert.notEqual(said.cordial.text, said.strict.text);

    const line = (o) => board.cannedReaction({ words: 0, n: 0, ...o });
    assert.equal(line({ temperament: 'strict', skipped: true, daf: true, passes: 1 }).kind, 'passDaf');
    assert.equal(line({ temperament: 'strict', skipped: true, daf: true, passes: 1 }).mood, 'displeased');
    assert.equal(line({ temperament: 'standard', skipped: true, daf: false, passes: 3 }).kind, 'passAgain');
    assert.equal(line({ temperament: 'standard', skipped: false, words: 8 }).kind, 'brief');
    assert.equal(line({ temperament: 'standard', skipped: false, words: 300 }).kind, 'long');
    assert.equal(line({ temperament: 'standard', skipped: false, words: 80 }).mood, 'neutral');
  });

  test('what the camera saw: scored, mentioned now and then, and summed up in the report', async () => {
    const start = await api('POST', '/sessions', 's2', { format: 'quick', temperament: 'standard', mode: 'practice' });
    let s = start.data.session;
    const answer = 'Sir, I believe this needs a balanced view. On one hand the government has launched several schemes, but on the ground gaps remain, as I saw in my own district during my field visit last year.';
    const poor = { tracked: true, seconds: 40, absent: 0.02, eyeContact: 0.22, lookAways: 4, longestAway: 12, down: 0.1, lean: 0.1, slump: 0.1, near: 0, restless: 0.2, smile: 0.05, wpm: 150, fillers: 1, junk: 'x'.repeat(5000) };
    const good = { ...poor, eyeContact: 0.93, lookAways: 0, longestAway: 0 };

    let r = await api('POST', `/sessions/${s.id}/answer`, 's2', { turnIdx: s.current.idx, answer, answerSeconds: 40, behaviour: poor });
    s = r.data.session;
    assert.equal(s.turns[0].presenceIssue, 'eyeContact');
    assert.ok(s.turns[0].presence < 6, `little eye contact scores low (${s.turns[0].presence})`);
    assert.match(s.turns[0].reaction.text, /look at the board/i, 'the member asks for eye contact');

    r = await api('POST', `/sessions/${s.id}/answer`, 's2', { turnIdx: s.current.idx, answer, answerSeconds: 40, behaviour: poor });
    s = r.data.session;
    assert.doesNotMatch(s.turns[1].reaction.text, /look at the board/i, 'not on two answers running');

    r = await api('POST', `/sessions/${s.id}/answer`, 's2', { turnIdx: s.current.idx, answer, answerSeconds: 40, behaviour: good, interrupted: true });
    s = r.data.session;
    assert.equal(s.turns[2].presence, 10);
    assert.equal(s.turns[2].interrupted, true);
    assert.equal(s.turns[2].reaction.text, '', 'after cutting an answer short the member has already spoken');

    r = await api('POST', `/sessions/${s.id}/answer`, 's2', { turnIdx: s.current.idx, answer, answerSeconds: 40, behaviour: { tracked: false, wpm: 150, fillers: 0 } });
    s = r.data.session;
    assert.equal(s.turns[3].presence, null, 'no camera, no score');

    const saved = await InterviewSession.findById(s.id);
    assert.equal(saved.turns[0].behaviour.junk, undefined, 'only the known numbers are kept');
    assert.equal(saved.turns[0].behaviour.eyeContact, 0.22);

    const end = await api('POST', `/sessions/${s.id}/end`, 's2');
    const p = end.data.session.report.presence;
    assert.equal(p.tracked, 3);
    assert.ok(p.eyeContact > 0.4 && p.eyeContact < 0.5);
    assert.equal(p.longestAway, 12);
    assert.equal(p.wpm, 150);
    assert.ok(p.tips.some((t) => /look/i.test(t)));
    assert.equal(p.perQuestion.length, 4);
    assert.equal(end.data.session.report.stats.interrupted, 1);

    // Real mode keeps the scores for the report, but the spoken reaction is still there.
    const real = await api('POST', '/sessions', 's2', { format: 'quick', mode: 'real' });
    const rr = await api('POST', `/sessions/${real.data.session.id}/answer`, 's2', { turnIdx: 0, answer, behaviour: poor });
    assert.equal(rr.data.session.turns[0].presence, null);
    assert.equal(rr.data.session.turns[0].presenceIssue, '');
    assert.ok(rr.data.session.turns[0].reaction.text);
    await api('POST', `/sessions/${real.data.session.id}/end`, 's2');
  });

  test('behaviour scoring and marks: forgiving, and a tenth of each mark', () => {
    const b = (o) => board.cleanBehaviour({ tracked: true, seconds: 40, absent: 0, eyeContact: 0.9, lookAways: 0, longestAway: 0, down: 0, lean: 0, slump: 0, near: 0, restless: 0, smile: 0.1, wpm: 150, fillers: 0, ...o });
    assert.equal(board.presenceScore(b({}), 80), 10);
    assert.equal(board.presenceIssue(b({}), { words: 80 }), null);
    assert.equal(board.presenceIssue(b({ down: 0.6 }), { words: 80 }), 'reading');
    assert.equal(board.presenceIssue(b({ absent: 0.5 }), { words: 80 }), 'absent');
    assert.equal(board.presenceIssue(b({ slump: 0.7 }), { words: 80 }), 'posture');
    assert.equal(board.presenceIssue(b({ restless: 0.7 }), { words: 80 }), 'restless');
    assert.equal(board.presenceIssue(b({ eyeContact: 0.55 }), { words: 80 }), null, 'a little short of ideal is not worth a remark');
    assert.equal(board.presenceIssue(b({ eyeContact: 0.1, seconds: 4 }), { words: 5 }), null, 'too short to judge');
    assert.equal(board.presenceScore(board.cleanBehaviour({ tracked: false }), 80), null);
    assert.equal(board.cleanBehaviour('nonsense'), null);
    assert.equal(board.cleanBehaviour({ tracked: true, eyeContact: 7, wpm: -3 }).eyeContact, 1, 'numbers are kept in range');
    assert.ok(board.presenceScore(b({ eyeContact: 0, down: 0.5, absent: 0.5, slump: 0.8, restless: 0.8, longestAway: 30 }), 80) >= 0);

    const turn = (asker, score, presence) => ({ asker, skipped: false, answeredAt: new Date(), feedback: { score }, presence });
    const all = ['chairman', 'm1', 'm2', 'm3', 'm4'];
    const plain = boardMarks({ turns: all.map((a) => turn(a, 6, null)) }, 6);
    const poised = boardMarks({ turns: all.map((a) => turn(a, 6, 10)) }, 6);
    const slumped = boardMarks({ turns: all.map((a) => turn(a, 6, 0)) }, 6);
    assert.equal(plain.presenceCounted, false);
    assert.ok(poised.total > plain.total && plain.total > slumped.total);
    assert.ok(poised.total - slumped.total <= 20, 'how you sit cannot outweigh what you say');
  });

  test('family background and other languages become DAF items', () => {
    assert.deepEqual(familyItems('Father: farmer; Mother is a teacher').map((f) => f.value), ['farmer', 'teacher']);
    assert.deepEqual(familyItems('').length, 0);
    const keys = profileItems({ homeState: 'Bihar', familyBackground: 'Father: farmer', languages: ['Hindi', 'English', 'Maithili'] }).map((i) => i.key);
    assert.ok(keys.includes('family:farmer'));
    assert.ok(keys.includes('language:maithili'));
    assert.ok(!keys.some((k) => /language:(hindi|english)/.test(k)), 'everyone lists Hindi and English');
  });

  test('starting a new interview abandons the unfinished one', async () => {
    const a = await api('POST', '/sessions', 's2', { minutes: 10 });
    const b = await api('POST', '/sessions', 's2', { minutes: 10 });
    assert.equal(b.status, 201);
    assert.equal((await InterviewSession.findById(a.data.session.id)).status, 'abandoned');
  });

  test('board voice: only for the owner\'s own questions, and refused (so the browser falls back) when AI is off', async () => {
    const start = await api('POST', '/sessions', 's1', { minutes: 10, inputMode: 'voice' });
    const id = start.data.session.id;
    const res = await fetch(`${base}/api/interview/sessions/${id}/speech?turn=0`, { headers: { Authorization: `Bearer ${tokens.s1}` } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).aiUnavailable, true);
    const other = await fetch(`${base}/api/interview/sessions/${id}/speech?turn=0`, { headers: { Authorization: `Bearer ${tokens.s2}` } });
    assert.equal(other.status, 404, 'another student cannot have this session spoken');
    const sample = await fetch(`${base}/api/interview/voice-sample?asker=m1`, { headers: { Authorization: `Bearer ${tokens.s1}` } });
    assert.equal(sample.status, 503);
    await api('POST', `/sessions/${id}/end`, 's1');
  });

  test('reading a DAF file on its own is for admins (students upload through /daf/submit); with AI off it says so', async () => {
    const form = () => { const f = new FormData(); f.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'daf.pdf'); return f; };
    const student = await fetch(`${base}/api/interview/profile/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s1}` }, body: form() });
    assert.equal(student.status, 403, 'students cannot have files read outside their one upload');
    const res = await fetch(`${base}/api/interview/profile/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}` }, body: form() });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).aiUnavailable, true);
    const noFile = await fetch(`${base}/api/interview/profile/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(noFile.status, 400);
    const exe = new FormData();
    exe.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'daf.exe');
    const bad = await fetch(`${base}/api/interview/profile/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}` }, body: exe });
    assert.equal(bad.status, 400, 'only PDFs and photos are read');

    const audio = new FormData();
    audio.append('audio', new Blob([Buffer.from([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
    const t = await fetch(`${base}/api/interview/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s1}` }, body: audio });
    assert.equal(t.status, 503);
  });

  test('admin review: only admins; edits, merges and hiding update the bank', async () => {
    assert.equal((await api('GET', '/admin/overview', 's1')).status, 403);
    const ov = await api('GET', '/admin/overview', 'admin');
    assert.equal(ov.status, 200);
    assert.equal(ov.data.years.length, 2);

    const list = await api('GET', '/admin/transcripts?year=2024', 'admin');
    assert.equal(list.data.total, 2);
    const t = await api('GET', `/admin/transcripts/${list.data.items[0].id}`, 'admin');
    assert.ok(t.data.transcript.rawText.length > 0);

    // Merge the two UN questions into one family
    const un1 = await api('GET', '/bank/search?q=UN%20relevant', 'v1');
    const un2 = await api('GET', '/bank/search?q=UN%20reform', 'v1');
    const a = un1.data.items.find((f) => /relevant/.test(f.text));
    const b = un2.data.items.find((f) => /reform/.test(f.text));
    assert.notEqual(a.id, b.id);
    assert.equal((await api('POST', '/admin/families/merge', 'admin', { targetId: a.id, sourceIds: [b.id] })).status, 200);
    const merged = await api('GET', `/bank/families/${a.id}`, 's1');
    assert.equal(merged.data.asked.length, 2);

    // Fixing a transcript's board updates the family statistics
    const hy = await api('GET', '/bank/search?q=green%20hydrogen', 'v1');
    const famBefore = await api('GET', `/bank/families/${hy.data.items[0].id}`, 'admin'); // transcript links are admin-only
    const swainTranscript = famBefore.data.asked.find((x) => x.board === 'B.B. Swain').transcriptId;
    assert.equal((await api('PATCH', `/admin/transcripts/${swainTranscript}`, 'admin', { board: 'Shri Dinesh Dasa sir', reviewed: true })).status, 200);
    const famAfter = await api('GET', `/bank/families/${hy.data.items[0].id}`, 's1');
    assert.ok(famAfter.data.family.boards.includes('Dinesh Dasa'));

    // Hiding a question removes it from the bank
    const q = t.data.questions.find((x) => /online gaming/i.test(x.text)) || t.data.questions[0];
    assert.equal((await api('PATCH', `/admin/questions/${q.id}`, 'admin', { hidden: true })).status, 200);
    if (/online gaming/i.test(q.text)) {
      const gone = await api('GET', '/bank/search?q=online%20gaming%20regulated', 'v1');
      assert.ok(!gone.data.items.some((f) => /online gaming be regulated/i.test(f.text)));
    }
  });

  test('bank filters: counts for each filter value, how-often bands, chairperson or members', async () => {
    const all = await api('GET', '/bank/search?facets=1&limit=50', 'v1');
    assert.equal(all.status, 200);
    const fc = all.data.facets;
    for (const k of ['year', 'board', 'topic', 'hookType', 'qtype', 'often', 'asker', 'shelfLife']) assert.ok(fc[k], `facet ${k}`);
    const oftenTotal = Object.values(fc.often).reduce((a, b) => a + b, 0);
    assert.equal(oftenTotal, all.data.total, 'every question falls in one how-often band');
    const year = Object.keys(fc.year)[0];
    const byYear = await api('GET', `/bank/search?facets=1&year=${year}`, 'v1');
    assert.equal(byYear.data.total, fc.year[year], 'the count shown is the count you get');
    assert.equal(Object.values(byYear.data.facets.year).reduce((a, b) => a + b, 0) >= byYear.data.total, true, 'other years still show their counts');
    const repeated = await api('GET', '/bank/search?often=repeated', 'v1');
    assert.ok(repeated.data.items.every((f) => f.timesAsked >= 2 && f.timesAsked <= 4));
    const members = await api('GET', '/bank/search?asker=members&limit=50', 'v1');
    assert.ok(members.data.items.every((f) => Object.keys(f.askers).some((k) => k !== 'chairman' && k !== 'unknown')));
  });

  test('prep tracker: statuses, saved questions and notes per question; the interview date', async () => {
    const key = 'q:0123456789abcdef';
    assert.equal((await api('PUT', '/prep/items/not-a-key', 's1', { status: 'drafted' })).status, 400);
    assert.equal((await api('PUT', `/prep/items/${key}`, 's1', { status: 'flying' })).status, 400);
    const a = await api('PUT', `/prep/items/${key}`, 's1', { status: 'drafted', saved: true, note: 'Start with Dhoni', text: 'Who is your favourite cricketer?', source: 'past' });
    assert.equal(a.status, 200);
    assert.equal(a.data.item.status, 'drafted');
    const b = await api('PUT', `/prep/items/${key}`, 's1', { status: 'confident' });
    assert.equal(b.data.item.note, 'Start with Dhoni', 'a partial update keeps the other fields');
    assert.equal((await api('PUT', '/prep/settings', 's1', { interviewDate: '2027-02-15' })).status, 200);
    const mine = await api('GET', '/prep', 's1');
    assert.equal(mine.data.items.length, 1);
    assert.equal(mine.data.items[0].status, 'confident');
    assert.ok(mine.data.interviewDate.startsWith('2027-02-15'));
    assert.equal((await api('GET', '/prep', 's2')).data.items.length, 0, 'each student sees only their own');
    assert.equal((await api('DELETE', `/prep/items/${key}`, 's1')).status, 200);
    assert.equal((await api('GET', '/prep', 's1')).data.items.length, 0);
  });

  test('question detail: follow-up ladders and the follow-ups boards use most; answer guides need AI', async () => {
    const s = await api('GET', '/bank/search?q=favourite%20cricket%20player', 'v1');
    const fam = await api('GET', `/bank/families/${s.data.items[0].id}`, 's1');
    assert.ok(Array.isArray(fam.data.followUps));
    assert.ok(fam.data.followUps.some((f) => f.text === 'Why him and not Kohli?'));
    assert.ok(fam.data.asked.some((a) => a.ladder?.[0]?.text === 'Why him and not Kohli?'));
    assert.match(s.data.items[0].key, /^q:[a-f0-9]{16}$/, 'bank questions carry the same progress key as predictions');
    // "How to approach it" needs a verified DAF, then costs 1 AI credit (given back when it can't be made).
    const approachUrl = `/bank/families/${s.data.items[0].id}/approach`;
    assert.equal((await api('POST', approachUrl, 's2')).status, 403, 'not before the DAF is verified');
    const { setDafCheck } = await import('../lib/interview/dafCheck.js');
    const { getBalance } = await import('../lib/interview/credits.js');
    const { default: User } = await import('../models/User.js');
    const s2 = await User.findOne({ email: 's2@test.dev' });
    await setDafCheck(s2._id, { status: 'verified' });
    const before = (await getBalance(s2._id)).total;
    assert.equal((await api('GET', approachUrl, 's2')).status, 402, 'locked until unlocked with a credit');
    const g = await api('POST', approachUrl, 's2');
    assert.equal(g.status, 503);
    assert.equal(g.data.aiUnavailable, true);
    assert.equal((await getBalance(s2._id)).total, before, 'no AI, no charge');
    await setDafCheck(s2._id, { status: 'none' });
    assert.equal((await api('POST', approachUrl, 'admin')).status, 503, 'admins skip the DAF check and credits');
  });

  test('practice studio: needs a verified DAF; attempts keep numbers only; AI feedback needs AI and a recording', async () => {
    const { setDafCheck } = await import('../lib/interview/dafCheck.js');
    const { default: User } = await import('../models/User.js');
    const blocked = await api('POST', '/practice/attempts', 's1', { question: 'Why civil services?', metrics: { wpm: 120 } });
    assert.equal(blocked.status, 403, 'no practice before the DAF is verified');
    assert.equal(blocked.data.needDafVerification, true);
    await setDafCheck((await User.findOne({ email: 's1@test.dev' }))._id, { status: 'verified' });
    const save = await api('POST', '/practice/attempts', 's1', {
      questionKey: 'q:0123456789abcdef', question: 'Why civil services?', lang: 'en',
      metrics: { durationSec: 62, wpm: 148, fillers: 4, fillersPerMin: 3.9, longPauses: 2, startDelaySec: 1.2, wpmIgnored: 9 },
      scores: { pace: 9, fluency: 7, confidence: 6 }, audio: 'should be ignored'
    });
    assert.equal(save.status, 200);
    await api('POST', '/practice/attempts', 's1', { question: 'Tell us about yourself', metrics: { wpm: 999 } });
    const mine = await api('GET', '/practice/attempts', 's1');
    assert.equal(mine.data.attempts.length, 2);
    assert.equal(mine.data.attempts.find((a) => a.question === 'Tell us about yourself').metrics.wpm, 400, 'numbers are clamped');
    assert.equal(mine.data.attempts[0].audio, undefined);
    assert.equal(mine.data.credits.free, 15, 'AI feedback uses credits: 15 free');
    const byQ = await api('GET', '/practice/attempts?key=q:0123456789abcdef', 's1');
    assert.equal(byQ.data.attempts.length, 1);
    assert.equal((await api('GET', '/practice/attempts', 's2')).data.attempts.length, 0, 'only your own');
    const noFile = await api('POST', '/practice/analyze', 's1', {});
    assert.equal(noFile.status, 400);
    const audio = new FormData();
    audio.append('audio', new Blob([Buffer.from([1, 2, 3])], { type: 'audio/webm' }), 'a.webm');
    const r = await fetch(`${base}/api/interview/practice/analyze`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s1}` }, body: audio });
    assert.equal(r.status, 503, 'AI is off in tests');
  });

  test('the mock interview room is off unless INTERVIEW_MOCK_ENABLED=true', async () => {
    process.env.INTERVIEW_MOCK_ENABLED = '';
    try {
      const status = await api('GET', '/status', 's1');
      assert.equal(status.data.features.mockInterview, false);
      for (const [method, path] of [['GET', '/sessions'], ['POST', '/sessions'], ['GET', '/voice-sample']]) {
        assert.equal((await api(method, path, 's1', method === 'POST' ? { mode: 'practice' } : undefined)).status, 404, `${method} ${path}`);
      }
      assert.equal((await api('GET', '/bank/search?q=cricket', 'v1')).status, 200, 'the rest of the section still works');
    } finally {
      process.env.INTERVIEW_MOCK_ENABLED = 'true';
    }
    assert.equal((await api('GET', '/status', 's1')).data.features.mockInterview, true);
  });

  test('search index: shared lists are read-only, and a bank loaded by another process is picked up', async () => {
    const { getCorpusIndex, searchFamilies } = await import('../lib/interview/corpusIndex.js');
    const idx = await getCorpusIndex();
    const fam = idx.families.find((f) => f.years.length);
    assert.throws(() => fam.years.push(1999), TypeError);

    // A seed run elsewhere doesn't invalidate this process's index; the size check notices it.
    const extra = await InterviewFamily.create({ key: 'test-zorbian', text: 'What is the Zorbian lighthouse treaty?', size: 1, transcriptCount: 1, years: [2024], yearCounts: { 2024: 1 }, firstYear: 2024, lastYear: 2024, boards: [], boardCounts: [], topics: ['ir'], hookTypes: [], hookValues: [], askers: { chairman: 1 }, qtype: 'factual', shelfLife: 'evergreen' });
    try {
      assert.equal((await getCorpusIndex()).families.length, idx.families.length, 'still the same index before the check is due');
      idx.checkedAt = 0;
      await getCorpusIndex(); // starts the check in the background, answers from the current index
      let fresh = idx;
      for (let i = 0; i < 50 && fresh === idx; i++) {
        await new Promise((r) => setTimeout(r, 100));
        fresh = await getCorpusIndex();
      }
      assert.notEqual(fresh, idx, 'rebuilt after the collections changed');
      assert.ok(searchFamilies(fresh, { q: 'zorbian lighthouse' }).items.some((f) => f.id === String(extra._id)));
    } finally {
      await InterviewFamily.deleteOne({ _id: extra._id });
      (await import('../lib/interview/corpusIndex.js')).invalidateCorpusIndex();
    }
  });

  test('search index: a re-seed elsewhere that leaves the sizes unchanged is still picked up', async () => {
    const { getCorpusIndex } = await import('../lib/interview/corpusIndex.js');
    const { default: InterviewMeta } = await import('../models/InterviewMeta.js');
    const idx = await getCorpusIndex();
    await new Promise((r) => setTimeout(r, 20)); // so the meta's updatedAt moves on
    // What a seed from another process does to the meta (same number of transcripts, questions, families).
    await InterviewMeta.updateOne({ key: 'corpus' }, { $set: { 'data.generatedAt': new Date().toISOString() } }, { upsert: true });
    idx.checkedAt = 0;
    await getCorpusIndex();
    let fresh = idx;
    for (let i = 0; i < 50 && fresh === idx; i++) {
      await new Promise((r) => setTimeout(r, 100));
      fresh = await getCorpusIndex();
    }
    assert.notEqual(fresh, idx, 'rebuilt after the meta was rewritten');
  });

  test('AI credits: 15 free uses, then paid ones; none left answers 402; admins never spend', async () => {
    const { spendCredit, refundCredit, addPaidCredits, getBalance, FREE_AI_USES } = await import('../lib/interview/credits.js');
    const { default: User } = await import('../models/User.js');
    const u = await User.findOne({ email: 's2@test.dev' });
    const c = await api('GET', '/credits', 's2');
    assert.equal(c.status, 200);
    assert.equal(c.data.total, FREE_AI_USES);
    assert.deepEqual(c.data.packs.map((p) => [p.credits, p.price]), [[40, 199], [60, 299]]);
    assert.equal(c.data.daf.status, 'none');
    for (let i = 0; i < FREE_AI_USES; i++) assert.equal((await spendCredit(u._id)).from, 'free');
    assert.equal(await spendCredit(u._id), null, 'nothing left');
    await addPaidCredits(u._id, 2);
    const s1 = await spendCredit(u._id);
    assert.equal(s1.from, 'paid');
    await refundCredit(u._id, s1);
    assert.equal((await getBalance(u._id)).paid, 2, 'a failed AI call gives the credit back');
    await spendCredit(u._id);
    await spendCredit(u._id);
    // Before the DAF is verified, AI actions are refused (403); after, with AI off here, they say AI is off.
    const draft = await api('POST', '/answers/draft', 's2', { question: 'Why did you leave your job?' });
    assert.equal(draft.status, 403);
    assert.equal(draft.data.dafStatus, 'none');
    const { setDafCheck } = await import('../lib/interview/dafCheck.js');
    await setDafCheck(u._id, { status: 'verified' });
    assert.equal((await api('POST', '/answers/draft', 's2', { question: 'Why did you leave your job?' })).status, 503);
    assert.equal((await api('POST', '/answers/draft', 's2', { question: '' })).status, 400);
    assert.equal((await api('GET', '/credits', 'admin')).data.admin, true);
  });

  test('DAF verification: upload, admin reviews the file, verify or reject; the file is gone after review', async () => {
    const { default: User } = await import('../models/User.js');
    const { default: DafSubmission } = await import('../models/DafSubmission.js');
    const { default: InterviewProfile } = await import('../models/InterviewProfile.js');
    await User.create({ googleId: 'g-s3', email: 's3@test.dev', name: 's3', fullName: 'Student Three' });
    const s3 = await User.findOne({ email: 's3@test.dev' });
    tokens.s3 = jwt.sign({ userId: s3._id, email: 's3@test.dev' }, 'test-secret');
    const upload = async (bytes, type = 'application/pdf') => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), 'my-daf.pdf');
      const r = await fetch(`${base}/api/interview/daf/submit`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s3}` }, body: form });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const none = (await api('GET', '/daf/status', 's3')).data.daf;
    assert.equal(none.status, 'none');
    assert.equal(none.canUpload, true);
    const first = await upload(Buffer.from('%PDF-1.4 first upload'));
    assert.equal(first.status, 200);
    assert.equal(first.data.daf.status, 'pending');
    assert.equal(first.data.stored, true);
    assert.equal(first.data.aiUnavailable, true, 'the same call reads it with AI (off here), so the student can check the details');
    assert.equal(first.data.daf.canUpload, false);
    const second = await upload(Buffer.from('%PDF-1.4 second upload'));
    assert.equal(second.status, 403, 'one upload per account: not again while it waits');
    assert.equal(second.data.dafLocked, 'pending');
    assert.equal(await DafSubmission.countDocuments({ user: s3._id }), 1);

    assert.equal((await api('GET', '/admin/daf', 's3')).status, 403, 'students cannot review');
    const list = await api('GET', '/admin/daf?status=pending', 'admin');
    const item = list.data.items.find((i) => i.userEmail === 's3@test.dev');
    assert.ok(item);
    assert.equal(item.userName, 'Student Three');
    assert.equal(list.data.counts.pending >= 1, true);
    const file = await fetch(`${base}/api/interview/admin/daf/${item.id}/file`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '%PDF-1.4 first upload');

    assert.equal((await api('POST', `/admin/daf/${item.id}/reject`, 'admin', {})).status, 400, 'a rejection needs a reason');
    assert.equal((await api('POST', `/admin/daf/${item.id}/reject`, 'admin', { reason: 'This is not a DAF' })).status, 200);
    const after = await api('GET', '/daf/status', 's3');
    assert.equal(after.data.daf.status, 'rejected');
    assert.equal(after.data.daf.reason, 'This is not a DAF');
    assert.equal(after.data.daf.canUpload, true, 'a rejection allows one more upload');
    const kept = await fetch(`${base}/api/interview/admin/daf/${item.id}/file`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(kept.status, 200, 'admins can still look at the file after reviewing it');
    assert.equal(Buffer.from(await kept.arrayBuffer()).toString(), '%PDF-1.4 first upload');

    const third = await upload(Buffer.from('%PDF-1.4 the real DAF'));
    assert.equal(third.data.daf.status, 'pending');
    assert.equal((await upload(Buffer.from('%PDF-1.4 one more'))).status, 403, 'and only one');
    // While it waits, the student saves the details; a roll number they type is ignored (it comes only from
    // the DAF, checked by an admin)
    assert.equal((await api('PUT', '/profile', 's3', { hobbies: ['Chess'], homeState: 'Kerala', rollNo: '0814202' })).status, 200);
    assert.equal((await api('GET', '/profile', 's3')).data.profile.rollNo, '', 'students never set the roll number');
    const again = (await api('GET', '/admin/daf?status=pending', 'admin')).data.items.find((i) => i.userEmail === 's3@test.dev');
    assert.equal(again.rollNo, '', 'nothing was read from this file (AI is off here): the admin types it from the DAF');
    // Verifying saves the roll number the admin checked (an old admin page that sends none is refused)
    assert.equal((await api('POST', `/admin/daf/${again.id}/verify`, 'admin', {})).status, 400);
    assert.equal((await api('POST', `/admin/daf/${again.id}/verify`, 'admin', { rollNo: '12345' })).status, 400, 'a roll number has 7 digits');
    assert.equal((await api('POST', `/admin/daf/${again.id}/verify`, 'admin', { rollNo: '0811049' })).status, 200);
    assert.equal((await api('POST', `/admin/daf/${again.id}/verify`, 'admin', { rollNo: '0811049' })).status, 409, 'already reviewed');
    assert.equal((await api('GET', '/credits', 's3')).data.daf.status, 'verified');
    assert.equal((await api('GET', '/profile', 's3')).data.profile.rollNo, '0811049', "the admin's roll number replaces the student's");
    assert.equal((await api('POST', '/practice/attempts', 's3', { question: 'Why civil services?', metrics: { wpm: 120 } })).status, 200, 'practice unlocks');
    // Once verified the student can't change it
    assert.equal((await api('PUT', '/profile', 's3', { hobbies: ['Chess'], rollNo: '0814202' })).status, 403);
    assert.equal((await api('GET', '/profile', 's3')).data.profile.rollNo, '0811049');

    // Changing a verified DAF: Rs 50 first, then a re-upload that is verified again
    const reupload = await upload(Buffer.from('%PDF-1.4 updated'));
    assert.equal(reupload.status, 402, 'changing a verified DAF is paid for first');
    assert.equal(reupload.data.needPayment, true);
    assert.equal(reupload.data.price, 50);
    const st = (await api('GET', '/daf/status', 's3')).data.daf;
    assert.equal(st.canUpload, false);
    assert.equal(st.changeNeedsPayment, true);
    assert.equal((await api('PUT', '/profile', 's3', { hobbies: ['Kabaddi'] })).status, 403, 'no free edits either');

    const { grantDafUpload } = await import('../lib/interview/dafCheck.js');
    await grantDafUpload(s3._id); // what a paid Rs 50 order does
    const change = await upload(Buffer.from('%PDF-1.4 my new DAF'));
    assert.equal(change.status, 200);
    assert.equal(change.data.change, true);
    assert.equal(change.data.daf.status, 'verified', 'still verified while the new DAF waits');
    assert.equal(change.data.daf.change.status, 'pending');
    const saved = await api('PUT', '/profile', 's3', { hobbies: ['Kabaddi'], homeState: 'Haryana', rollNo: '0814202' });
    assert.equal(saved.data.changePending, true);
    assert.deepEqual((await api('GET', '/profile', 's3')).data.profile.hobbies, ['Chess'], 'the current DAF stays until the new one is verified');
    assert.equal((await upload(Buffer.from('%PDF-1.4 another'))).status, 403, 'one change at a time');

    const waiting = (await api('GET', '/admin/daf?status=pending', 'admin')).data.items.find((i) => i.userEmail === 's3@test.dev');
    assert.equal(waiting.kind, 'change');
    assert.equal(waiting.rollNo, '0811049', "a changed DAF can't carry a roll number the student typed");
    assert.equal((await api('POST', `/admin/daf/${waiting.id}/verify`, 'admin', { rollNo: '0811049' })).status, 200);
    const now = (await api('GET', '/profile', 's3')).data.profile;
    assert.deepEqual(now.hobbies, ['Kabaddi'], 'verified: the new details replace the old');
    assert.equal(now.homeState, 'Haryana');
    assert.equal(now.rollNo, '0811049', 'the roll number is still the one the admin checked');
    assert.equal((await api('GET', '/daf/status', 's3')).data.daf.changeNeedsPayment, true, 'the next change is paid for again');
  });

  test('UPSC interview schedule: admins see the match for each upload; students see only their own row, once verified', async () => {
    const { parseScheduleText, replaceSchedule, normalizeRoll, firstNameOf } = await import('../lib/interview/schedule.js');
    const rows = parseScheduleText([
      'Sl. No. Interview Date \tDay \tSession Reporting Time Roll No. \tName',
      '1 07-Dec-2026 Monday \tForenoon 09:00 HRS \t0811049 DIPANSHU GUPTA',
      '2 07-Dec-2026 Monday \tAfternoon 13:00 HRS \t0814202 NIKITA',
      '116 09-Dec-2026 Wednesday Forenoon 09:00 HRS \t0103665 RISHAV JAIN',
      '-- 1 of 114 --',
      'ATEL'
    ].join('\n'));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { sl: 1, date: '2026-12-07', day: 'Monday', session: 'Forenoon', reportingTime: '09:00', roll: '0811049', name: 'DIPANSHU GUPTA' });
    assert.equal(rows[2].date, '2026-12-09');
    assert.equal(normalizeRoll('811049'), '0811049', 'a dropped leading zero is put back');
    assert.equal(firstNameOf('DIPANSHU GUPTA'), 'Dipanshu');
    const info = await replaceSchedule(rows, 'schedule.pdf');
    assert.equal(info.count, 3);
    assert.equal(info.firstDate, '2026-12-07');

    // s3 (verified, roll 0811049 from the DAF test above) sees their own row
    const mine = await api('GET', '/my-interview', 's3');
    assert.equal(mine.data.found, true);
    assert.equal(mine.data.name, 'DIPANSHU GUPTA');
    assert.equal(mine.data.reportingAt, '2026-12-07T03:30:00.000Z', '09:00 Indian time');
    assert.equal((await api('GET', '/my-interview', 's2')).data.found, false, 'not verified: nothing');
    assert.equal((await api('GET', '/my-interview?roll=0814202', 's2')).data.found, false, 'and no looking up other roll numbers');

    // A verified student with no details saved yet may save them, but never a roll number of their choosing
    const { default: User } = await import('../models/User.js');
    const { setDafCheck } = await import('../lib/interview/dafCheck.js');
    const { default: InterviewProfile } = await import('../models/InterviewProfile.js');
    await User.create({ googleId: 'g-s4', email: 's4@test.dev', name: 's4' });
    const s4 = await User.findOne({ email: 's4@test.dev' });
    tokens.s4 = jwt.sign({ userId: s4._id, email: 's4@test.dev' }, 'test-secret');
    await setDafCheck(s4._id, { status: 'verified', reviewedAt: new Date() });
    assert.equal((await api('PUT', '/profile', 's4', { hobbies: ['Chess'], rollNo: '0814202' })).status, 200);
    assert.equal((await api('GET', '/profile', 's4')).data.profile.rollNo, '', 'the roll number was ignored');
    assert.equal((await api('GET', '/my-interview', 's4')).data.found, false);
    // and a roll number nobody checked (e.g. saved before this rule) shows nothing either
    await InterviewProfile.updateOne({ user: s4._id }, { $set: { rollNo: '0814202' } });
    const none = (await api('GET', '/my-interview', 's4')).data;
    assert.equal(none.found, false, 'only an admin-checked roll number counts');
    assert.equal(none.noRoll, true, 'so the student is offered to add one');

    // Adding the roll number later: free, with proof, checked by an admin
    const sendRoll = async (who, rollNo, proof = '%PDF-1.4 e-summon letter') => {
      const form = new FormData();
      form.append('rollNo', rollNo);
      if (proof) form.append('file', new Blob([Buffer.from(proof)], { type: 'application/pdf' }), 'e-summon.pdf');
      const r = await fetch(`${base}/api/interview/daf/roll`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}` }, body: form });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    assert.equal((await api('GET', '/daf/status', 's4')).data.daf.roll.canRequest, true);
    await setDafCheck(s4._id, { status: 'pending' });
    assert.equal((await sendRoll('s4', '0814202')).status, 403, 'only once the DAF is verified');
    await setDafCheck(s4._id, { status: 'verified' });
    assert.equal((await sendRoll('s4', '12345')).status, 400, 'a roll number has 7 digits');
    assert.equal((await sendRoll('s4', '0814202', null)).status, 400, 'proof is required');
    const asked = await sendRoll('s4', '0814202');
    assert.equal(asked.status, 200);
    assert.equal(asked.data.daf.roll.claim.status, 'pending');
    assert.equal(asked.data.daf.roll.canRequest, false);
    assert.equal((await sendRoll('s4', '0814202')).status, 409, 'one at a time');
    assert.equal((await api('GET', '/my-interview', 's4')).data.found, false, 'nothing changes until an admin checks it');
    // a DAF upload while it waits doesn't remove it
    const dafForm = new FormData();
    dafForm.append('file', new Blob([Buffer.from('%PDF-1.4 a DAF')], { type: 'application/pdf' }), 'daf.pdf');
    await fetch(`${base}/api/interview/daf/submit`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s4}` }, body: dafForm });
    const claimItem = () => api('GET', '/admin/daf?status=pending', 'admin').then((r) => r.data.items.find((i) => i.userEmail === 's4@test.dev' && i.kind === 'roll'));
    const claim = await claimItem();
    assert.ok(claim, 'still waiting for the admin');
    assert.equal(claim.rollNo, '0814202');
    assert.equal(claim.schedule.found, true);
    assert.equal(claim.schedule.name, 'NIKITA');
    const proof = await fetch(`${base}/api/interview/admin/daf/${claim.id}/file`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(Buffer.from(await proof.arrayBuffer()).toString(), '%PDF-1.4 e-summon letter', 'the admin sees the proof');
    assert.equal((await api('POST', `/admin/daf/${claim.id}/verify`, 'admin', { rollNo: '' })).status, 400, 'approving needs the roll number');
    assert.equal((await api('POST', `/admin/daf/${claim.id}/reject`, 'admin', { reason: 'The proof is unreadable' })).status, 200);
    const afterReject = (await api('GET', '/daf/status', 's4')).data.daf;
    assert.equal(afterReject.status, 'verified', 'a rejected roll number leaves the DAF verified');
    assert.equal(afterReject.roll.claim.status, 'rejected');
    assert.equal(afterReject.roll.claim.reason, 'The proof is unreadable');
    assert.equal(afterReject.roll.canRequest, true, 'and they can ask again, free');
    assert.equal((await sendRoll('s4', '0814202', '%PDF-1.4 admit card')).status, 200);
    assert.equal((await api('POST', `/admin/daf/${(await claimItem()).id}/verify`, 'admin', { rollNo: '0814202' })).status, 200);
    const mineNow = (await api('GET', '/my-interview', 's4')).data;
    assert.equal(mineNow.found, true, 'approved: their interview date shows');
    assert.equal(mineNow.name, 'NIKITA');
    const st4 = (await api('GET', '/daf/status', 's4')).data.daf.roll;
    assert.equal(st4.checked, true);
    assert.equal(st4.canRequest, false, 'nothing more to add');
    assert.equal((await sendRoll('s4', '0811049')).status, 409, "and they can't swap it for another");

    // admins check a roll number as they type it
    const look = await api('GET', '/admin/schedule/roll/814202', 'admin');
    assert.equal(look.data.found, true);
    assert.equal(look.data.name, 'NIKITA');
    assert.equal((await api('GET', '/admin/schedule/roll/0999999', 'admin')).data.found, false);
    assert.equal((await api('GET', '/admin/schedule/roll/0814202', 's4')).status, 403, 'students cannot look anyone up');

    // the admin list shows the match (or that a roll number is not in the schedule)
    const verified = (await api('GET', '/admin/daf?status=verified', 'admin')).data;
    const s3 = verified.items.find((i) => i.userEmail === 's3@test.dev');
    assert.equal(s3.schedule.found, true);
    assert.equal(s3.schedule.session, 'Forenoon');
    assert.equal(verified.schedule.count, 3);
    assert.equal((await api('GET', '/admin/schedule', 's1')).status, 403, 'admins only');
  });

  test('a DAF filled in by hand goes to verification like an upload; its roll number is optional and needs a proof', async () => {
    const { default: User } = await import('../models/User.js');
    await User.create({ googleId: 'g-s5', email: 's5@test.dev', name: 's5', fullName: 'Student Five' });
    const s5 = await User.findOne({ email: 's5@test.dev' });
    tokens.s5 = jwt.sign({ userId: s5._id, email: 's5@test.dev' }, 'test-secret');
    const sendForm = async (fields, rollNo = '', proof = null) => {
      const form = new FormData();
      form.append('fields', JSON.stringify(fields));
      if (rollNo) form.append('rollNo', rollNo);
      if (proof) form.append('file', new Blob([Buffer.from(proof)], { type: 'application/pdf' }), 'admit-card.pdf');
      const r = await fetch(`${base}/api/interview/daf/form`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s5}` }, body: form });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const details = { homeState: 'Bihar', hobbies: ['Chess'], education: [{ degree: 'B.Tech', discipline: 'Civil Engineering', institution: 'NIT Patna' }] };
    assert.equal((await sendForm({})).status, 400, 'an empty form is not sent');
    const noProof = await sendForm(details, '0103665');
    assert.equal(noProof.status, 400, 'a roll number needs a proof');
    assert.equal(noProof.data.needProof, true);

    // Without a roll number: no proof needed
    const first = await sendForm(details);
    assert.equal(first.status, 200);
    assert.equal(first.data.daf.status, 'pending', 'it waits for verification like an upload');
    assert.deepEqual((await api('GET', '/profile', 's5')).data.profile.hobbies, ['Chess'], 'the details are saved');
    assert.equal((await sendForm(details)).status, 403, 'not again while it waits');
    const item = (await api('GET', '/admin/daf?status=pending', 'admin')).data.items.find((i) => i.userEmail === 's5@test.dev');
    assert.equal(item.source, 'form');
    assert.equal(item.hasFile, false, 'no file: the admin reads the details');
    assert.equal(item.fields.homeState, 'Bihar');
    assert.equal(item.fields.education[0].institution, 'NIT Patna');
    assert.equal(item.rollNo, '');
    assert.equal((await api('POST', `/admin/daf/${item.id}/reject`, 'admin', { reason: 'Please add your roll number with a proof' })).status, 200);

    // Again, with a roll number and its proof
    const second = await sendForm({ ...details, hobbies: ['Chess', 'Cricket'] }, '0103665', '%PDF-1.4 admit card');
    assert.equal(second.status, 200);
    const again = (await api('GET', '/admin/daf?status=pending', 'admin')).data.items.find((i) => i.userEmail === 's5@test.dev');
    assert.equal(again.rollNo, '0103665');
    assert.equal(again.hasFile, true);
    assert.equal(again.schedule.found, true);
    assert.equal(again.schedule.name, 'RISHAV JAIN');
    const proof = await fetch(`${base}/api/interview/admin/daf/${again.id}/file`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(Buffer.from(await proof.arrayBuffer()).toString(), '%PDF-1.4 admit card', 'the admin sees the proof');
    assert.equal((await api('GET', '/profile', 's5')).data.profile.rollNo, '', 'nothing is checked yet');
    assert.equal((await api('POST', `/admin/daf/${again.id}/verify`, 'admin', { rollNo: '0103665' })).status, 200);
    assert.equal((await api('GET', '/credits', 's5')).data.daf.status, 'verified');
    assert.equal((await api('GET', '/my-interview', 's5')).data.name, 'RISHAV JAIN', 'their interview date shows');
    assert.deepEqual((await api('GET', '/profile', 's5')).data.profile.hobbies, ['Chess', 'Cricket']);
    // the filled-in DAF was their one submission: changing it now is paid, like after an upload
    const reupload = await sendForm(details);
    assert.equal(reupload.status, 402);
    assert.equal(reupload.data.needPayment, true);
  });

  test('admins delete entries; a verified DAF whose details were never filled in can be filled in, free', async () => {
    const { default: User } = await import('../models/User.js');
    await User.create({ googleId: 'g-s6', email: 's6@test.dev', name: 's6', fullName: 'Student Six' });
    const s6 = await User.findOne({ email: 's6@test.dev' });
    tokens.s6 = jwt.sign({ userId: s6._id, email: 's6@test.dev' }, 'test-secret');
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('%PDF-1.4 s6 daf')], { type: 'application/pdf' }), 'daf.pdf');
      const r = await fetch(`${base}/api/interview/daf/submit`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s6}` }, body: form });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const entry = (status) => api('GET', `/admin/daf?status=${status}`, 'admin').then((r) => r.data.items.find((i) => i.userEmail === 's6@test.dev'));

    // AI is off (as on the live site now): the upload waits with no details filled in
    assert.equal((await upload()).status, 200);
    const waiting = await entry('pending');
    assert.equal(waiting.detailsMissing, true, 'the admin sees the details are not filled in yet');
    // Deleting a waiting entry undoes it: the student can send their DAF again
    assert.equal((await api('DELETE', `/admin/daf/${waiting.id}`, 's1')).status, 403, 'admins only');
    assert.equal((await api('DELETE', `/admin/daf/${waiting.id}`, 'admin')).status, 200);
    assert.equal(await entry('pending'), undefined, 'gone from the list');
    const after = (await api('GET', '/daf/status', 's6')).data.daf;
    assert.equal(after.status, 'none');
    assert.equal(after.canUpload, true, 'they can send it again');

    // Verified without any details: the student is not stuck - they fill them in, free, once
    assert.equal((await upload()).status, 200);
    assert.equal((await api('POST', `/admin/daf/${(await entry('pending')).id}/verify`, 'admin', { rollNo: '' })).status, 200);
    assert.equal((await api('GET', '/credits', 's6')).data.daf.status, 'verified');
    assert.equal((await api('GET', '/predictions', 's6')).data.needsProfile, true, 'nothing to predict from yet');
    const filled = await api('PUT', '/profile', 's6', { homeState: 'Kerala', hobbies: ['Chess'], rollNo: '0811049' });
    assert.equal(filled.status, 200);
    assert.deepEqual(filled.data.profile.hobbies, ['Chess']);
    assert.equal(filled.data.profile.rollNo, '', 'still no typed roll number');
    assert.equal((await api('PUT', '/profile', 's6', { homeState: 'Goa' })).data.needReupload, true, 'then it is locked like any verified DAF');

    // The file stays viewable; deleting a reviewed entry keeps the student verified
    const done = await entry('verified');
    assert.equal(done.hasFile, true);
    assert.equal((await fetch(`${base}/api/interview/admin/daf/${done.id}/file`, { headers: { Authorization: `Bearer ${tokens.admin}` } })).status, 200);
    assert.equal((await api('DELETE', `/admin/daf/${done.id}`, 'admin')).status, 200);
    assert.equal(await entry('verified'), undefined);
    assert.equal((await api('GET', '/credits', 's6')).data.daf.status, 'verified', 'deleting the record does not undo the verification');
    assert.equal((await api('DELETE', `/admin/daf/${done.id}`, 'admin')).status, 404);
  });

  test('a DAF sent while AI was off can fill in the details later from the stored upload', async () => {
    const { default: User } = await import('../models/User.js');
    const { default: DafSubmission } = await import('../models/DafSubmission.js');
    await User.create({ googleId: 'g-s7', email: 's7@test.dev', name: 's7' });
    const s7 = await User.findOne({ email: 's7@test.dev' });
    tokens.s7 = jwt.sign({ userId: s7._id, email: 's7@test.dev' }, 'test-secret');
    assert.equal((await api('POST', '/daf/read', 's7')).data.noFile, true, 'nothing uploaded yet');
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 s7 daf')], { type: 'application/pdf' }), 'daf.pdf');
    const up = await fetch(`${base}/api/interview/daf/submit`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s7}` }, body: form });
    assert.equal((await up.json()).aiUnavailable, true, 'AI is off: not read when sent');
    assert.equal((await api('GET', '/daf/status', 's7')).data.daf.detailsFromFile, true, 'the upload can still fill in the details');
    const off = await api('POST', '/daf/read', 's7');
    assert.equal(off.status, 503);
    assert.equal(off.data.aiUnavailable, true);

    // Once AI has read it (kept with the upload), coming back to it is free and needs no AI
    await DafSubmission.updateOne({ user: s7._id }, { $set: { fields: { homeState: 'Assam', hobbies: ['Music'], rollNo: '0811049' }, unsure: ['hobbies'] } });
    const read = await api('POST', '/daf/read', 's7');
    assert.equal(read.status, 200);
    assert.equal(read.data.fields.homeState, 'Assam');
    assert.deepEqual(read.data.unsure, ['hobbies']);
    // the student checks and saves them
    assert.equal((await api('PUT', '/profile', 's7', read.data.fields)).status, 200);
    assert.equal((await api('GET', '/profile', 's7')).data.profile.homeState, 'Assam');
    assert.equal((await api('GET', '/daf/status', 's7')).data.daf.detailsFromFile, false);
    assert.equal((await api('POST', '/daf/read', 's7')).status, 409, 'already filled in');
  });

  test('recording feedback: 2 credits for any answer up to 3 minutes, all or none', async () => {
    const { spendCredits, refundCredits, getBalance, feedbackCreditsFor } = await import('../lib/interview/credits.js');
    const { default: User } = await import('../models/User.js');
    const { default: InterviewProfile } = await import('../models/InterviewProfile.js');
    const u = await User.findOne({ email: 'v1@test.dev' });
    const c = (await api('GET', '/credits', 'v1')).data;
    assert.equal(c.feedbackCredits, 2);
    assert.equal(c.feedbackLongCredits, 2);
    assert.equal(c.feedbackShortSeconds, 90);
    assert.equal(c.feedbackMaxSeconds, 180);
    assert.equal(feedbackCreditsFor(45), 2);
    assert.equal(feedbackCreditsFor(90), 2);
    assert.equal(feedbackCreditsFor(91), 2);
    assert.equal(feedbackCreditsFor(180), 2);
    assert.equal(feedbackCreditsFor(undefined), 2, 'a recording that does not say how long it is counts as long');
    await InterviewProfile.updateOne({ user: u._id }, { $set: { 'credits.freeUsed': 14, 'credits.paid': 0 } });
    assert.equal((await spendCredits(u._id, 2))?.from ?? null, null, 'one credit left is not enough');
    assert.equal((await getBalance(u._id)).total, 1, 'and nothing was taken');
    await InterviewProfile.updateOne({ user: u._id }, { $set: { 'credits.paid': 1 } });
    const spent = await spendCredits(u._id, 2);
    assert.equal(spent.parts.length, 2, 'the last free one and a bought one');
    assert.equal((await getBalance(u._id)).total, 0);
    await refundCredits(u._id, spent);
    assert.equal((await getBalance(u._id)).total, 2, 'both come back when feedback fails');
    await InterviewProfile.updateOne({ user: u._id }, { $set: { 'credits.freeUsed': 0, 'credits.paid': 0 } });
  });

  test('notes: admins draft from sources and publish; students see published notes, marked "for you" from the DAF', async () => {
    const { default: InterviewNote } = await import('../models/InterviewNote.js');
    assert.equal((await api('GET', '/admin/notes', 's1')).status, 403);
    assert.equal((await api('POST', '/admin/notes', 's1', { topic: 'Green hydrogen', urls: ['https://pib.gov.in/x'] })).status, 403);
    assert.equal((await api('POST', '/admin/notes', 'admin', { topic: 'Green hydrogen' })).status, 400, 'a draft needs links or pasted text');
    const off = await api('POST', '/admin/notes', 'admin', { topic: 'Green hydrogen', urls: ['https://pib.gov.in/x'] });
    assert.equal(off.status, 503);
    assert.equal(off.data.aiUnavailable, true);

    const body = (title, extra = {}) => ({ title, why: 'In the news.', sections: [{ heading: 'Background', points: ['A point.'] }], questions: [{ q: 'What is it?', type: 'factual', answer: 'An answer.' }], likelyFor: ['Engineers'], keywords: ['GH2'], ...extra });
    const draft = await InterviewNote.create({ slug: 'green-hydrogen-2026-11', status: 'draft', topic: 'Green hydrogen', category: 'environment', tags: ['engineering', 'energy'], en: body('Green hydrogen'), hi: body('हरित हाइड्रोजन') });
    await InterviewNote.create({ slug: 'monsoon-2026-11', status: 'published', publishedAt: new Date(), topic: 'Monsoon', category: 'environment', tags: ['agriculture'], en: body('Monsoon'), hi: body('मानसून') });

    let list = await api('GET', '/notes', 's2');
    assert.deepEqual(list.data.notes.map((n) => n.slug), ['monsoon-2026-11'], 'drafts stay hidden');
    assert.equal((await api('GET', '/notes/green-hydrogen-2026-11', 's2')).status, 404);
    assert.equal((await api('GET', '/notes/green-hydrogen-2026-11', 'admin')).status, 200, 'admins can preview drafts');
    assert.equal((await api('GET', '/admin/notes', 'admin')).data.notes.length, 2);

    const pub = await api('PATCH', `/admin/notes/${draft._id}`, 'admin', { status: 'published', en: body('Green hydrogen in India', { sections: [{ heading: 'Background', points: ['  Edited   point. '] }] }) });
    assert.equal(pub.status, 200);
    assert.equal(pub.data.note.en.sections[0].points[0], 'Edited point.');
    assert.equal(pub.data.note.status, 'published');
    assert.equal((await api('PUT', '/profile', 's2', { education: [{ degree: 'B.Tech', discipline: 'Mechanical', institution: 'NIT Trichy' }] })).status, 200);
    list = await api('GET', '/notes', 's2');
    const gh = list.data.notes.find((n) => n.slug === 'green-hydrogen-2026-11');
    assert.equal(gh.title, 'Green hydrogen in India');
    assert.equal(gh.forYou, true, 'B.Tech -> engineering');
    assert.equal(list.data.notes.find((n) => n.slug === 'monsoon-2026-11').forYou, false);
    const hi = await api('GET', '/notes/green-hydrogen-2026-11?lang=hi', 's2');
    assert.equal(hi.data.note.title, 'हरित हाइड्रोजन');
    assert.equal(hi.data.note.lang, 'hi');

    assert.equal((await api('PATCH', `/admin/notes/${draft._id}`, 'admin', { en: { title: '' } })).status, 400);
    assert.equal((await api('DELETE', `/admin/notes/${draft._id}`, 'admin')).status, 200);
    assert.equal((await api('GET', '/notes/green-hydrogen-2026-11', 's2')).status, 404);
  });

  test('guide: students see the published copy without hidden questions; preparing one needs AI', async () => {
    const { default: InterviewGuide } = await import('../models/InterviewGuide.js');
    assert.equal((await api('GET', '/guide', 's1')).data.status, 'none');
    assert.equal((await api('POST', '/admin/guide/generate', 's1')).status, 403);
    assert.equal((await api('POST', '/admin/guide/generate', 'admin')).status, 503);
    const entry = (key, text, extra = {}) => ({ key, text, qtype: 'personal', timesAsked: 10, years: [2023], en: { tests: 'Motivation.', structure: ['Start with a moment.'], dos: ['Be honest.'], donts: ['Cliches.'] }, hi: { tests: 'प्रेरणा।', structure: ['एक अनुभव से शुरू करें।'], dos: [], donts: [] }, ...extra });
    await InterviewGuide.create({ key: 'top100', status: 'ready', corpus: { interviews: 3, years: [2023, 2024] }, entries: [entry('q:0000000000000001', 'Why civil services?', { textHi: 'सिविल सेवा क्यों?' }), entry('q:0000000000000002', 'Tell us about yourself.')] });
    assert.equal((await api('GET', '/guide', 's1')).data.status, 'none', 'prepared but not published');
    assert.equal((await api('GET', '/admin/guide', 'admin')).data.guide.entries.length, 2);

    assert.equal((await api('PATCH', '/admin/guide', 'admin', { entries: [{ key: 'q:0000000000000002', hidden: true }], publish: true })).status, 200);
    const en = await api('GET', '/guide', 's1');
    assert.equal(en.data.status, 'published');
    assert.deepEqual(en.data.entries.map((e) => e.text), ['Why civil services?']);
    assert.equal(en.data.preview, undefined, 'signed-in students get the whole guide');
    const visitor = await (await fetch(`${base}/api/interview/guide`)).json();
    assert.equal(visitor.preview, true, 'visitors get a preview');
    assert.equal(visitor.total, 1);
    assert.ok(visitor.entries.length <= 5);
    const hi = await api('GET', '/guide?lang=hi', 's1');
    assert.equal(hi.data.entries[0].text, 'सिविल सेवा क्यों?');
    assert.equal(hi.data.entries[0].guide.tests, 'प्रेरणा।');

    // Edits change the working copy; students see them after the next publish.
    assert.equal((await api('PATCH', '/admin/guide', 'admin', { entries: [{ key: 'q:0000000000000001', text: 'Why do you want to join the civil services?' }] })).status, 200);
    assert.equal((await api('GET', '/guide', 's1')).data.entries[0].text, 'Why civil services?');
    assert.equal((await api('PATCH', '/admin/guide', 'admin', { entries: [{ key: 'q:0000000000000001', en: { tests: '' } }] })).status, 400);
    assert.equal((await api('PATCH', '/admin/guide', 'admin', { publish: true })).status, 200);
    assert.equal((await api('GET', '/guide', 's1')).data.entries[0].text, 'Why do you want to join the civil services?');
    assert.equal((await api('PATCH', '/admin/guide', 'admin', { publish: false })).status, 200);
    assert.equal((await api('GET', '/guide', 's1')).data.status, 'none');
  });
}
