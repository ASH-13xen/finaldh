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

  test('DAF upload and voice transcription explain that AI is off', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'daf.pdf');
    const res = await fetch(`${base}/api/interview/profile/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.s1}` }, body: form });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).aiUnavailable, true);

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
}
