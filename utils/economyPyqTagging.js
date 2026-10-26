// economyPyqTagging.js — place Economy Question Bank PYQs under Economy Master File topics
// ("RBI as Lender of Last Resort", "Liquidity Trap", …) so a topic can show its own PYQs.
//
// The AI sees a batch of questions (with their answers) and the full list of topic titles, and
// returns up to 3 topic titles per question with a 0–1 confidence. It answers with the title
// text, not a list number — models miscount in a ~770-line list. The PDF repeats some topics across
// its three parts ("Cash Reserve Ratio (CRR)" sits in Forum, Part B and Vision), so titles that
// normalize to the same text are shown once and a pick is expanded to every copy.
//
// Saved as econTag.by = 'ai'. A question an admin placed by hand (econTag.by = 'admin') is never
// re-tagged by a bulk run. Used by the admin job (Admin → Economy Data → PYQs) and
// scripts/tag_economy_pyqs.mjs.

import EconomyTopic from '../models/EconomyTopic.js';
import QuizQuestion from '../models/QuizQuestion.js';
import { runJsonExtraction, getActiveModelLabel } from './aiProvider.js';

export const ECONOMY_PYQ_SUBJECT = 'Economy';
const BATCH = 15;
const MIN_CONFIDENCE = 0.5;

const TAG_SYSTEM = `You file Indian UPSC Prelims Economy PYQs under the topics of a revision master file.
You get a list of topic titles (grouped under "# theme" lines) and a batch of questions with their correct answers.
For each question pick the topics whose notes a student should read to answer it — the concept the
question actually tests, not every word it mentions. Pick 1 topic normally, up to 3 when the question
genuinely spans several (e.g. one statement on CRR and one on SLR). If no topic fits, return an empty list.
Copy each topic title exactly as it appears in the list.
Return JSON only: {"results": [{"q": <question number>, "topics": ["<exact topic title>", ...], "confidence": <0..1>}]}
confidence = how sure you are that the first topic is right.`;

