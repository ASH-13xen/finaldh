// syllabusTagging.js — place MCQ test questions and Question Bank PYQs under a subject's syllabus
// (models/SubjectSyllabus.js), so solutions can be read chapter by chapter.
//
// The AI sees the syllabus and a batch of questions with their answers, and answers with the chapter
// title and sub-topic text, not a number. Saved on the question as `syllabusTag`, with by = 'ai';
// a placement an admin made (by = 'admin') is never overwritten. A bank PYQ also takes the chapter
// title as its `topic` (original kept in `sourceTopic`), which arranges the bank's topic list.
//
// Used by the MCQ upload (automatic), Admin → MCQ Test Data → Syllabus, and
// scripts/place_syllabus_questions.mjs. Jobs live in this process: if the server restarts, placed
// questions stay placed and running it again picks up the rest.

import McqQuestion from '../models/McqQuestion.js';
import McqTest from '../models/McqTest.js';
import QuizQuestion from '../models/QuizQuestion.js';
import SubjectSyllabus from '../models/SubjectSyllabus.js';
import { runJsonExtraction } from './aiProvider.js';

const BATCH = 15;

const SYSTEM = `You file Indian UPSC Prelims MCQs under a subject's syllabus.
You get the syllabus (numbered chapters, each with sub-topic lines) and a batch of questions with their correct answers.
For each question pick the one chapter that holds the concept the question actually tests, not every word it mentions,
and the sub-topic line within that chapter that fits best. Leave "subtopic" empty if no line fits.
Copy the chapter title and the sub-topic line exactly as they appear. Do not include the chapter number.
Return JSON only: {"results": [{"q": <question number>, "chapter": "<exact chapter title>", "subtopic": "<exact sub-topic line or empty>", "confidence": <0..1>}]}
confidence = how sure you are that the chapter is right.`;

const norm = (s) => String(s || '').toLowerCase().replace(/^\s*\d+\s*[.)]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Exact (normalized) match, else the only candidate that contains it or is contained by it.
const pick = (list, value, textOf) => {
  const k = norm(value);
  if (!k) return null;
  const exact = list.find((x) => norm(textOf(x)) === k);
  if (exact) return exact;
  const near = list.filter((x) => norm(textOf(x)).includes(k) || k.includes(norm(textOf(x))));
  return near.length === 1 ? near[0] : null;
};

const outlineText = (syllabus) => syllabus.chapters
  .map((c) => [`${c.number}. ${c.title}`, ...c.subtopics.map((s) => `   - ${s}`)].join('\n'))
  .join('\n');

// Works for both question shapes: McqQuestion (label / correctOption) and QuizQuestion (key / correctKey).
const describe = (q, i) => {
  const correct = q.correctOption || q.correctKey;
  const options = q.options.map((o) => ({ key: o.label || o.key, text: o.text }));
  return [
    `Q${i + 1}`,
    q.questionText,
    ...(q.statements || []),
    ...options.map((o) => `(${o.key.toLowerCase()}) ${o.text}`),
    `Correct: (${correct.toLowerCase()}) ${options.find((o) => o.key === correct)?.text || ''}`,
  ].join('\n');
};

/** Ask the AI about one batch. Returns [{ _id, chapter, subtopic, confidence }] without saving. */
export const placeBatch = async (questions, syllabus) => {
  const out = await runJsonExtraction({
    system: SYSTEM,
    prompt: `SYLLABUS\n${outlineText(syllabus)}\n\nQUESTIONS\n\n${questions.map(describe).join('\n\n')}`,
    maxOutputTokens: 2000,
    maxRetries: 3,
  });
  const results = Array.isArray(out?.results) ? out.results : [];
  return questions.map((q, i) => {
    const r = results.find((x) => Number(x?.q) === i + 1);
    const chapter = pick(syllabus.chapters, r?.chapter, (c) => c.title);
    return {
      _id: q._id,
      chapter: chapter?.key || '',
      subtopic: chapter ? pick(chapter.subtopics, r?.subtopic, (s) => s) || '' : '',
      confidence: chapter ? Math.max(0, Math.min(1, Number(r?.confidence) || 0)) : 0,
    };
  });
};

const modelOf = (kind) => (kind === 'bank' ? QuizQuestion : McqQuestion);

/** Fields to $set for a placement. `chapterObj` is null when the question is left unplaced. */
export const placementSet = (kind, q, chapterObj, { subtopic = '', by, confidence = null }) => {
  const set = { syllabusTag: { chapter: chapterObj?.key || '', subtopic, by, confidence, at: new Date() } };
  if (kind === 'bank') {
    const original = q.sourceTopic || q.topic;
    set.sourceTopic = original;
    set.topic = chapterObj?.title || original;
  }
  return set;
};

