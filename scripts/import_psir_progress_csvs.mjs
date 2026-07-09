// One-time import of the 4 PSIR (Political Science & IR) Progress question-index CSVs
// (project root: PSIR_Paper_{1A,1B,2A,2B}_Questions.csv) into the existing "PSIR" Course's
// Topic/ProgressQuestion data, matched to that course's fileIndex per paper, then flips
// progressEnabled on so the paper picker shows up for students - same flow as Sociology/Anthropology.
//
// The source CSVs have their curly quotes/apostrophes mojibake'd (UTF-8 bytes that got
// misread as Windows-1252 at some earlier export step) - cleanMojibake() reverses that.
// Not blindly rerunnable: uses upsertTopicsAndQuestions (additive/upsert), so rerunning
// after a successful import would duplicate questions. Guarded with a per-file existing-Topic
// check that skips (unless --force) instead of double-importing.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { parse } from 'csv-parse/sync';
import Course from '../models/Course.js';
import Topic from '../models/Topic.js';
import { upsertTopicsAndQuestions } from '../controllers/progressController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const ROOT_DIR = path.join(__dirname, '..', '..');
const FORCE = process.argv.includes('--force');

const PAPERS = [
  { code: '1A', file: 'PSIR_Paper_1A_Questions.csv' },
  { code: '1B', file: 'PSIR_Paper_1B_Questions.csv' },
  { code: '2A', file: 'PSIR_Paper_2A_Questions.csv' },
  { code: '2B', file: 'PSIR_Paper_2B_Questions.csv' },
];

// Reverses UTF-8-decoded-as-Windows-1252 mojibake (e.g. "â€œ" -> """) by re-encoding the
// mangled string as win1252 bytes and decoding those as UTF-8. One sequence ("â€?") lost its
// original byte entirely during the original corruption (undefined win1252 code point 0x9D got
// coerced to a literal "?") and round-trips to a stray replacement char - patched back to a
// right double quotation mark as a special case since every occurrence in these files closes a
// left double quote opened earlier in the same cell.
const cleanMojibake = (text) => {
  let fixed = iconv.encode(text, 'win1252').toString('utf8');
  fixed = fixed.replace(/�\?/g, '”');
  return fixed;
};

const loadRows = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const cleaned = cleanMojibake(raw);
  // Strip the "# ..." comment lines and blank line preceding the real header row.
  const csvText = cleaned.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  return records.map((r) => ({
    topicName: (r['Topic'] || '').trim(),
    questionText: (r['Question Text'] || '').trim(),
    pageNumber: r['Approx. Page No.'],
    tag: ''
  }));
};

const normalizeFileName = (name) => (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const findFileIndex = (course, paperCode) => {
  const idx = course.fileNames.findIndex((name) => normalizeFileName(name).endsWith(paperCode));
  return idx;
};

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('No MONGODB_URI found');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const course = await Course.findOne({ courseId: 'PSIR' });
  if (!course) {
    console.error('No Course with courseId "PSIR" found - aborting.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Found course "${course.name}" (${course._id}), fileNames: ${JSON.stringify(course.fileNames)}`);

  const results = [];
  for (const paper of PAPERS) {
    const fileIndex = findFileIndex(course, paper.code);
    if (fileIndex === -1) {
      console.log(`SKIP ${paper.file}: no fileName on the course matches paper code "${paper.code}"`);
      continue;
    }

    const existingTopicCount = await Topic.countDocuments({ course: course._id, fileIndex });
    if (existingTopicCount > 0 && !FORCE) {
      console.log(`SKIP ${paper.file}: fileIndex ${fileIndex} ("${course.fileNames[fileIndex]}") already has ${existingTopicCount} topic(s). Pass --force to import anyway (will duplicate questions).`);
      continue;
    }

    const rows = loadRows(path.join(ROOT_DIR, paper.file));
    const result = await upsertTopicsAndQuestions(course, fileIndex, rows);
    results.push({ paper: paper.code, fileIndex, fileName: course.fileNames[fileIndex], ...result });
  }

  console.log('\n=== Import summary ===');
  let totalInserted = 0;
  for (const r of results) {
    console.log(`\nPaper ${r.paper} -> fileIndex ${r.fileIndex} ("${r.fileName}")`);
    console.log(`  inserted: ${r.insertedCount} question(s) across ${r.touchedTopicCount} topic(s) (${r.newTopicsCount} new)`);
    if (r.skippedRows.length > 0) {
      console.log(`  skipped ${r.skippedRows.length} row(s):`);
      for (const s of r.skippedRows) console.log(`    - row ${s.row}: ${s.reason}`);
    }
    totalInserted += r.insertedCount;
  }
  console.log(`\nTOTAL: ${totalInserted} question(s) inserted across ${results.length} paper(s).`);

  if (!course.progressEnabled) {
    course.progressEnabled = true;
    await course.save();
    console.log('\nEnabled progressEnabled on the PSIR course.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
