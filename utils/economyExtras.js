// economyExtras.js — AI drafts of the Economy Master File "value addition" per topic:
// `facts` (relatable real-world hooks) + `research` (crisp beyond-the-book lines).
//
// Always saved as extrasStatus 'draft' — an admin reviews and publishes. Used by the per-topic
// admin button, the per-theme background job (Admin → Economy Data → Themes) and
// scripts/generate_economy_extras.mjs.

import EconomyTopic from '../models/EconomyTopic.js';
import { runJsonExtraction } from './aiProvider.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

const EXTRAS_SYSTEM = `You write short study add-ons for Indian UPSC aspirants revising Economy.
You are given one topic from a revision master file. Do NOT repeat or rephrase the notes — add to them.
Return JSON only: {"facts": [string], "research": string}
- facts: 2-3 relatable, real-world hooks that make the concept stick — a well-known Indian or global
  episode, a number a student can picture, an everyday analogy. One sentence each, max 30 words.
- research: 3-5 crisp lines (separate with \\n) of "beyond the book" value: the latest official data
  or rule change you are confident about, the committee/report/act behind it, and one Mains angle.
  Start each line with a short bold-free label like "Latest:", "Source:", "Mains angle:".
- Accuracy first: use only widely documented facts (RBI / Budget / Economic Survey / well-known
  history). Never invent an event, allocation, date or number; if unsure, leave it out — fewer
  items is fine. No markdown.`;

const notesOf = (t) =>
  t.blocks.map((b) => `${'  '.repeat(b.level)}- ${b.spans.map((s) => (s.m === 'ok' ? '[correct] ' : s.m === 'no' ? '[wrong] ' : s.t)).join('')}`).join('\n');

// Draft extras for one EconomyTopic document and save them. Throws if the AI returns nothing usable.
export const draftTopicExtras = async (t) => {
  const out = await runJsonExtraction({
    system: EXTRAS_SYSTEM,
    prompt: `Theme: ${t.themeKey}\nTopic: ${t.title}\n\nNotes:\n${notesOf(t)}`,
    maxOutputTokens: 1500,
    maxRetries: 3,
  });
  const facts = (Array.isArray(out?.facts) ? out.facts : []).map((f) => clip(String(f), 600)).filter(Boolean).slice(0, 5);
  const research = clip(typeof out?.research === 'string' ? out.research : '', 4000);
  if (!facts.length && !research) throw Object.assign(new Error('The AI returned nothing usable — try again'), { status: 502 });
  t.facts = facts;
  t.research = research;
  t.extrasStatus = 'draft';
  await t.save();
  return t;
};

// Topics a bulk run should fill: visible ones with no extras yet. `redraft` also redoes existing
// drafts. Published extras are never touched in bulk — unpublish a topic first to redo it.
export const bulkTargetFilter = (themeKey, { redraft = false } = {}) => ({
  themeKey,
  hidden: false,
  extrasStatus: redraft ? { $in: ['none', 'draft'] } : 'none',
});

// Run draftTopicExtras over a list of topic ids with a small worker pool.
// onProgress({ done, failed, total, lastError }) after each topic.
export const draftManyExtras = async (ids, { concurrency = 3, onProgress, shouldStop } = {}) => {
  const state = { total: ids.length, done: 0, failed: 0, errors: [] };
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !shouldStop?.()) {
      const id = ids[next++];
      try {
        const t = await EconomyTopic.findById(id);
        if (!t) throw new Error('topic disappeared');
        await draftTopicExtras(t);
        state.done += 1;
      } catch (e) {
        state.failed += 1;
        state.errors.push({ id: String(id), error: e.message });
      }
      onProgress?.(state);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker));
  return state;
};

// ---------------------------------------------------------------------------- per-theme jobs
// In-process background jobs, one per theme, so the admin button returns immediately and the UI
// polls. Lost on a server restart — topics already drafted stay drafted, so just start it again.

const jobs = new Map(); // themeKey -> { running, total, done, failed, errors, startedAt, finishedAt, stop }

export const getExtrasJobs = () =>
  Object.fromEntries([...jobs].map(([k, j]) => [k, { running: j.running, total: j.total, done: j.done, failed: j.failed, errors: j.errors.slice(-5), startedAt: j.startedAt, finishedAt: j.finishedAt }]));

export const startThemeExtrasJob = async (themeKey, { redraft = false, concurrency = 3 } = {}) => {
  if (jobs.get(themeKey)?.running) throw Object.assign(new Error('A draft job is already running for this theme'), { status: 409 });
  const ids = (await EconomyTopic.find(bulkTargetFilter(themeKey, { redraft })).sort({ order: 1 }).select('_id').lean()).map((t) => t._id);
  const job = { running: ids.length > 0, total: ids.length, done: 0, failed: 0, errors: [], startedAt: new Date(), finishedAt: ids.length ? null : new Date(), stopRequested: false };
  jobs.set(themeKey, job);
  if (ids.length) {
    draftManyExtras(ids, {
      concurrency,
      shouldStop: () => job.stopRequested,
      onProgress: (s) => Object.assign(job, { done: s.done, failed: s.failed, errors: s.errors }),
    })
      .catch((e) => job.errors.push({ error: e.message }))
      .finally(() => Object.assign(job, { running: false, finishedAt: new Date() }));
  }
  return getExtrasJobs()[themeKey];
};

export const stopThemeExtrasJob = (themeKey) => {
  const job = jobs.get(themeKey);
  if (job?.running) job.stopRequested = true;
  return !!job?.running;
};
