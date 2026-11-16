// "How to answer the 100 most-asked questions", prepared from the question bank in two AI steps:
//  1. choose - the most-asked question families go to Gemini, which merges wordings of the same question
//     ("Tell us about your education and work experience" comes in a dozen), turns subject- and year-specific
//     ones into one general question ("Why did you choose your optional subject?"), and leaves out ones that
//     only fit one kind of candidate ("Why is Kerala called God's Own Country?");
//  2. write - for every question, in batches: what it tests, a structure, do's and don'ts, in English and Hindi.
// Pointers, never scripted answers. Runs in the background; an admin reviews and publishes the result.
import { getCorpusIndex } from './corpusIndex.js';
import { generateJson, usageTotals } from './gemini.js';
import { prepKey } from './prepKey.js';
import InterviewGuide from '../../models/InterviewGuide.js';

export const GUIDE_KEY = 'top100';
export const GUIDE_SIZE = 100;
const CANDIDATES = 280;
const BATCH = 10;
const PARALLEL = 3;
const STALE_MS = 3 * 60 * 1000; // a job not heard from in this long died with its server (it beats every 30 s)
const BEAT_MS = 30 * 1000;

const str = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (x, n, len) => (Array.isArray(x) ? x.map((v) => str(v, len)).filter(Boolean).slice(0, n) : []);

export const sanitizeGuidance = (g) => {
  if (!g || typeof g !== 'object') return null;
  const out = { tests: str(g.tests, 300), structure: list(g.structure, 5, 220), dos: list(g.dos, 4, 220), donts: list(g.donts, 4, 220) };
  return out.tests && out.structure.length ? out : null;
};

// The families worth offering to step 1: most asked first, enough of them to fill the guide after merging.
export const guideCandidates = (idx, n = CANDIDATES) => [...idx.families]
  .filter((f) => f.transcriptCount >= 3)
  .sort((a, b) => b.transcriptCount - a.transcriptCount)
  .slice(0, n)
  .map((f, i) => ({ i, id: f.id, text: f.text, timesAsked: f.transcriptCount, years: f.years || [], qtype: f.qtype || '' }));

// Step 1's reply -> entries: each chosen question with the families merged into it, counted together.
export const entriesFromChoice = (candidates, choice, size = GUIDE_SIZE) => {
  const byI = new Map(candidates.map((c) => [c.i, c]));
  const used = new Set();
  const out = [];
  for (const q of Array.isArray(choice?.questions) ? choice.questions : []) {
    const text = str(q?.text, 300);
    const members = [...new Set((Array.isArray(q?.ids) ? q.ids : []).map(Number))].filter((i) => byI.has(i) && !used.has(i)).map((i) => byI.get(i));
    if (!text || !members.length) continue;
    members.forEach((m) => used.add(m.i));
    out.push({
      key: prepKey(text),
      text,
      qtype: str(q?.type, 20) || members[0].qtype,
      timesAsked: members.reduce((a, m) => a + m.timesAsked, 0),
      years: [...new Set(members.flatMap((m) => m.years))].sort(),
      familyIds: members.map((m) => m.id)
    });
  }
  const seen = new Set();
  return out
    .filter((e) => (seen.has(e.key) ? false : seen.add(e.key)))
    .sort((a, b) => b.timesAsked - a.timesAsked)
    .slice(0, size);
};

const CHOOSE_SYSTEM = 'You are an experienced UPSC Civil Services interview mentor building a study guide from real interview data.';
const choosePrompt = (candidates, stats, size) => `Below are the most-asked questions from ${stats.transcripts} real UPSC interviews (CSE ${stats.years.join(', ')}), one per line as "id | times asked | question".
Build the list for a guide called "How to answer the ${size} most-asked interview questions":
- Merge questions that ask the same thing in different words, or the same thing for different years, subjects or places: every "What have you been doing since <year>?" is one question; every "Why did you choose <subject> as your optional?" becomes "Why did you choose your optional subject?".
- Leave out greetings and small talk, and questions that fit only one kind of candidate and cannot be made general (a particular state, city, college, company or hobby).
- Keep the wording natural, as a board member would ask it, in English.
Return JSON {"questions":[{"text":"the question","ids":[every id merged into it],"type":"personal|motivation|factual|opinion|situational"}]} with about ${size + 10} questions.
QUESTIONS:
${candidates.map((c) => `${c.i} | ${c.timesAsked} | ${c.text}`).join('\n')}`;

