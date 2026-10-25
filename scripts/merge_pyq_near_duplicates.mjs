// One-off cleanup: finds PYQ pairs (same subject+year) whose question text is
// nearly identical (token-Jaccard similarity, not just punctuation/quote
// differences — see merge_pyq_pdf_duplicates.mjs for that narrower case) and
// merges them. These arise from two independent extractions of the same source
// book (the app's original PDF-vision ingest vs. a later hand-extracted JSON
// import) disagreeing on a word, a typo, or a missing word — e.g. "the then
// Indian rulers" vs "the Indian rulers", "Jotirao" vs "Joti Rao".
//
// The OLDER doc (by createdAt) is kept as canonical; the newer one's pyqAnswer
// is moved onto it (only if the older doc's answer isn't already published —
// same "never silently overwrite a published answer" rule as commitPyqJob),
// then the newer doc is deleted. A pair where the KEPT doc already has a
// published answer is left entirely untouched (both docs survive) and reported
// as a conflict for manual review in Manage PYQs — safer than commitPyqJob's
// merge path, which would discard the incoming answer text; here nothing is
// lost, it just isn't auto-applied.
//
// Usage: node scripts/merge_pyq_near_duplicates.mjs [--subject GS-1] [--threshold 0.75] [--dry-run]

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
const SUBJECT = getArg('--subject', null);
const THRESHOLD = Number(getArg('--threshold', '0.75'));
const DRY_RUN = args.includes('--dry-run');

const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
const jaccard = (a, b) => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const filter = SUBJECT ? { subject: SUBJECT } : {};
  const docs = await ToppersPyq.find(filter).lean();
  console.log(`${docs.length} PYQ(s) to scan${SUBJECT ? ` (subject ${SUBJECT})` : ''}.`);

  const byYearSubject = {};
  for (const d of docs) (byYearSubject[`${d.subject}::${d.year}`] = byYearSubject[`${d.subject}::${d.year}`] || []).push(d);

  const pairs = [];
  const claimed = new Set(); // a doc can only be merged once per run
  for (const list of Object.values(byYearSubject)) {
    for (let i = 0; i < list.length; i++) {
      if (claimed.has(list[i]._id.toString())) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (claimed.has(list[j]._id.toString())) continue;
        const sim = jaccard(tok(list[i].questionText), tok(list[j].questionText));
        if (sim >= THRESHOLD) {
          pairs.push([list[i], list[j]]);
          claimed.add(list[i]._id.toString());
          claimed.add(list[j]._id.toString());
          break;
        }
      }
    }
  }

  console.log(`${pairs.length} near-duplicate pair(s) found (threshold ${THRESHOLD}).\n`);

  let merged = 0, conflicts = 0;
  for (const [x, y] of pairs) {
    const [keep, drop] = new Date(x.createdAt) <= new Date(y.createdAt) ? [x, y] : [y, x];

    if (keep.pyqAnswer?.published) {
      console.log(`[conflict] keep=${keep._id} already published — leaving both docs, review manually:`);
      console.log(`  KEEP: ${keep.questionText}`);
      console.log(`  DROP: ${drop.questionText}`);
      conflicts += 1;
      continue;
    }

    const patch = {};
    if (!keep.section && drop.section) patch.section = drop.section;
    if (!keep.topic && drop.topic) patch.topic = drop.topic;
    if (keep.marks == null && drop.marks != null) patch.marks = drop.marks;
    if (drop.pyqAnswer?.generatedAt && !keep.pyqAnswer?.generatedAt) patch.pyqAnswer = drop.pyqAnswer;

    console.log(`[merge] keep=${keep._id} <- drop=${drop._id}`);
    console.log(`  KEEP: ${keep.questionText}`);
    console.log(`  DROP: ${drop.questionText}`);

    if (!DRY_RUN) {
      if (Object.keys(patch).length) await ToppersPyq.updateOne({ _id: keep._id }, { $set: patch });
      await ToppersPyq.deleteOne({ _id: drop._id });
    }
    merged += 1;
  }

  console.log(`\nDone. Merged ${merged}, ${conflicts} conflict(s) left untouched for manual review.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
