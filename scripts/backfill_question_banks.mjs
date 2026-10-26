// One-off: creates a QuestionBank metadata doc for every distinct `subject` already present in
// the QuizQuestion pool that doesn't have one yet (e.g. questions imported by the old
// import_quiz_questions.mjs before Question Banks existed). Banks are created as DRAFTS —
// publish them from the admin portal.
//
//   node scripts/backfill_question_banks.mjs

import 'dotenv/config';
import mongoose from 'mongoose';
import QuestionBank from '../models/QuestionBank.js';
import QuizQuestion from '../models/QuizQuestion.js';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const subjects = await QuizQuestion.distinct('subject');
  let created = 0;
  let order = await QuestionBank.countDocuments({});

  for (const subject of subjects) {
    if (!subject) continue;
    if (await QuestionBank.exists({ subject })) {
      console.log(`  skip  ${subject} (bank already exists)`);
      continue;
    }
    const count = await QuizQuestion.countDocuments({ subject });
    await QuestionBank.create({
      subject,
      title: `${subject} — Question Bank`,
      order: order++
    });
    created += 1;
    console.log(`  ✓ created bank for "${subject}" (${count} questions) — draft`);
  }

  console.log(`\nDone. ${created} bank(s) created. Publish them from the Question Banks admin portal.`);
}

main()
  .catch((err) => { console.error('Backfill failed:', err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