const WRITE_SYSTEM = 'You coach UPSC Civil Services interview (Personality Test) candidates: concrete, balanced and calm, in the voice of an experienced mentor. You never invent statistics, dates or quotes.';
const writePrompt = (batch) => `For each UPSC interview question below, write guidance for a candidate. Return JSON {"items":[{"i":0,"textHi":"the question in Hindi","en":G,"hi":G}]}
G = {"tests":"what the board is really checking, one sentence","structure":["3-4 short steps of a strong answer"],"dos":["3 specific do's"],"donts":["3 specific don'ts"]}
Rules: pointers, not a script - the answer must be the candidate's own, so never write out an answer. Concrete and practical, under 25 words per point. Use only well-established facts and no statistics. "hi" (and "textHi") in natural Hindi (Devanagari) for Hindi-medium aspirants; keep acronyms as they are.
QUESTIONS:
${batch.map((e, i) => `${i}. ${e.text} (asked in ${e.timesAsked} interviews; ${e.qtype || 'general'})`).join('\n')}`;

const writeBatch = async (batch) => {
  const raw = await generateJson({ system: WRITE_SYSTEM, prompt: writePrompt(batch), temperature: 0.4, maxOutputTokens: 16000, thinking: 'low', retries: 2 });
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return batch.map((e, i) => {
    const it = items.find((x) => Number(x?.i) === i) || items[i] || {};
    return { ...e, textHi: str(it.textHi, 300), en: sanitizeGuidance(it.en), hi: sanitizeGuidance(it.hi) };
  });
};

const running = { job: null };
export const guideJobRunning = () => !!running.job;

const setProgress = (patch) => InterviewGuide.updateOne({ key: GUIDE_KEY }, { $set: patch });

// Starts preparing the guide in the background (the working copy; what students see changes only when an
// admin publishes). Returns false when a job is already running.
export const startGuideJob = async ({ size = GUIDE_SIZE } = {}) => {
  if (running.job) return false;
  const doc = await InterviewGuide.findOne({ key: GUIDE_KEY }).lean();
  if (doc?.status === 'generating' && Date.now() - new Date(doc.updatedAt).getTime() < STALE_MS) return false;
  await InterviewGuide.updateOne(
    { key: GUIDE_KEY },
    { $set: { status: 'generating', error: '', progress: { done: 0, total: 0, step: 'choose' } }, $setOnInsert: { key: GUIDE_KEY } },
    { upsert: true }
  );
  // Heartbeat: keeps updatedAt fresh while the job lives, so a job lost to a restart shows as failed.
  const beat = setInterval(() => { InterviewGuide.updateOne({ key: GUIDE_KEY, status: 'generating' }, { $set: { error: '' } }).catch(() => {}); }, BEAT_MS);
  beat.unref?.();
  const before = { ...usageTotals };
  running.job = (async () => {
    try {
      const idx = await getCorpusIndex();
      const candidates = guideCandidates(idx);
      const choice = await generateJson({ system: CHOOSE_SYSTEM, prompt: choosePrompt(candidates, idx.stats, size), temperature: 0.2, maxOutputTokens: 16000, thinking: 'medium', retries: 2 });
      // A few spare questions are written so the guide still has `size` if some come back without guidance.
      const entries = entriesFromChoice(candidates, choice, size + 10);
      if (entries.length < Math.min(20, size)) throw new Error(`Only ${entries.length} questions came back from the selection step.`);
      const batches = [];
      for (let i = 0; i < entries.length; i += BATCH) batches.push(entries.slice(i, i + BATCH));
      await setProgress({ progress: { done: 0, total: entries.length, step: 'write' } });
      const written = new Array(batches.length);
      let done = 0;
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const b = next++;
          written[b] = await writeBatch(batches[b]);
          done += batches[b].length;
          await setProgress({ 'progress.done': done });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
      const final = written.flat().filter((e) => e.en).slice(0, size);
      if (final.length < Math.min(size, entries.length) * 0.8) throw new Error('Too many questions came back without guidance. Try again.');
      await setProgress({
        status: 'ready',
        entries: final.map((e) => ({ ...e, hidden: false })),
        corpus: { interviews: idx.stats.transcripts, years: idx.stats.years },
        generatedAt: new Date(),
        progress: { done: final.length, total: final.length, step: 'done' }
      });
      console.log(`[interview] guide prepared: ${final.length} questions (calls ${usageTotals.calls - before.calls}, tokens in ${usageTotals.input - before.input}, out ${usageTotals.output - before.output}, thinking ${usageTotals.thinking - before.thinking})`);
    } catch (err) {
      console.error('[interview] guide job failed:', err);
      await setProgress({ status: 'failed', error: String(err?.message || err).slice(0, 300) }).catch(() => {});
    } finally {
      clearInterval(beat);
      running.job = null;
    }
  })();
  return true;
};

// For tests: wait for the job started by startGuideJob.
export const guideJobDone = () => running.job || Promise.resolve();

// A job left "generating" by a server that restarted reports as failed.
export const guideStatusOf = (doc) => {
  if (!doc) return 'empty';
  if (doc.status === 'generating' && !running.job && Date.now() - new Date(doc.updatedAt).getTime() > STALE_MS) return 'failed';
  return doc.status;
};
