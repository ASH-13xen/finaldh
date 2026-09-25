import McqAttempt from '../models/McqAttempt.js';
import McqAttemptQuota from '../models/McqAttemptQuota.js';
import McqQuestion from '../models/McqQuestion.js';
import McqFlag from '../models/McqFlag.js';
import { applyScoring, round2 } from './mcqScoring.js';

export const DEFAULT_MAX_ATTEMPTS = 2;
export const isFinished = (status) => status === 'submitted' || status === 'auto-submitted';

// Does this student have access to the test (free, bought individually, or bought the whole subject)?
export function userCanAccessTest(user, test) {
  if (!test.requiresPurchase) return true;
  const ownedTest = (user?.purchasedMcqTests || []).some((id) => String(id) === String(test._id));
  const ownedSubject = (user?.purchasedMcqSubjects || []).includes(test.subject);
  return ownedTest || ownedSubject;
}

// ---------- attempt quota (Test + Practice combined) ----------

export const maxAttemptsFor = (test) => Number.isFinite(test?.maxAttempts) && test.maxAttempts >= 1 ? test.maxAttempts : DEFAULT_MAX_ATTEMPTS;

// Atomically uses up one attempt. The increment is ONE conditional findOneAndUpdate: the filter only
// matches while used < allowed, so when several requests race for the last slot exactly one of them
// matches and the rest get null - a read-then-write check could let them all through.
// (MongoDB does not allow $expr in an upsert filter, so the row is created in a separate, idempotent step.)
// Returns the updated quota row, or null when the student is out of attempts.
export async function consumeAttempt(userId, testId, maxAttempts) {
  try {
    await McqAttemptQuota.updateOne(
      { user: userId, test: testId },
      { $setOnInsert: { used: 0, extra: 0 } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err; // two requests created the row at once - fine, it exists now
  }
  return McqAttemptQuota.findOneAndUpdate(
    { user: userId, test: testId, $expr: { $lt: ['$used', { $add: [maxAttempts, { $ifNull: ['$extra', 0] }] }] } },
    { $inc: { used: 1 } },
    { returnDocument: 'after' }
  );
}

export async function refundAttempt(userId, testId) {
  await McqAttemptQuota.updateOne({ user: userId, test: testId, used: { $gt: 0 } }, { $inc: { used: -1 } });
}

export async function quotaInfo(userId, test) {
  const max = maxAttemptsFor(test);
  const row = await McqAttemptQuota.findOne({ user: userId, test: test._id });
  const extra = row?.extra || 0;
  const used = row?.used || 0;
  return { max: max + extra, base: max, extra, used, remaining: Math.max(0, max + extra - used) };
}

// ---------- attempt lifecycle ----------

// Computes final score/aggregates server-side and marks the attempt submitted.
export async function finalizeAttempt(attempt, isAuto) {
  applyScoring(attempt);
  attempt.status = isAuto ? 'auto-submitted' : 'submitted';
  attempt.submittedAt = new Date();
  await attempt.save();
  return attempt;
}

export const isExpired = (attempt, graceMs = 0) =>
  attempt.status === 'in-progress' && attempt.mode !== 'practice' && attempt.serverDeadline && Date.now() > attempt.serverDeadline.getTime() + graceMs;

// Auto-submits a timed attempt whose deadline has passed. Returns true when it did.
export async function finalizeIfExpired(attempt) {
  if (!isExpired(attempt)) return false;
  await finalizeAttempt(attempt, true);
  return true;
}

// Builds the per-question snapshot stored on an attempt. Question `order` here is the position within
// THIS attempt (1..N), so cross-test sessions and retired questions never leave gaps.
export function buildResponses(questions, testsById) {
  return questions.map((q, i) => {
    const test = testsById.get(String(q.test));
    const maxMarks = q.marks ?? test?.marksPerQuestion ?? 2;
    const ratio = test?.negativeMarkingRatio ?? 0.33;
    return {
      question: q._id,
      order: i + 1,
      questionText: q.questionText,
      options: q.options.map((o) => ({ label: o.label, text: o.text })),
      difficulty: q.difficulty,
      tags: q.tags.map((t) => ({ section: t.section, title: t.title })),
      maxMarks,
      negativeMarks: round2(maxMarks * ratio),
      correctOption: q.correctOption,
      status: 'not-visited'
    };
  });
}

// What the runner needs to render/resume an attempt. Correct answers and explanations are only ever
// included for practice questions the student has already checked.
export async function attemptPayload(attempt, extra = {}) {
  const responses = attempt.responses;

  // Older attempts have no snapshot: fall back to a live lookup by question id (never by test + order).
  const needLive = responses.filter((r) => !r.questionText).map((r) => r.question);
  const liveById = new Map();
  if (needLive.length) {
    const live = await McqQuestion.find({ _id: { $in: needLive } }).select('questionText options');
    live.forEach((q) => liveById.set(String(q._id), q));
  }

  const revealedIds = responses.filter((r) => r.revealed).map((r) => r.question);
  const revealedById = new Map();
  if (revealedIds.length) {
    const docs = await McqQuestion.find({ _id: { $in: revealedIds } }).select('explanation examSource');
    docs.forEach((q) => revealedById.set(String(q._id), q));
  }

  const flags = await McqFlag.find({ user: attempt.user, question: { $in: responses.map((r) => r.question) } }).select('question');
  const flaggedIds = new Set(flags.map((f) => String(f.question)));

  return {
    attemptId: attempt._id,
    mode: attempt.mode || 'test',
    source: attempt.source || 'test',
    timerEnabled: attempt.timerEnabled !== false,
    serverNow: new Date().toISOString(),
    serverDeadline: attempt.serverDeadline || null,
    durationMinutes: attempt.durationMinutes,
    startedAt: attempt.startedAt,
    subject: attempt.subject,
    lastActiveQuestionOrder: attempt.lastActiveQuestionOrder,
    responses: responses.map((r) => {
      const base = {
        order: r.order,
        status: r.status,
        selectedOption: r.selectedOption,
        confidenceTag: r.confidenceTag,
        timeSpentSeconds: r.timeSpentSeconds || 0,
        revealed: !!r.revealed
      };
      if (r.revealed) {
        const live = revealedById.get(String(r.question));
        base.correctOption = r.correctOption;
        base.explanation = live?.explanation || '';
        base.examSource = live?.examSource || '';
      }
      return base;
    }),
    questions: responses.map((r) => {
      const live = liveById.get(String(r.question));
      return {
        _id: r.question,
        order: r.order,
        questionText: r.questionText ?? live?.questionText ?? '(question no longer available)',
        options: r.options?.length ? r.options.map((o) => ({ label: o.label, text: o.text })) : (live?.options || [])
      };
    }),
    flaggedOrders: responses.filter((r) => flaggedIds.has(String(r.question))).map((r) => r.order),
    ...extra
  };
}

// ---------- background sweep ----------
// Timed attempts are normally auto-submitted lazily the next time the student touches them. This closes
// the ones nobody ever came back to, so they don't stay "in progress" (and out of results) forever.
export async function sweepExpiredAttempts(limit = 200) {
  const cutoff = new Date(Date.now() - 60 * 1000); // one minute of grace for a final autosave in flight
  const stale = await McqAttempt.find({
    status: 'in-progress',
    mode: { $ne: 'practice' },
    serverDeadline: { $lt: cutoff }
  }).limit(limit);
  for (const attempt of stale) {
    try {
      await finalizeAttempt(attempt, true);
    } catch (err) {
      console.error('[mcq sweeper] failed to finalize attempt', attempt._id, err.message);
    }
  }
  return stale.length;
}

export function startMcqSweeper(intervalMs = 5 * 60 * 1000) {
  const run = () => sweepExpiredAttempts().catch((err) => console.error('[mcq sweeper]', err.message));
  setTimeout(run, 30 * 1000).unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