export const syllabusFor = (subject) => SubjectSyllabus.findOne({ subject }).lean();

// kind 'test': ref = test id. kind 'bank': ref = subject.
export const subjectOf = async (kind, ref) => {
  if (kind === 'bank') return ref;
  return (await McqTest.findById(ref).select('subject').lean())?.subject || null;
};

export const targetFilter = (kind, ref, { retag = false } = {}) => ({
  ...(kind === 'bank' ? { subject: ref } : { test: ref, isActive: { $ne: false } }),
  ...(retag ? { 'syllabusTag.by': { $ne: 'admin' } } : { 'syllabusTag.by': null }),
});

// ------------------------------------------------------------------------- background jobs
const jobs = new Map(); // `${kind}:${ref}` -> { running, total, done, placed, failed, errors, again, stop }
const jobKey = (kind, ref) => `${kind}:${ref}`;

export const getPlacementJob = (kind, ref) => {
  const j = jobs.get(jobKey(kind, ref));
  return j && { running: j.running, total: j.total, done: j.done, placed: j.placed, failed: j.failed, errors: j.errors.slice(-3) };
};

const runJob = async (job, kind, ref, syllabus, { retag, limit }) => {
  const Model = modelOf(kind);
  let query = Model.find(targetFilter(kind, ref, { retag })).sort(kind === 'bank' ? { seq: 1 } : { order: 1 });
  if (limit > 0) query = query.limit(limit);
  const questions = await query.lean();
  job.total += questions.length;
  const chapterByKey = new Map(syllabus.chapters.map((c) => [c.key, c]));
  for (let i = 0; i < questions.length && !job.stop; i += BATCH) {
    const chunk = questions.slice(i, i + BATCH);
    try {
      const placed = await placeBatch(chunk, syllabus);
      await Promise.all(placed.map((p, n) => Model.updateOne(
        // An admin may have placed it by hand while the AI was working.
        { _id: p._id, 'syllabusTag.by': { $ne: 'admin' } },
        { $set: placementSet(kind, chunk[n], chapterByKey.get(p.chapter) || null, { subtopic: p.subtopic, by: 'ai', confidence: p.confidence }) },
      )));
      job.placed += placed.filter((p) => p.chapter).length;
      job.done += chunk.length;
    } catch (e) {
      job.failed += chunk.length;
      job.errors.push(e.message);
    }
  }
};

/** Start placing a test's or bank's unplaced questions. Asking while it runs queues one more pass. */
export const startPlacementJob = async (kind, ref, { retag = false, limit = 0 } = {}) => {
  const key = jobKey(kind, ref);
  const existing = jobs.get(key);
  if (existing?.running) { existing.again = true; return getPlacementJob(kind, ref); }

  const subject = await subjectOf(kind, ref);
  const syllabus = subject && await syllabusFor(subject);
  if (!syllabus) throw Object.assign(new Error(`No syllabus uploaded for ${subject || 'this subject'}`), { status: 400 });

  const job = { running: true, total: 0, done: 0, placed: 0, failed: 0, errors: [], again: false, stop: false };
  jobs.set(key, job);
  (async () => {
    await runJob(job, kind, ref, syllabus, { retag, limit });
    while (job.again && !job.stop) {
      job.again = false;
      await runJob(job, kind, ref, syllabus, { retag: false, limit: 0 });
    }
  })()
    .catch((e) => job.errors.push(e.message))
    .finally(() => { job.running = false; });
  return getPlacementJob(kind, ref);
};

export const stopPlacementJob = (kind, ref) => {
  const j = jobs.get(jobKey(kind, ref));
  if (j?.running) j.stop = true;
  return !!j?.running;
};

/** After questions were added or changed: place them if the subject has a syllabus. Never throws. */
export const autoPlaceTest = async (testId) => {
  try {
    const subject = await subjectOf('test', testId);
    if (!subject || !(await SubjectSyllabus.exists({ subject }))) return { subject, hasSyllabus: false, placing: false, count: 0 };
    const count = await McqQuestion.countDocuments(targetFilter('test', testId));
    if (count) await startPlacementJob('test', testId);
    return { subject, hasSyllabus: true, placing: count > 0, count };
  } catch (e) {
    console.error('autoPlaceTest failed:', e.message);
    return { placing: false, count: 0, error: e.message };
  }
};
