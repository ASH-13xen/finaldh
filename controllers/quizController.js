// quizController.js — the student-facing Quiz feature.
//
// A subject's Question Bank is one flat pool of MCQs tagged by topic. The student picks a MODE
// and an attempt snapshots the exact question set + order:
//   topic  -> every question for one topic, in order
//   random -> a random sample (size 10/25/50/100)
//   all    -> the whole pool in order, resumable
// In every mode the student picks an option and hits "Check" to reveal the answer + why.
//
// Separate from the MCQ Test feature (mcqController.js). Secrets (correctKey / whyCorrect) are
// never sent with the question list — only from POST /answer (on Check) and the /complete review.

import mongoose from 'mongoose';
import QuizQuestion from '../models/QuizQuestion.js';
import QuizAttempt from '../models/QuizAttempt.js';
import QuizReport from '../models/QuizReport.js';

const RANDOM_SIZES = [10, 25, 50, 100];
const DEFAULT_SUBJECT = 'Geography';
const MISC_TOPIC = 'Miscellaneous';
const PAGE_MAX = 50;

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const firstUnansweredIndex = (attempt) => {
  const done = new Set(attempt.responses.map((r) => r.index));
  for (let i = 0; i < attempt.questionIds.length; i++) if (!done.has(i)) return i;
  return attempt.questionIds.length; // all answered
};

// Progress payload. Answers are revealed per question as the student checks them (in every
// mode), so a resumed attempt gets its already-checked answers back too.
const progress = (attempt) => ({
  attemptId: attempt._id,
  subject: attempt.subject,
  mode: attempt.mode,
  topic: attempt.topic,
  status: attempt.status,
  totalQuestions: attempt.totalQuestions,
  answeredCount: attempt.responses.length,
  nextIndex: firstUnansweredIndex(attempt),
  responses: attempt.responses.map((r) => ({
    index: r.index,
    selectedKey: r.selectedKey,
    correctKey: r.correctKey,
    isCorrect: r.isCorrect
  }))
});

const loadOwnedAttempt = async (attemptId, userId) => {
  if (!isValidId(attemptId)) return null;
  return QuizAttempt.findOne({ _id: attemptId, user: userId });
};

// GET /api/quiz/topics?subject=Geography
export const listTopics = async (req, res) => {
  try {
    const subject = req.query.subject || DEFAULT_SUBJECT;
    const agg = await QuizQuestion.aggregate([
      { $match: { subject } },
      {
        $group: {
          _id: '$topic',
          total: { $sum: 1 },
          ready: { $sum: { $cond: [{ $eq: ['$aiStatus', 'done'] }, 1, 0] } }
        }
      }
    ]);

    const topics = agg
      .map((t) => ({ topic: t._id || MISC_TOPIC, total: t.total, ready: t.ready }))
      .sort((a, b) => {
        const am = a.topic === MISC_TOPIC ? 1 : 0;
        const bm = b.topic === MISC_TOPIC ? 1 : 0;
        return am - bm || a.topic.localeCompare(b.topic);
      });

    res.json({
      subject,
      topics,
      total: topics.reduce((s, t) => s + t.total, 0),
      randomSizes: RANDOM_SIZES
    });
  } catch (err) {
    console.error('quiz listTopics error:', err);
    res.status(500).json({ error: 'Failed to load topics' });
  }
};

