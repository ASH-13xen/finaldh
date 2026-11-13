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

    for (const [key, email] of [['admin', 'admin@test.dev'], ['s1', 's1@test.dev'], ['s2', 's2@test.dev']]) {
      const u = await User.create({ googleId: `g-${key}`, email, name: key, fullName: key });
      tokens[key] = jwt.sign({ userId: u._id, email }, 'test-secret');
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

  test('requests without a token are refused', async () => {
    const res = await fetch(`${base}/api/interview/status`);
    assert.equal(res.status, 401);
  });

  test('before launch (INTERVIEW_SECTION_LIVE unset) only admins can use the section', async () => {
    process.env.INTERVIEW_SECTION_LIVE = '';
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
    const r = await api('GET', '/bank/search?q=net%20neutrality', 's1');
    assert.equal(r.status, 200);
    assert.equal(r.data.items[0].timesAsked, 2);
    assert.match(r.data.items[0].text, /net neutrality/i);

    const all = await api('GET', '/bank/search?sort=asked', 's1');
    assert.equal(all.data.items[0].timesAsked, 4, 'the most asked question first');

    const byYear = await api('GET', '/bank/search?q=hydrogen&year=2023', 's1');
    assert.equal(byYear.data.total, 0);
    const byBoard = await api('GET', `/bank/search?q=green%20hydrogen&board=${encodeURIComponent('B.B. Swain')}`, 's1');
    assert.equal(byBoard.data.total, 1);

    const facets = await api('GET', '/bank/facets', 's1');
    assert.ok(facets.data.boards.some((b) => b.value === 'Sheel Vardhan Singh'));
    const trends = await api('GET', '/bank/trends', 's1');
    assert.equal(trends.status, 200);
    assert.ok(trends.data.mostAsked.length > 0);
  });

  test('a family shows where it was asked, how the board followed up, and the full transcript opens', async () => {
    const s = await api('GET', '/bank/search?q=favourite%20cricket%20player', 's1');
    const fam = await api('GET', `/bank/families/${s.data.items[0].id}`, 's1');
    assert.equal(fam.status, 200);
    assert.equal(fam.data.asked.length, 2);
    assert.ok(fam.data.asked.some((a) => a.followedBy === 'Why him and not Kohli?'));
    assert.ok(fam.data.asked.some((a) => /Dhoni/.test(a.note)));
    const t = await api('GET', `/bank/transcripts/${fam.data.asked[0].transcriptId}`, 's1');
    assert.equal(t.status, 200);
    assert.ok(t.data.questions.length >= 7);
    assert.equal(t.data.transcript.rawText, undefined, 'raw text is admin-only');
    const bad = await api('GET', '/bank/families/not-an-id', 's1');
    assert.equal(bad.status, 404);
  });

  test('predictions need a DAF, then cite past evidence for each DAF item', async () => {
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
    assert.ok(direct.evidence[0].timesAsked >= 2);
    assert.match(direct.basisNote, /Cricket/);
    assert.ok(['high', 'medium', 'low'].includes(direct.likelihood));
    const gaming = p.data.groups.find((g) => g.key === 'hobby:gaming');
    assert.ok(gaming.predictions.some((x) => /gaming/i.test(x.question)));

    const again = await api('GET', '/predictions', 's1');
    assert.equal(again.data.cached, true, 'unchanged DAF -> saved predictions');
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

  test('the DAF is filled in on the form only; voice transcription explains that AI is off', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'daf.pdf');
    const res = await fetch(`${base}/api/interview/profile/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s1}` }, body: form });
    assert.equal(res.status, 404, 'there is no DAF file upload any more');

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
    const un1 = await api('GET', '/bank/search?q=UN%20relevant', 's1');
    const un2 = await api('GET', '/bank/search?q=UN%20reform', 's1');
    const a = un1.data.items.find((f) => /relevant/.test(f.text));
    const b = un2.data.items.find((f) => /reform/.test(f.text));
    assert.notEqual(a.id, b.id);
    assert.equal((await api('POST', '/admin/families/merge', 'admin', { targetId: a.id, sourceIds: [b.id] })).status, 200);
    const merged = await api('GET', `/bank/families/${a.id}`, 's1');
    assert.equal(merged.data.asked.length, 2);

    // Fixing a transcript's board updates the family statistics
    const hy = await api('GET', '/bank/search?q=green%20hydrogen', 's1');
    const famBefore = await api('GET', `/bank/families/${hy.data.items[0].id}`, 's1');
    const swainTranscript = famBefore.data.asked.find((x) => x.board === 'B.B. Swain').transcriptId;
    assert.equal((await api('PATCH', `/admin/transcripts/${swainTranscript}`, 'admin', { board: 'Shri Dinesh Dasa sir', reviewed: true })).status, 200);
    const famAfter = await api('GET', `/bank/families/${hy.data.items[0].id}`, 's1');
    assert.ok(famAfter.data.family.boards.includes('Dinesh Dasa'));

    // Hiding a question removes it from the bank
    const q = t.data.questions.find((x) => /online gaming/i.test(x.text)) || t.data.questions[0];
    assert.equal((await api('PATCH', `/admin/questions/${q.id}`, 'admin', { hidden: true })).status, 200);
    if (/online gaming/i.test(q.text)) {
      const gone = await api('GET', '/bank/search?q=online%20gaming%20regulated', 's1');
      assert.ok(!gone.data.items.some((f) => /online gaming be regulated/i.test(f.text)));
    }
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
}
