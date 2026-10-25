// Generates the house-style model answer for ToppersPyq rows in bulk, using the
// active AI provider (utils/aiProvider.js). Same output the admin "Generate
// model answer" button produces, one PYQ per call. Text-only (no PDF), so this
// is cheap. Input is the question alone — no existing answer is fed or copied.
//
// Generated answers land as DRAFTS (published:false). Students never see a draft,
// so review + Publish in the admin "Manage PYQs" tab afterwards (or pass
// --publish to auto-publish, use with care).
//
// Usage:
//   node scripts/generate_pyq_answers.mjs                      # every PYQ with no answer
//   node scripts/generate_pyq_answers.mjs --subject GS-1
//   node scripts/generate_pyq_answers.mjs --topic "Foreign Policy"
//   node scripts/generate_pyq_answers.mjs --id <pyqId>
//   node scripts/generate_pyq_answers.mjs --limit 1            # test run
//   node scripts/generate_pyq_answers.mjs --regenerate         # also redo ones that already have an answer
//   node scripts/generate_pyq_answers.mjs --publish            # mark generated answers published
//   node scripts/generate_pyq_answers.mjs --dry-run
//
// Resumable: a PYQ that already has pyqAnswer.generatedAt is skipped unless
// --regenerate. Stops on a quota / rate-limit error so a re-run resumes.

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';
import { generatePyqAnswer } from '../utils/pyqAnswer.js';
import { assertAiConfigured, getActiveModelLabel, isQuotaError } from '../utils/aiProvider.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const SUBJECT = getArg('--subject', null);
const TOPIC = getArg('--topic', null);
const ID = getArg('--id', null);
const LIMIT = Number(getArg('--limit', 0)) || 0;
const REGENERATE = args.includes('--regenerate');
const PUBLISH = args.includes('--publish');
const DRY_RUN = args.includes('--dry-run');
const DELAY_MS = Number(process.env.AI_INTER_CHUNK_DELAY_MS) || 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!DRY_RUN) {
    assertAiConfigured();
    console.log(`AI provider: ${getActiveModelLabel()}   delay between calls: ${DELAY_MS}ms`);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const filter = {};
  if (ID) filter._id = ID;
  if (SUBJECT) filter.subject = SUBJECT;
  if (TOPIC) filter.topic = { $regex: TOPIC, $options: 'i' };
  if (!REGENERATE) filter['pyqAnswer.generatedAt'] = { $in: [null, undefined] };

  const rows = await ToppersPyq.find(filter).sort({ subject: 1, year: -1 });
  console.log(`${rows.length} PYQ(s) to answer.`);
  if (DRY_RUN) {
    for (const r of rows) console.log(`  [${r.subject}] ${r.year} — ${(r.questionText || '').slice(0, 90)}`);
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let failed = 0;
  for (const r of rows) {
    if (LIMIT && done + failed >= LIMIT) break;
    try {
      const generated = await generatePyqAnswer(r);
      r.pyqAnswer = {
        ...generated,
        images: r.pyqAnswer?.images || [],
        published: PUBLISH,
        editedAt: null,
      };
      await r.save();
      done += 1;
      console.log(`  ✓ [${r.subject}] ${r.year} — ${(r.questionText || '').slice(0, 60)}  (${done} done, ${failed} failed)`);
    } catch (err) {
      failed += 1;
      console.warn(`  ✗ [${r.subject}] ${r.year}: ${err.message || err}`);
      if (isQuotaError(err)) {
        console.error('\nQuota / rate-limit hit — stopping. Re-run later to resume.');
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nGenerated ${done}, failed ${failed}.${PUBLISH ? '' : ' All drafts — review + Publish in the admin.'}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
