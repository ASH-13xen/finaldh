// Fills in whyCorrect + hint for QuizQuestions that don't have them yet, using the active AI
// provider (utils/aiProvider.js via utils/quizAI.js). Questions are usable without this — the
// UI just shows "Explanation coming soon" until a question is done.
//
// Usage:
//   node scripts/generate_quiz_ai.mjs                    # all pending questions
//   node scripts/generate_quiz_ai.mjs --subject Geography
//   node scripts/generate_quiz_ai.mjs --topic "Soil"     # just one topic
//   node scripts/generate_quiz_ai.mjs --limit 50         # stop after N (test runs)
//   node scripts/generate_quiz_ai.mjs --retry-failed     # also re-try aiStatus:'failed'
//
// Resumable and safe to re-run.

import 'dotenv/config';
import mongoose from 'mongoose';
import QuizQuestion from '../models/QuizQuestion.js';
import { generateWhyAndHint } from '../utils/quizAI.js';
import { assertAiConfigured, getActiveModelLabel, isQuotaError } from '../utils/aiProvider.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const SUBJECT = getArg('--subject', null);
const TOPIC = getArg('--topic', null);
const LIMIT = Number(getArg('--limit', 0)) || 0;
const RETRY_FAILED = args.includes('--retry-failed');
const DELAY_MS = Number(process.env.AI_INTER_CHUNK_DELAY_MS) || 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assertAiConfigured();
  console.log(`AI provider: ${getActiveModelLabel()}   delay between calls: ${DELAY_MS}ms`);

  await mongoose.connect(process.env.MONGODB_URI);

  const filter = { aiStatus: RETRY_FAILED ? { $in: ['pending', 'failed'] } : 'pending' };
  if (SUBJECT) filter.subject = SUBJECT;
  if (TOPIC) filter.topic = TOPIC;

  const total = await QuizQuestion.countDocuments(filter);
  console.log(`${total} question(s) need generation.`);
  if (total === 0) { await mongoose.disconnect(); return; }

  const cursor = QuizQuestion.find(filter).sort({ subject: 1, seq: 1 }).cursor();

  let done = 0;
  let failed = 0;

  for await (const q of cursor) {
    if (LIMIT && done + failed >= LIMIT) break;
    try {
      const { whyCorrect, hint } = await generateWhyAndHint({
        questionText: q.questionText,
        options: q.options,
        correctKey: q.correctKey
      });
      q.whyCorrect = whyCorrect;
      q.hint = hint;
      q.aiStatus = 'done';
      await q.save();
      done += 1;
      process.stdout.write(`  done ${done}/${total}  failed ${failed}\r`);
    } catch (err) {
      failed += 1;
      q.aiStatus = 'failed';
      await q.save().catch(() => {});
      console.warn(`\n  q ${q._id} (seq ${q.seq}) failed: ${err.message || err}`);
      if (isQuotaError(err)) {
        console.error('\nQuota/rate-limit hit — stopping. Re-run later to resume.');
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n\nGenerated ${done}, failed ${failed}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
