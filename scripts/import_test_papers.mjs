// Imports JSON test papers from backend/tests/*.json (filename pattern: {subject}_{paperNumber}.json)
// into the MCQ Test feature - one McqTest per file. Reusable/rerunnable: drop a new matching file
// in and run again. Re-running an existing paper REPLACES its questions (same convention as the
// admin CSV upload for this feature).
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import McqTest from '../models/McqTest.js';
import McqQuestion from '../models/McqQuestion.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(__dirname, '..', 'tests');
const MARKS_PER_QUESTION = 2;
const NEGATIVE_MARKING_RATIO = 0.33;
const MINUTES_PER_QUESTION = 1.2;

const DIFFICULTY_MAP = { easy: 'Easy', moderate: 'Medium', difficult: 'Hard' };
const VALID_TYPES = ['conceptual', 'factual'];

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const mapQuestion = (q, fileLabel) => {
  const rowLabel = `${fileLabel} id=${q.id}`;

  if (!Array.isArray(q.options) || q.options.length !== 4) {
    return { skip: { row: rowLabel, reason: `Expected 4 options, found ${q.options?.length ?? 0}` } };
  }
  const optionLabels = q.options.map(o => o.key);
  if (!optionLabels.includes(q.answer)) {
    return { skip: { row: rowLabel, reason: `answer "${q.answer}" not among option keys [${optionLabels.join(',')}]` } };
  }
  if (!q.question || !q.question.trim()) {
    return { skip: { row: rowLabel, reason: 'Missing question text' } };
  }
  if (!q.explanation || !q.explanation.trim()) {
    return { skip: { row: rowLabel, reason: 'Missing explanation' } };
  }

  const difficultyRaw = (q.difficulty || '').toLowerCase();
  const difficulty = DIFFICULTY_MAP[difficultyRaw] || 'Medium';

  const typeRaw = (q.type || '').toLowerCase();
  const questionType = VALID_TYPES.includes(typeRaw) ? typeRaw : 'conceptual';

  return {
    doc: {
      order: q.id,
      questionText: q.question.trim(),
      options: q.options.map(o => ({ label: o.key, text: o.text })),
      correctOption: q.answer,
      explanation: q.explanation.trim(),
      difficulty,
      questionType,
      examSource: q.exam || '',
      tags: [],
      rawTags: []
    }
  };
};

async function importFile(filePath) {
  const filename = path.basename(filePath);
  const match = filename.match(/^([a-z]+)_(\d+)\.json$/i);
  if (!match) {
    console.log(`SKIP FILE (name doesn't match {subject}_{paperNumber}.json): ${filename}`);
    return null;
  }

  const [, subjectSlug, paperNumber] = match;
  const subject = capitalize(subjectSlug.toLowerCase());
  const title = `${subject} Paper ${paperNumber}`;

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const questions = raw.questions || [];

  const skippedRows = [];
  const docs = [];
  for (const q of questions) {
    const result = mapQuestion(q, filename);
    if (result.skip) skippedRows.push(result.skip);
    else docs.push(result.doc);
  }

  let test = await McqTest.findOne({ subject, title });
  const durationMinutes = Math.round(docs.length * MINUTES_PER_QUESTION);
  const totalMarks = docs.length * MARKS_PER_QUESTION;

  if (!test) {
    test = await McqTest.create({
      title,
      subject,
      description: `Sectional MCQ practice paper - ${title}, compiled from real UPSC and allied exams.`,
      durationMinutes,
      marksPerQuestion: MARKS_PER_QUESTION,
      negativeMarkingRatio: NEGATIVE_MARKING_RATIO,
      questionCount: docs.length,
      totalMarks
    });
  } else {
    test.durationMinutes = durationMinutes;
    test.questionCount = docs.length;
    test.totalMarks = totalMarks;
    await test.save();
  }

  await McqQuestion.deleteMany({ test: test._id });
  const inserted = docs.length > 0 ? await McqQuestion.insertMany(docs.map(d => ({ ...d, test: test._id }))) : [];

  return { filename, title, subject, testId: test._id.toString(), insertedCount: inserted.length, skippedRows };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const files = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith('.json')).sort();
  const results = [];
  for (const f of files) {
    const result = await importFile(path.join(TESTS_DIR, f));
    if (result) results.push(result);
  }

  console.log('\n=== Import summary ===');
  let totalInserted = 0;
  let totalSkipped = 0;
  for (const r of results) {
    console.log(`\n${r.filename} -> "${r.title}" (subject: ${r.subject}, testId: ${r.testId})`);
    console.log(`  inserted: ${r.insertedCount}, skipped: ${r.skippedRows.length}`);
    for (const s of r.skippedRows) console.log(`    - ${s.row}: ${s.reason}`);
    totalInserted += r.insertedCount;
    totalSkipped += r.skippedRows.length;
  }
  console.log(`\nTOTAL: ${totalInserted} question(s) inserted across ${results.length} test(s), ${totalSkipped} skipped.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
