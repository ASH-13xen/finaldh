// One-off importer for a "PYQ + printed model answer" JSON extracted from a
// source PDF by hand (e.g. ss/GS_1_Model_Answers__2018-2025.json). Cleanup logic
// lives in utils/pyqJsonImport.js (shared with the admin "PYQ Ingest > JSON"
// upload) — see that file for the full rationale.
//
// Unlike scripts/generate_pyq_answers.mjs this makes NO AI call: the answer
// text is the book's own, lifted verbatim (pyqAnswer.source = 'pdf'), which is
// both free and immune to the hallucination/quality complaints an AI-synthesized
// answer had.
//
// Usage:
//   node scripts/import_pdf_pyq_answers.mjs --file ss/GS_1_Model_Answers__2018-2025.json --subject GS-1 --source-label "GS 1 Model Answers (2018-2025)"
//   node scripts/import_pdf_pyq_answers.mjs --file ... --subject GS-1 --dry-run
//   node scripts/import_pdf_pyq_answers.mjs --file ... --subject GS-1 --publish   # publish immediately instead of leaving as drafts
//
// Duplicate-safe: matches existing ToppersPyq rows quote/spacing-insensitively
// (the admin commit endpoint does the same — see commitPyqJob in
// controllers/toppersCopyController.js) so re-running, or running after the
// question was already committed via the PDF pipeline, merges instead of
// creating a second doc.

import 'dotenv/config';
import fs from 'fs/promises';
import crypto from 'crypto';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';
import { cleanPyqJsonRows } from '../utils/pyqJsonImport.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const FILE = getArg('--file', null);
const SUBJECT = getArg('--subject', null);
const SOURCE_LABEL = getArg('--source-label', '');
const PUBLISH = args.includes('--publish');
const DRY_RUN = args.includes('--dry-run');

if (!FILE || !SUBJECT) {
  console.error('Usage: node scripts/import_pdf_pyq_answers.mjs --file <path.json> --subject GS-1 [--source-label "..."] [--publish] [--dry-run]');
  process.exit(1);
}

const normalizeForDedup = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const fuzzyQuestionNorm = (s) => normalizeForDedup(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const pyqDedupeKey = (subject, year, questionText) =>
  crypto.createHash('sha1').update(`${String(subject).toLowerCase()}::${year}::${normalizeForDedup(questionText)}`).digest('hex');

async function main() {
  const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
  console.log(`${raw.length} row(s) in ${FILE}`);

  const { rows, diagramReport, mergedFragments } = cleanPyqJsonRows(raw, { defaultSubject: SUBJECT });
  console.log(`After cleanup: ${rows.length} question(s), ${mergedFragments} orphan fragment(s) merged back in.`);
  console.log(`${diagramReport.length} question(s) flag a diagram not yet re-uploaded.`);

  if (DRY_RUN) {
    console.log('--dry-run: not writing to the database. Sample row:');
    console.log(JSON.stringify(rows[0], null, 2).slice(0, 1500));
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await ToppersPyq.find({ subject: SUBJECT }).lean();
  const existingByKey = new Map(existing.map((d) => [`${d.year}::${fuzzyQuestionNorm(d.questionText)}`, d]));

  let created = 0, merged = 0, conflicts = 0;
  for (const row of rows) {
    const key = `${row.year}::${fuzzyQuestionNorm(row.questionText)}`;
    const match = existingByKey.get(key);

    if (match) {
      const patch = {};
      if (!match.section && row.section) patch.section = row.section;
      if (!match.topic && row.topic) patch.topic = row.topic;
      if (match.marks == null && row.marks != null) patch.marks = row.marks;
      if (!match.pyqAnswer?.generatedAt || !match.pyqAnswer.published) {
        patch.pyqAnswer = {
          source: 'pdf', rawText: row.answerText, pendingDiagramPages: row.diagramPages,
          images: match.pyqAnswer?.images || [], diagram: match.pyqAnswer?.diagram || {},
          aiModel: '', generatedAt: new Date(), editedAt: null, published: PUBLISH,
        };
      } else {
        console.warn(`  [conflict] "${row.questionText.slice(0, 70)}" already has a PUBLISHED answer — left untouched.`);
        conflicts += 1;
      }
      if (Object.keys(patch).length) {
        await ToppersPyq.updateOne({ _id: match._id }, { $set: patch });
        merged += 1;
      }
      continue;
    }

    await ToppersPyq.create({
      subject: SUBJECT, section: row.section, topic: row.topic, microtheme: '',
      questionText: row.questionText, year: row.year, marks: row.marks, sourceLabel: SOURCE_LABEL,
      dedupeKey: pyqDedupeKey(SUBJECT, row.year, row.questionText),
      pyqAnswer: {
        source: 'pdf', rawText: row.answerText, pendingDiagramPages: row.diagramPages,
        aiModel: '', generatedAt: new Date(), editedAt: null, published: PUBLISH,
      },
    });
    created += 1;
  }

  console.log(`Done. Created ${created}, merged ${merged}, ${conflicts} conflict(s) left untouched.`);

  if (diagramReport.length) {
    console.log('\nQuestions with a pending diagram (screenshot the page(s) and upload via admin > Manage PYQs):');
    for (const d of diagramReport) console.log(`  page(s) ${d.pages.join(',')} — ${d.questionText.slice(0, 90)}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
