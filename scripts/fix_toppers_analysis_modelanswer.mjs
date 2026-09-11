// One-off migration. The 2026-08-31 analysis redesign turned
// aiAnalysis.modelAnswer from a String into a nested object. Documents created
// before that still hold the old empty-string value, so Mongoose now refuses to
// load / save them:
//   "Tried to set nested object field `modelAnswer` to primitive value ``"
//
// This drops the stale field on every question of every ToppersCopy, using the
// raw driver so schema casting doesn't get in the way. The PDF, questions and
// answers are untouched — only the old AI analysis stub is cleared. Re-run the
// analysis afterwards (Manage/Publish buttons or scripts/generate_toppers_analysis.mjs).
//
//   node scripts/fix_toppers_analysis_modelanswer.mjs

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersCopy from '../models/ToppersCopy.js';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = ToppersCopy.collection; // raw driver, bypasses schema casting

  const withLegacy = await col.countDocuments({ 'questions.aiAnalysis.modelAnswer': { $type: 'string' } });
  console.log(`${withLegacy} ToppersCopy doc(s) have a legacy string aiAnalysis.modelAnswer.`);

  const res = await col.updateMany(
    {},
    { $unset: { 'questions.$[].aiAnalysis.modelAnswer': '' } }
  );
  console.log(`Matched ${res.matchedCount}, modified ${res.modifiedCount}.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
