// One-time import of PSIR (Political Science & IR) Paper-1A/1B/2A/2B previous-year-questions
// (project root: PSIR_Paper_{1A,1B,2A,2B}_PYQs.csv) into ProgressPyq, course+fileIndex scoped -
// same shape as the Sociology/Anthropology PYQ data (not the legacy subject-only CSV path).
//
// `section` values are set to the exact Topic.name strings already used by the PSIR
// question-checklist import (see import_psir_progress_csvs.mjs) so PyQs surface against the
// matching topic via tagMatcher's substring match.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import Course from '../models/Course.js';
import ProgressPyq from '../models/ProgressPyq.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const ROOT_DIR = path.join(__dirname, '..', '..');
const FORCE = process.argv.includes('--force');

const PAPERS = [
  { code: '1A', file: 'PSIR_Paper_1A_PYQs.csv' },
  { code: '1B', file: 'PSIR_Paper_1B_PYQs.csv' },
  { code: '2A', file: 'PSIR_Paper_2A_PYQs.csv' },
  { code: '2B', file: 'PSIR_Paper_2B_PYQs.csv' },
];

const normalizeFileName = (name) => (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const findFileIndex = (course, paperCode) =>
  course.fileNames.findIndex((name) => normalizeFileName(name).endsWith(paperCode));

const loadRows = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  return records.map((r) => ({
    questionText: (r['question text'] || '').trim(),
    section: (r['section'] || '').trim(),
    year: parseInt(r['year'], 10),
  }));
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

  let totalInserted = 0;
  for (const paper of PAPERS) {
    const fileIndex = findFileIndex(course, paper.code);
    if (fileIndex === -1) {
      console.log(`SKIP ${paper.file}: no fileName on the course matches paper code "${paper.code}"`);
      continue;
    }

    const existingCount = await ProgressPyq.countDocuments({ course: course._id, fileIndex });
    if (existingCount > 0 && !FORCE) {
      console.log(`SKIP ${paper.file}: fileIndex ${fileIndex} ("${course.fileNames[fileIndex]}") already has ${existingCount} PYQ(s). Pass --force to import anyway (will duplicate).`);
      continue;
    }
    if (existingCount > 0 && FORCE) {
      await ProgressPyq.deleteMany({ course: course._id, fileIndex });
      console.log(`--force: cleared ${existingCount} existing PYQ(s) for fileIndex ${fileIndex}.`);
    }

    const rows = loadRows(path.join(ROOT_DIR, paper.file));
    const docs = rows.map((r) => ({
      questionText: r.questionText,
      subject: course.subject,
      course: course._id,
      fileIndex,
      section: r.section,
      year: r.year,
    }));

    const inserted = await ProgressPyq.insertMany(docs);
    console.log(`Paper ${paper.code} -> fileIndex ${fileIndex} ("${course.fileNames[fileIndex]}"): inserted ${inserted.length} PYQ(s).`);
    totalInserted += inserted.length;
  }

  console.log(`\nTOTAL: ${totalInserted} PYQ(s) inserted.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
