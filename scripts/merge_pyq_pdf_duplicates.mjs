// One-off cleanup after import_pdf_pyq_answers.mjs created duplicate ToppersPyq
// docs: the app's dedupeKey hashes raw question text, but the hand-extracted PDF
// JSON uses different quote characters / spacing than what was already committed
// for the same PDF via the app's own ingest ("’" vs "'", extra space before "?"),
// so the same question hashed differently and upserted as a new doc instead of
// updating the old one.
//
// For each (year, loosely-normalized-question) group of size 2 where one doc has
// pyqAnswer.source === 'pdf': copy that pyqAnswer + section/topic/marks onto the
// OTHER (originally committed) doc — preserving its _id/createdAt/any admin edits
// — then delete the duplicate. The one case where the original doc already had a
// PUBLISHED AI answer is handled per explicit user decision: replace it with the
// book answer as an unpublished draft for review, not silently auto-publish.
//
// Usage: node scripts/merge_pyq_pdf_duplicates.mjs [--subject GS-1] [--dry-run]

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
const SUBJECT = getArg('--subject', 'GS-1');
const DRY_RUN = args.includes('--dry-run');

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[’‘]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const docs = await ToppersPyq.find({ subject: SUBJECT }).lean();

  const groups = {};
  for (const d of docs) {
    const key = `${d.year}::${norm(d.questionText)}`;
    (groups[key] = groups[key] || []).push(d);
  }
  const dupGroups = Object.values(groups).filter((g) => g.length > 1);
  console.log(`${dupGroups.length} duplicate group(s) found.`);

  let merged = 0, skipped = 0;
  for (const g of dupGroups) {
    if (g.length !== 2) { console.warn('Skipping unexpected group size', g.length, g.map((d) => d._id)); skipped += 1; continue; }
    const pdfDoc = g.find((d) => d.pyqAnswer?.source === 'pdf');
    const keepDoc = g.find((d) => d !== pdfDoc);
    if (!pdfDoc || !keepDoc) { console.warn('Skipping group with no pdf-sourced doc', g.map((d) => d._id)); skipped += 1; continue; }

    const hadPublishedAi = keepDoc.pyqAnswer?.generatedAt && keepDoc.pyqAnswer?.source !== 'pdf' && keepDoc.pyqAnswer?.published;
    const newPyqAnswer = hadPublishedAi
      ? { ...pdfDoc.pyqAnswer, published: false } // book answer replaces it, but as a draft for review
      : pdfDoc.pyqAnswer;

    console.log(`${hadPublishedAi ? '[had published AI answer -> replacing as draft]' : '[merge]'} ${keepDoc._id} <- ${pdfDoc._id} :: ${keepDoc.questionText.slice(0, 70)}`);

    if (!DRY_RUN) {
      await ToppersPyq.updateOne(
        { _id: keepDoc._id },
        { $set: { section: pdfDoc.section, topic: pdfDoc.topic, marks: keepDoc.marks ?? pdfDoc.marks, pyqAnswer: newPyqAnswer } },
      );
      await ToppersPyq.deleteOne({ _id: pdfDoc._id });
    }
    merged += 1;
  }

  console.log(`Merged ${merged}, skipped ${skipped}.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
