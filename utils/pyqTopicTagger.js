// pyqTopicTagger.js — puts each Toppers Copy PYQ under the right Toppers Copy topic.
//
// PYQs come from a different book than the topper copies, with their own headings
// ("Modern History › Personality Specific") that rarely match our topic names
// ("Personalities"), so name matching alone left most PYQs unplaced. Here the AI is
// shown the subject's topics (name, section, sub-topics, a few sample questions) and
// a batch of PYQs, and picks the best topic for each — or none.
//
// Runs in the background whenever PYQs are imported or edited, and for a whole
// subject whenever its topics change. A PYQ an admin placed by hand
// (tcTopicSource 'manual') is never re-tagged. Bulk / one-off runs:
// scripts/tag_pyq_topics.mjs.

import ToppersPyq from '../models/ToppersPyq.js';
import ToppersCopy from '../models/ToppersCopy.js';
import { runJsonExtraction, assertAiConfigured } from './aiProvider.js';

const BATCH = 25;
const SAMPLE_QUESTIONS = 4;
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const loadTopics = async (subject) => {
  const docs = await ToppersCopy.find({ subject })
    .select('syllabusSection topic subtopics.name questions.questionText')
    .sort({ syllabusSection: 1, order: 1, topic: 1 })
    .lean();
  return docs.map((d, i) => ({
    key: `T${i + 1}`,
    _id: d._id,
    label: [d.syllabusSection, d.topic].filter(Boolean).join(' › '),
    subtopics: (d.subtopics || []).map((s) => s.name).filter(Boolean),
    samples: (d.questions || []).slice(0, SAMPLE_QUESTIONS).map((q) => clip(q.questionText, 160)).filter(Boolean),
  }));
};

const buildPrompt = (subject, topics, pyqs) => {
  const topicLines = topics.map((t) => [
    `${t.key}: ${t.label}`,
    t.subtopics.length ? `   sub-topics: ${t.subtopics.join('; ')}` : '',
    t.samples.length ? `   questions it covers, e.g.: ${t.samples.map((q) => `"${q}"`).join(' | ')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const pyqLines = pyqs.map((p, i) => {
    const src = [p.section, p.topic, p.microtheme].filter(Boolean).join(' › ');
    return `P${i + 1}: (${p.year}${src ? `; source heading: ${src}` : ''}) ${clip(p.questionText, 600)}`;
  }).join('\n');

  return `You organise UPSC Civil Services Mains previous-year questions (PYQs) for the subject ${subject}.
Our study material for ${subject} is split into these topics:
${topicLines}

For each PYQ below, choose the ONE topic whose material would help a student most in answering it.
- Judge by what the question actually asks, not by the source heading's wording.
- If none of the topics genuinely covers the question, answer null. Do not force a fit
  (e.g. a geography or society question does not belong under a history topic).

PYQs:
${pyqLines}

Reply with JSON only:
{"tags":[{"id":"P1","topic":"T2","reason":"8-15 words on why"}, {"id":"P2","topic":null,"reason":"..."}]}
Include every PYQ id exactly once.`;
};

/**
 * Tag the given PYQs (by id). Manually placed PYQs are skipped.
 * @param {string[]} ids
 * @param {object}  [o]
 * @param {boolean} [o.save=true]   false = only return the proposals (dry run)
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{tagged:number, none:number, failed:number, proposals:object[]}>}
 */
export const tagPyqs = async (ids, { save = true, log = () => {} } = {}) => {
  const out = { tagged: 0, none: 0, failed: 0, proposals: [] };
  if (!ids?.length) return out;
  assertAiConfigured();

  const pyqs = await ToppersPyq.find({ _id: { $in: ids }, tcTopicSource: { $ne: 'manual' } })
    .select('subject section topic microtheme questionText year')
    .lean();
  const bySubject = new Map();
  for (const p of pyqs) {
    if (!bySubject.has(p.subject)) bySubject.set(p.subject, []);
    bySubject.get(p.subject).push(p);
  }

  for (const [subject, list] of bySubject) {
    const topics = await loadTopics(subject);
    if (!topics.length) { log(`${subject}: no Toppers Copy topics yet — left untagged`); continue; }
    const topicByKey = new Map(topics.map((t) => [t.key, t]));

    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      let tags;
      try {
        const res = await runJsonExtraction({ prompt: buildPrompt(subject, topics, batch), maxOutputTokens: 4000 });
        tags = Array.isArray(res?.tags) ? res.tags : Array.isArray(res) ? res : [];
      } catch (err) {
        out.failed += batch.length;
        log(`${subject}: batch ${i / BATCH + 1} failed — ${err.message || err}`);
        continue;
      }
      const byId = new Map(tags.map((t) => [String(t?.id || '').trim().toUpperCase(), t]));
      const now = new Date();
      const writes = [];
      batch.forEach((p, j) => {
        const t = byId.get(`P${j + 1}`);
        if (!t) { out.failed += 1; return; }
        const topic = t.topic ? topicByKey.get(String(t.topic).trim().toUpperCase()) : null;
        const reason = clip(t.reason, 200);
        if (topic) out.tagged += 1; else out.none += 1;
        out.proposals.push({ _id: p._id, questionText: p.questionText, topic: topic?.label || null, reason });
        writes.push({
          updateOne: {
            // never overwrite a placement an admin made while this was running
            filter: { _id: p._id, tcTopicSource: { $ne: 'manual' } },
            update: { $set: { tcTopic: topic?._id || null, tcTopicSource: 'ai', tcTopicReason: reason, tcTaggedAt: now } },
            timestamps: false,
          },
        });
      });
      if (save && writes.length) await ToppersPyq.bulkWrite(writes, { ordered: false });
      log(`${subject}: batch ${i / BATCH + 1} — ${writes.length} placed`);
    }
  }
  return out;
};

/** Ids of every PYQ in a subject the AI may (re)tag. `onlyUntagged` = only never-tagged ones. */
export const taggablePyqIds = async (subject, { onlyUntagged = false } = {}) => {
  const filter = { subject, tcTopicSource: onlyUntagged ? { $in: ['', null] } : { $ne: 'manual' } };
  const rows = await ToppersPyq.find(filter).select('_id').lean();
  return rows.map((r) => String(r._id));
};

// --- background queue -----------------------------------------------------------------
// One job at a time, in order, so an import and a topic edit landing together don't
// tag the same PYQs twice in parallel. Failures (no AI key, quota) are only logged —
// an untagged PYQ still shows via name matching, and an admin can re-run from the panel.

let chain = Promise.resolve();
const enqueue = (label, fn) => {
  chain = chain
    .then(fn)
    .then((r) => { if (r) console.log(`[pyqTopicTagger] ${label}: ${r.tagged} placed, ${r.none} in no topic, ${r.failed} failed`); })
    .catch((err) => console.warn(`[pyqTopicTagger] ${label} skipped: ${err.message || err}`));
  return chain;
};

/** Tag these PYQs in the background (after an import or an edit). */
export const queuePyqTagging = (ids) => {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) return Promise.resolve();
  return enqueue(`${list.length} PYQ(s)`, () => tagPyqs(list));
};

/** Re-tag a whole subject in the background (its topics changed). */
export const queueSubjectRetag = (subject, { onlyUntagged = false } = {}) => {
  if (!subject) return Promise.resolve();
  return enqueue(`re-tag ${subject}`, async () => tagPyqs(await taggablePyqIds(subject, { onlyUntagged })));
};
