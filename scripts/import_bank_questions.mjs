// Bulk-imports a PYQ JSON dump into a Question Bank. Shares the row mapper with the admin
// import endpoint (utils/bankImport.js).
//
// Creates the QuestionBank metadata doc if it doesn't exist (matched by --subject). Re-running
// REPLACES that bank's questions unless you pass --append.
//
// Usage:
//   node scripts/import_bank_questions.mjs --file ./polity_pyq.json --subject "Indian Polity" --title "Indian Polity — Question Bank"
//   node scripts/import_bank_questions.mjs --file ./more.json --subject "Indian Polity" --append
//   node scripts/import_bank_questions.mjs --file ./x.json --subject Geography --dry-run
//   node scripts/import_bank_questions.mjs --file ./x.json --subject Geography --publish

import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import QuestionBank from '../models/QuestionBank.js';
import QuizQuestion from '../models/QuizQuestion.js';
import QuizAttempt from '../models/QuizAttempt.js';
import { mapBank } from '../utils/bankImport.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const FILE = getArg('--file');
const SUBJECT = getArg('--subject');
const TITLE = getArg('--title', SUBJECT ? `${SUBJECT} — Question Bank` : null);
const APPEND = args.includes('--append');
const DRY_RUN = args.includes('--dry-run');
const PUBLISH = args.includes('--publish');

if (!FILE || !SUBJECT) {
  console.error('Required: --file <path> --subject "<subject key>"  [--title "..."] [--append] [--dry-run] [--publish]');
  process.exit(1);
}
const filePath = path.resolve(process.cwd(), FILE);
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.questions;
  const { docs, skipped, duplicates } = mapBank(rows);

  console.log(`Read ${rows.length} row(s).`);
  console.log(`  usable: ${docs.length}   skipped: ${skipped.length}   duplicates dropped: ${duplicates}`);
  for (const s of skipped.slice(0, 20)) console.log(`    - row ${s.row}: ${s.reason}`);
  if (skipped.length > 20) console.log(`    ... and ${skipped.length - 20} more`);

  const byTopic = {};
  for (const d of docs) byTopic[d.topic] = (byTopic[d.topic] || 0) + 1;
  console.log(`  topics: ${Object.keys(byTopic).length}`);
  const withWhy = docs.filter((d) => d.whyCorrect).length;
  console.log(`  with explanation: ${withWhy}/${docs.length}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written. Sample:\n');
    console.log(JSON.stringify({ subject: SUBJECT, seq: 0, ...docs[0] }, null, 2));
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  let bank = await QuestionBank.findOne({ subject: SUBJECT });
  if (!bank) {
    const count = await QuestionBank.countDocuments({});
    bank = await QuestionBank.create({ subject: SUBJECT, title: TITLE, order: count });
    console.log(`\nCreated bank "${TITLE}" (${SUBJECT}).`);
  } else {
    console.log(`\nUsing existing bank "${bank.title}" (${SUBJECT}).`);
  }

  const baseSeq = APPEND
    ? ((await QuizQuestion.findOne({ subject: SUBJECT }).sort({ seq: -1 }).select('seq'))?.seq ?? -1) + 1
    : 0;

  if (!APPEND) {
    const removed = (await QuizQuestion.deleteMany({ subject: SUBJECT })).deletedCount;
    if (removed) console.log(`--replace: removed ${removed} existing question(s).`);
    await QuizAttempt.updateMany(
      { subject: SUBJECT, status: 'in-progress' },
      { status: 'completed', completedAt: new Date() }
    );
  }

  const BATCH = 500;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH).map((d, j) => ({ ...d, subject: SUBJECT, seq: baseSeq + i + j }));
    await QuizQuestion.insertMany(batch);
    process.stdout.write(`  inserted ${Math.min(i + BATCH, docs.length)}/${docs.length}\r`);
  }

  const total = await QuizQuestion.countDocuments({ subject: SUBJECT });
  if (PUBLISH) { bank.isPublished = true; await bank.save(); }

  console.log(`\n\nDone. Bank "${bank.title}" now has ${total} question(s) in ${Object.keys(byTopic).length} topics.`);
  console.log(bank.isPublished ? 'Bank is PUBLISHED.' : 'Bank is a draft — publish it from the admin portal.');
  console.log('Optional: node scripts/generate_quiz_ai.mjs   (fills whyCorrect + hint for un-annotated questions)');
}

main()
  .catch((err) => { console.error('Import failed:', err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