const normTitle = (t) => String(t || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Topic catalogue for the prompt: one line per distinct title, mapped back to every copy.
export const buildCatalogue = async () => {
  const topics = await EconomyTopic.find({ hidden: false }).sort({ themeKey: 1, order: 1 }).select('_id themeKey title').lean();
  const groups = [];
  const byKey = new Map();
  for (const t of topics) {
    const k = `${t.themeKey}|${normTitle(t.title)}`;
    let g = byKey.get(k);
    if (!g) { g = { themeKey: t.themeKey, title: t.title, ids: [] }; byKey.set(k, g); groups.push(g); }
    g.ids.push(t._id);
  }
  let lastTheme = null;
  const lines = [];
  for (const g of groups) {
    if (g.themeKey !== lastTheme) { lines.push(`# ${g.themeKey}`); lastTheme = g.themeKey; }
    lines.push(g.title);
  }
  // normalized title -> groups (the same title can sit in two themes)
  const byTitle = new Map();
  for (const g of groups) {
    const k = normTitle(g.title);
    byTitle.set(k, [...(byTitle.get(k) || []), g]);
  }
  return { groups, byTitle, text: lines.join('\n') };
};

// The catalogue groups an AI-returned title stands for: exact (normalized) match, else the one
// title that contains it or is contained by it; anything ambiguous is dropped.
const findGroups = (catalogue, title) => {
  const k = normTitle(title);
  if (!k) return [];
  if (catalogue.byTitle.has(k)) return catalogue.byTitle.get(k);
  const near = [...catalogue.byTitle.keys()].filter((t) => t.includes(k) || k.includes(t));
  return near.length === 1 ? catalogue.byTitle.get(near[0]) : [];
};

const questionText = (q, i) => {
  const ans = q.options.find((o) => o.key === q.correctKey);
  return [
    `Q${i + 1} [section: ${q.topic}]`,
    q.questionText,
    ...(q.statements || []),
    ...q.options.map((o) => `(${o.key.toLowerCase()}) ${o.text}`),
    `Correct: (${q.correctKey.toLowerCase()}) ${ans?.text || ''}`,
  ].join('\n');
};

// Tag one batch of QuizQuestion docs and save. Returns the number of questions placed.
export const tagBatch = async (questions, catalogue) => {
  const out = await runJsonExtraction({
    system: TAG_SYSTEM,
    prompt: `TOPICS\n${catalogue.text}\n\nQUESTIONS\n\n${questions.map(questionText).join('\n\n')}`,
    maxOutputTokens: 2000,
    maxRetries: 3,
  });
  const results = Array.isArray(out?.results) ? out.results : [];
  const now = new Date();
  let placed = 0;
  for (const [i, q] of questions.entries()) {
    const r = results.find((x) => Number(x?.q) === i + 1);
    const confidence = Math.max(0, Math.min(1, Number(r?.confidence) || 0));
    const picks = (Array.isArray(r?.topics) ? r.topics : [])
      .slice(0, 3)
      .flatMap((title) => findGroups(catalogue, title));
    const ids = [...new Set(picks.flatMap((g) => g.ids.map(String)))];
    q.econTopics = confidence >= MIN_CONFIDENCE ? ids : [];
    q.econTag = { by: 'ai', confidence: r ? confidence : 0, at: now };
    await q.save();
    if (q.econTopics.length) placed += 1;
  }
  return placed;
};

// Questions a bulk run should tag: never-tagged ones; `retag` also redoes AI placements.
// Admin placements are always left alone.
export const tagTargetFilter = ({ retag = false } = {}) => ({
  subject: ECONOMY_PYQ_SUBJECT,
  ...(retag ? { 'econTag.by': { $ne: 'admin' } } : { 'econTag.by': null }),
});

// Run tagBatch over question ids. onProgress({ done, placed, failed, total }) after each batch.
export const tagManyPyqs = async (ids, { onProgress, shouldStop } = {}) => {
  const catalogue = await buildCatalogue();
  const state = { total: ids.length, done: 0, placed: 0, failed: 0, errors: [], model: getActiveModelLabel() };
  for (let i = 0; i < ids.length && !shouldStop?.(); i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const qs = await QuizQuestion.find({ _id: { $in: chunk } }).sort({ seq: 1 });
      state.placed += await tagBatch(qs, catalogue);
      state.done += qs.length;
    } catch (e) {
      state.failed += chunk.length;
      state.errors.push({ error: e.message });
    }
    onProgress?.(state);
  }
  return state;
};

// ------------------------------------------------------------------------- background job
// One in-process job (lost on restart — placed questions stay placed, so just start it again).
let job = null;

export const getPyqTagJob = () => job && {
  running: job.running, total: job.total, done: job.done, placed: job.placed, failed: job.failed,
  errors: job.errors.slice(-5), startedAt: job.startedAt, finishedAt: job.finishedAt,
};

export const startPyqTagJob = async ({ retag = false, limit = 0 } = {}) => {
  if (job?.running) throw Object.assign(new Error('A tagging job is already running'), { status: 409 });
  let query = QuizQuestion.find(tagTargetFilter({ retag })).sort({ seq: 1 }).select('_id');
  if (limit > 0) query = query.limit(limit);
  const ids = (await query.lean()).map((q) => q._id);
  job = { running: ids.length > 0, total: ids.length, done: 0, placed: 0, failed: 0, errors: [], startedAt: new Date(), finishedAt: ids.length ? null : new Date(), stopRequested: false };
  const mine = job;
  if (ids.length) {
    tagManyPyqs(ids, {
      shouldStop: () => mine.stopRequested,
      onProgress: (s) => Object.assign(mine, { done: s.done, placed: s.placed, failed: s.failed, errors: s.errors }),
    })
      .catch((e) => mine.errors.push({ error: e.message }))
      .finally(() => Object.assign(mine, { running: false, finishedAt: new Date() }));
  }
  return getPyqTagJob();
};

export const stopPyqTagJob = () => {
  if (job?.running) job.stopRequested = true;
  return !!job?.running;
};