// POST /api/quiz/attempts  { subject, mode, topic?, size? }
export const startAttempt = async (req, res) => {
  try {
    const subject = req.body?.subject || DEFAULT_SUBJECT;
    const mode = req.body?.mode;
    if (!['topic', 'random', 'all'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be topic, random or all' });
    }

    let topic = null;

    const findResumable = (extra) =>
      QuizAttempt.findOne({ user: req.userId, subject, mode, status: 'in-progress', ...extra }).sort({ createdAt: -1 });

    // An attempt is only resumable if its snapshotted questions still exist — a --replace
    // re-import gives every question a fresh _id, orphaning older attempts. Retire stale ones.
    const stillResumable = async (attempt) => {
      if (!attempt || attempt.questionIds.length === 0) return false;
      const alive = await QuizQuestion.exists({ _id: attempt.questionIds[0] });
      if (alive) return true;
      attempt.status = 'completed';
      attempt.completedAt = new Date();
      await attempt.save().catch(() => {});
      return false;
    };

    let questionIds;

    if (mode === 'topic') {
      topic = (req.body?.topic || '').trim();
      if (!topic) return res.status(400).json({ error: 'topic is required for mode=topic' });
      const existing = await findResumable({ topic });
      if (await stillResumable(existing)) return res.json(progress(existing));
      const qs = await QuizQuestion.find({ subject, topic }).sort({ seq: 1 }).select('_id');
      if (qs.length === 0) return res.status(404).json({ error: 'No questions for this topic' });
      questionIds = qs.map((q) => q._id);
    } else if (mode === 'all') {
      const existing = await findResumable({});
      if (await stillResumable(existing)) return res.json(progress(existing));
      const qs = await QuizQuestion.find({ subject }).sort({ seq: 1 }).select('_id');
      if (qs.length === 0) return res.status(404).json({ error: 'No questions for this subject' });
      questionIds = qs.map((q) => q._id);
    } else {
      // random = a one-shot test. Never resume; retire any earlier in-progress random test so
      // "Start test" always gives a fresh set of the requested size.
      const size = RANDOM_SIZES.includes(Number(req.body?.size)) ? Number(req.body.size) : 25;
      await QuizAttempt.updateMany(
        { user: req.userId, subject, mode: 'random', status: 'in-progress' },
        { status: 'completed', completedAt: new Date() }
      );
      const sample = await QuizQuestion.aggregate([
        { $match: { subject } },
        { $sample: { size } },
        { $project: { _id: 1 } }
      ]);
      if (sample.length === 0) return res.status(404).json({ error: 'No questions for this subject' });
      questionIds = sample.map((s) => s._id);
    }

    const attempt = await QuizAttempt.create({
      user: req.userId,
      subject,
      mode,
      topic,
      questionIds,
      totalQuestions: questionIds.length
    });

    res.json(progress(attempt));
  } catch (err) {
    console.error('quiz startAttempt error:', err);
    res.status(500).json({ error: 'Failed to start quiz' });
  }
};

// GET /api/quiz/attempts/:id/questions?from=0&limit=25
// Questions carry no answer key. `whyCorrect` is included only for questions the student has
// already checked (so a resumed attempt shows their explanations again).
export const getAttemptQuestions = async (req, res) => {
  try {
    const attempt = await loadOwnedAttempt(req.params.id, req.userId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const slice = attempt.questionIds.slice(from, from + limit);
    const answeredIdx = new Set(attempt.responses.map((r) => r.index));

    const docs = await QuizQuestion.find({ _id: { $in: slice } }).select('questionText statements matchLists options topic examSource questionType whyCorrect');
    const byId = new Map(docs.map((d) => [String(d._id), d]));

    const questions = slice
      .map((id, i) => {
        const q = byId.get(String(id));
        if (!q) return null; // question deleted since the attempt started (e.g. a --replace re-import)
        const index = from + i;
        return {
          index,
          id: q._id,
          questionText: q.questionText,
          statements: q.statements || [],
          matchLists: q.matchLists || null,
          options: q.options.map((o) => ({ key: o.key, text: o.text })),
          topic: q.topic,
          examSource: q.examSource,
          questionType: q.questionType,
          ...(answeredIdx.has(index) ? { whyCorrect: q.whyCorrect || '' } : {})
        };
      })
      .filter(Boolean);

    res.json({ from, limit, total: attempt.questionIds.length, questions });
  } catch (err) {
    console.error('quiz getAttemptQuestions error:', err);
    res.status(500).json({ error: 'Failed to load questions' });
  }
};

// POST /api/quiz/attempts/:id/answer  { index, selectedKey }
export const answerQuestion = async (req, res) => {
  try {
    const { index, selectedKey } = req.body || {};
    const idx = Number(index);
    const attempt = await loadOwnedAttempt(req.params.id, req.userId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt.status !== 'in-progress') return res.status(409).json({ error: 'This attempt is already completed' });
    if (!Number.isInteger(idx) || idx < 0 || idx >= attempt.questionIds.length) {
      return res.status(400).json({ error: 'Invalid question index' });
    }
    if (!['A', 'B', 'C', 'D'].includes(selectedKey)) {
      return res.status(400).json({ error: 'selectedKey must be A, B, C or D' });
    }
    if (attempt.responses.some((r) => r.index === idx)) {
      return res.status(409).json({ error: 'Question already answered' });
    }

    const question = await QuizQuestion.findById(attempt.questionIds[idx]).select('correctKey whyCorrect');
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const isCorrect = selectedKey === question.correctKey;
    attempt.responses.push({
      question: question._id,
      index: idx,
      selectedKey,
      correctKey: question.correctKey,
      isCorrect,
      answeredAt: new Date()
    });
    await attempt.save();

    // Every mode reveals the answer as soon as the student checks it.
    res.json({
      index: idx,
      answeredCount: attempt.responses.length,
      totalQuestions: attempt.totalQuestions,
      isCorrect,
      correctKey: question.correctKey,
      whyCorrect: question.whyCorrect || ''
    });
  } catch (err) {
    console.error('quiz answerQuestion error:', err);
    res.status(500).json({ error: 'Failed to submit answer' });
  }
};

const buildReview = async (attempt) => {
  const docs = await QuizQuestion.find({ _id: { $in: attempt.questionIds } })
    .select('questionText statements matchLists options correctKey whyCorrect topic examSource questionType');
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return attempt.questionIds.map((id, i) => {
    const q = byId.get(String(id));
    const r = attempt.responses.find((x) => x.index === i);
    return {
      index: i,
      questionText: q?.questionText || '',
      statements: q?.statements || [],
      matchLists: q?.matchLists || null,
      options: (q?.options || []).map((o) => ({ key: o.key, text: o.text })),
      correctKey: q?.correctKey || null,
      whyCorrect: q?.whyCorrect || '',
      topic: q?.topic || '',
      examSource: q?.examSource || '',
      questionType: q?.questionType || '',
      selectedKey: r?.selectedKey ?? null,
      isCorrect: r?.isCorrect ?? null
    };
  });
};

// --- Performance analysis --------------------------------------------------------------
// Derived entirely from what an attempt already records (topic, questionType, correctness)
// plus `answeredAt` deltas — no schema change. Per-question timing, confidence tagging and
// difficulty are not tracked by the quiz yet, so the panels that need them are absent rather
// than faked.

const WEAK_THRESHOLD = 50;
const STRONG_THRESHOLD = 75;
// topic/all attempts resume across sessions, so a gap this long is the student being away,
// not thinking about the question. Excluded from the pace estimate.
const IDLE_GAP_SECONDS = 600;
// A random/all run spreads a few questions over dozens of topics, so a single unlucky answer
// would otherwise brand a whole topic "weak". Call a topic weak only on this much evidence.
const MIN_TOPIC_SAMPLE = 3;

const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0);

const bucketFor = (accuracy, attempted) =>
  attempted === 0 ? 'Not Attempted'
  : accuracy < WEAK_THRESHOLD ? 'Weak'
  : accuracy < STRONG_THRESHOLD ? 'Average'
  : 'Strong';

// Groups review rows by keyOf(row) into accuracy tallies. Rows with an empty key are skipped
// (e.g. a question imported without a questionType).
const groupAccuracy = (review, keyOf) => {
  const groups = new Map();
  for (const r of review) {
    const key = keyOf(r);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { total: 0, attempted: 0, correct: 0, wrong: 0 });
    const g = groups.get(key);
    g.total++;
    if (r.selectedKey != null) {
      g.attempted++;
      if (r.isCorrect) g.correct++;
      else g.wrong++;
    }
  }
  return [...groups].map(([name, g]) => ({
    name,
    total: g.total,
    attempted: g.attempted,
    correct: g.correct,
    wrong: g.wrong,
    unattempted: g.total - g.attempted,
    accuracy: pct(g.correct, g.attempted),
    bucket: bucketFor(pct(g.correct, g.attempted), g.attempted)
  }));
};

