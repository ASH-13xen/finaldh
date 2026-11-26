import { runJsonExtraction, assertAiConfigured, isQuotaError } from './aiProvider.js';
import { TdhSet, TdhQuestion } from '../models/TdhResearch.js';

// Writes practice MCQs from each PYQ's TDH Research notes (PYQ & TDH Research). They are saved as
// drafts; students see a practice MCQ only after the admin approves it. A run never touches a
// question whose practice MCQs were edited or approved by the admin unless `redo` is asked for,
// and even then admin-made ones are kept.

export const PER_QUESTION = 1;
const BATCH = 6;

const SYSTEM = `You write practice MCQs for Indian UPSC Civil Services Prelims aspirants.
For each item you get one previous-year question (PYQ) and the "TDH Research" study notes written around it.
Write exactly ONE new MCQ per item, based ONLY on facts stated in that item's notes. Pick the single most
exam-worthy point in the notes and test it as either:
- "Factual" (a specific fact, number, institution or definition from the notes), or
- "Conceptual" (understanding: why/how, cause-effect, or telling two related ideas apart).
Prefer Conceptual when the notes explain a mechanism; prefer Factual when they centre on a key number or body.
UPSC style: either a direct question with 4 options, or "Consider the following statements:" with 2-3 numbered
statements in "statements" and options like "1 only", "2 and 3 only". Do not repeat the PYQ itself.
Exactly one option must be correct according to the notes; wrong options must be plausible, not silly.
"why" is one short sentence saying why the answer is right, citing the fact from the notes.
Plain text only, no markdown, no "**".
Return JSON only:
{"results": [{"item": <item number>, "mcqs": [{"type": "Factual"|"Conceptual", "question": "...", "statements": ["..."], "options": {"a": "...", "b": "...", "c": "...", "d": "..."}, "answer": "a"|"b"|"c"|"d", "why": "..."}]}]}`;

const strip = (s) => String(s || '').replace(/\*\*/g, '').trim();
const blocksText = (blocks) => blocks.map((b) => [b.heading && `## ${b.heading}`, ...b.points.map((p) => `- ${strip(p)}`)].filter(Boolean).join('\n')).join('\n');

const itemText = (q, i) => [
  `ITEM ${i + 1}: ${q.title || q.questionText.slice(0, 80)}`,
  `PYQ (${q.year}): ${q.questionText} ${q.lines.join(' ')}`,
  'TDH RESEARCH:',
  blocksText(q.research),
  q.note.length ? `ADDITIONAL NOTE:\n${q.note.map((p) => `- ${strip(p)}`).join('\n')}` : '',
].filter(Boolean).join('\n');

const cleanMcq = (m) => {
  const opts = ['a', 'b', 'c', 'd'].map((key) => ({ key, text: strip(m?.options?.[key]) }));
  const answer = String(m?.answer || '').trim().toLowerCase().replace(/[^a-d]/g, '');
  const questionText = strip(m?.question);
  if (!questionText || opts.some((o) => !o.text) || !/^[a-d]$/.test(answer)) return null;
  return {
    type: /concept/i.test(m?.type) ? 'Conceptual' : 'Factual',
    questionText,
    // Options say "1 and 2 only", so the statements must carry their numbers.
    statements: (Array.isArray(m?.statements) ? m.statements : []).map(strip).filter(Boolean).slice(0, 6)
      .map((st, i) => (/^\d+[.)]\s/.test(st) ? st : `${i + 1}. ${st}`)),
    options: opts,
    answer,
    why: strip(m?.why).slice(0, 600),
    status: 'draft',
    by: 'ai',
  };
};

/** AI call for a few questions → [{ _id, mcqs }]. */
export const practiceBatch = async (questions) => {
  const out = await runJsonExtraction({
    system: SYSTEM,
    prompt: questions.map(itemText).join('\n\n---\n\n'),
    maxOutputTokens: 800 * questions.length,
    maxRetries: 3,
  });
  const results = Array.isArray(out?.results) ? out.results : [];
  return questions.map((q, i) => {
    const r = results.find((x) => Number(String(x?.item).replace(/\D/g, '')) === i + 1) || results[i];
    return { _id: q._id, mcqs: (Array.isArray(r?.mcqs) ? r.mcqs : []).map(cleanMcq).filter(Boolean).slice(0, PER_QUESTION) };
  });
};

/** Save a batch result: replace the AI drafts, keep anything the admin made or approved. */
export const savePractice = async (q, mcqs) => {
  const keep = (q.practice || []).filter((p) => p.by === 'admin' || p.status === 'approved');
  await TdhQuestion.updateOne({ _id: q._id }, { $set: { practice: [...keep, ...mcqs], practiceAt: new Date() } });
};

// ------------------------------------------------------------------ job (one per set, in memory)

const jobs = new Map();

export const getPracticeJob = (setId) => {
  const j = jobs.get(String(setId));
  return j ? { state: j.state, done: j.done, total: j.total, made: j.made, error: j.error } : null;
};

export const stopPracticeJob = (setId) => {
  const j = jobs.get(String(setId));
  if (j?.state === 'running') j.stop = true;
};

/**
 * Start writing practice MCQs for a set.
 *   limit   only the first N questions still needing them (a trial run)
 *   section only this section
 *   redo    also questions that already have AI drafts
 */
export const startPracticeJob = async (setId, { limit = 0, section = null, redo = false } = {}) => {
  const key = String(setId);
  if (jobs.get(key)?.state === 'running') throw Object.assign(new Error('Already running for this set'), { status: 409 });
  assertAiConfigured();
  const set = await TdhSet.findById(setId).lean();
  if (!set) throw Object.assign(new Error('Set not found'), { status: 404 });

  const filter = {
    set: setId,
    hidden: false,
    'research.0': { $exists: true },
    ...(section ? { section } : {}),
    ...(redo ? {} : { practiceAt: null }),
  };
  let list = await TdhQuestion.find(filter).sort({ section: 1, n: 1 }).lean();
  if (limit > 0) list = list.slice(0, limit);

  const job = { state: 'running', done: 0, total: list.length, made: 0, error: '', stop: false };
  jobs.set(key, job);

  (async () => {
    try {
      for (let i = 0; i < list.length && !job.stop; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const results = await practiceBatch(batch);
        for (const r of results) {
          const q = batch.find((x) => String(x._id) === String(r._id));
          if (r.mcqs.length) await savePractice(q, r.mcqs);
          job.made += r.mcqs.length;
        }
        job.done += batch.length;
      }
      job.state = job.stop ? 'stopped' : 'done';
    } catch (err) {
      console.error(`tdh practice job ${key}:`, err);
      Object.assign(job, { state: 'failed', error: isQuotaError(err) ? 'AI quota reached — try again later' : (err.message || 'AI step failed') });
    }
  })();

  return getPracticeJob(setId);
};