// The quiz has no timer, so answer timestamps are the only timing signal. Returns null when
// nothing usable survives the idle filter, and reports how many gaps it measured so the client
// can label the number as the estimate it is.
const estimatePace = (attempt) => {
  const stamps = attempt.responses
    .filter((r) => r.answeredAt)
    .map((r) => new Date(r.answeredAt).getTime())
    .sort((a, b) => a - b);
  if (!stamps.length) return null;

  let prev = attempt.startedAt ? new Date(attempt.startedAt).getTime() : stamps[0];
  let activeSeconds = 0;
  let measured = 0;
  for (const stamp of stamps) {
    const gap = (stamp - prev) / 1000;
    prev = stamp;
    if (gap <= 0 || gap > IDLE_GAP_SECONDS) continue;
    activeSeconds += gap;
    measured++;
  }
  if (!measured) return null;

  return {
    answeredQuestions: stamps.length,
    measuredQuestions: measured,
    activeSeconds: Math.round(activeSeconds),
    avgSecondsPerQuestion: Math.round(activeSeconds / measured)
  };
};

const buildAnalysis = (attempt, review) => {
  const attempted = review.filter((r) => r.selectedKey != null);
  const correct = attempted.filter((r) => r.isCorrect).length;

  const topicBreakdown = groupAccuracy(review, (r) => r.topic || MISC_TOPIC)
    .map(({ name, ...rest }) => ({ topic: name, ...rest }))
    .sort((a, b) => a.accuracy - b.accuracy || a.topic.localeCompare(b.topic));

  const questionTypeBreakdown = groupAccuracy(review, (r) => r.questionType)
    .map(({ name, ...rest }) => ({ questionType: name, ...rest }))
    .sort((a, b) => a.questionType.localeCompare(b.questionType));

  return {
    summary: {
      totalQuestions: review.length,
      totalAttempted: attempted.length,
      totalCorrect: correct,
      totalWrong: attempted.length - correct,
      totalUnattempted: review.length - attempted.length,
      scorePercent: pct(correct, review.length),         // correct out of every question
      accuracyPercent: pct(correct, attempted.length)    // correct out of the ones tried
    },
    topicBreakdown,
    weakTopics: topicBreakdown
      .filter((t) => t.attempted >= MIN_TOPIC_SAMPLE && t.accuracy < WEAK_THRESHOLD)
      .map((t) => t.topic),
    minTopicSample: MIN_TOPIC_SAMPLE,
    questionTypeBreakdown,
    pace: estimatePace(attempt)
  };
};

// POST /api/quiz/attempts/:id/complete
export const completeAttempt = async (req, res) => {
  try {
    const attempt = await loadOwnedAttempt(req.params.id, req.userId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

    if (attempt.status !== 'completed') {
      const answered = attempt.responses.filter((r) => r.selectedKey != null);
      attempt.totalAnswered = answered.length;
      attempt.totalCorrect = answered.filter((r) => r.isCorrect).length;
      attempt.score = attempt.totalQuestions
        ? Math.round((attempt.totalCorrect / attempt.totalQuestions) * 100)
        : 0;
      attempt.status = 'completed';
      attempt.completedAt = new Date();
      await attempt.save();
    }

    const review = await buildReview(attempt);
    res.json({
      attemptId: attempt._id,
      mode: attempt.mode,
      topic: attempt.topic,
      score: attempt.score,
      totalCorrect: attempt.totalCorrect,
      totalAnswered: attempt.totalAnswered,
      totalQuestions: attempt.totalQuestions,
      review,
      analysis: buildAnalysis(attempt, review)
    });
  } catch (err) {
    console.error('quiz completeAttempt error:', err);
    res.status(500).json({ error: 'Failed to complete quiz' });
  }
};

// GET /api/quiz/attempts/:id
export const getAttempt = async (req, res) => {
  try {
    const attempt = await loadOwnedAttempt(req.params.id, req.userId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

    const payload = {
      ...progress(attempt),
      score: attempt.score,
      totalCorrect: attempt.totalCorrect,
      totalAnswered: attempt.totalAnswered
    };
    if (attempt.status === 'completed') {
      payload.review = await buildReview(attempt);
      payload.analysis = buildAnalysis(attempt, payload.review);
    }
    res.json(payload);
  } catch (err) {
    console.error('quiz getAttempt error:', err);
    res.status(500).json({ error: 'Failed to load attempt' });
  }
};

// GET /api/quiz/attempts?subject=Geography
export const listAttempts = async (req, res) => {
  try {
    const filter = { user: req.userId };
    if (req.query.subject) filter.subject = req.query.subject;

    const attempts = await QuizAttempt.find(filter).sort({ createdAt: -1 }).limit(100).lean();

    res.json({
      attempts: attempts.map((a) => ({
        id: a._id,
        subject: a.subject,
        mode: a.mode,
        topic: a.topic,
        label:
          a.mode === 'topic' ? `Topic · ${a.topic}`
          : a.mode === 'random' ? `Random test (${a.totalQuestions})`
          : 'All questions',
        status: a.status,
        score: a.score,
        totalCorrect: a.totalCorrect,
        totalAnswered: a.totalAnswered,
        totalQuestions: a.totalQuestions,
        answeredCount: (a.responses || []).length,
        startedAt: a.startedAt,
        completedAt: a.completedAt
      }))
    });
  } catch (err) {
    console.error('quiz listAttempts error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
};

// POST /api/quiz/questions/:questionId/report  { reason }
export const reportQuestion = async (req, res) => {
  try {
    const { questionId } = req.params;
    if (!isValidId(questionId)) return res.status(404).json({ error: 'Question not found' });

    const question = await QuizQuestion.findById(questionId).select('subject');
    if (!question) return res.status(404).json({ error: 'Question not found' });

    await QuizReport.create({
      user: req.userId,
      quizQuestion: question._id,
      subject: question.subject,
      reason: (req.body?.reason || '').toString().slice(0, 2000)
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('quiz reportQuestion error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
};
