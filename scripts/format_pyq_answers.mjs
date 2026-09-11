// Bulk-runs the reformat-only pass (utils/pyqAnswerFormat.js) over every
// pdf-sourced ToppersPyq answer that doesn't have sections yet. One-time
// backfill for answers imported before the auto-format-on-commit step existed;
// going forward, commitPyqJob's `formatPending` list handles this automatically
// via the admin UI. Same resumable/quota-abort shape as generate_pyq_answers.mjs.
//
// Usage:
//   node scripts/format_pyq_answers.mjs                # every pdf-sourced answer with no sections
//   node scripts/format_pyq_answers.mjs --subject GS-1
//   node scripts/format_pyq_answers.mjs --id <pyqId>
//   node scripts/format_pyq_answers.mjs --limit 1       # test run
//   node scripts/format_pyq_answers.mjs --force         # also re-run ones that already have sections
//   node scripts/format_pyq_answers.mjs --dry-run

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';
import { formatPyqAnswerText } from '../utils/pyqAnswerFormat.js';
import { assertAiConfigured, getActiveModelLabel, isQuotaError } from '../utils/aiProvider.js';

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
const SUBJECT = getArg('--subject', null);
const ID = getArg('--id', null);
const LIMIT = Number(getArg('--limit', 0)) || 0;
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const DELAY_MS = Number(process.env.AI_INTER_CHUNK_DELAY_MS) || 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!DRY_RUN) {
    assertAiConfigured();
    console.log(`AI provider: ${getActiveModelLabel()}   delay between calls: ${DELAY_MS}ms`);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const filter = { 'pyqAnswer.source': 'pdf', 'pyqAnswer.rawText': { $ne: '' } };
  if (ID) filter._id = ID;
  if (SUBJECT) filter.subject = SUBJECT;
  if (!FORCE) filter['pyqAnswer.sections'] = { $size: 0 };

  // .lean() + a per-row atomic updateOne (not load-then-.save()) — this runs for
  // many minutes across ~150+ rows while the admin panel is in active use
  // elsewhere, and Mongoose's optimistic-locking .save() throws a VersionError
  // the instant anything else touches the same doc in between. An atomic $set
  // has no version to conflict on.
  let rows = await ToppersPyq.find(filter).select('_id questionText pyqAnswer.rawText').sort({ subject: 1, year: -1 }).lean();
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`${rows.length} answer(s) to format.`);
  if (DRY_RUN) { await mongoose.disconnect(); return; }

  let done = 0, failed = 0;
  for (const doc of rows) {
    try {
      const formatted = await formatPyqAnswerText(doc.pyqAnswer.rawText);
      await ToppersPyq.updateOne({ _id: doc._id }, {
        $set: {
          'pyqAnswer.openingLine': formatted.openingLine,
          'pyqAnswer.sections': formatted.sections,
          'pyqAnswer.closingLine': formatted.closingLine,
          'pyqAnswer.quote': formatted.quote,
        },
      });
      done += 1;
      console.log(`[${done}/${rows.length}] formatted: ${doc.questionText.slice(0, 70)}`);
    } catch (err) {
      failed += 1;
      console.error(`  failed (${doc._id}): ${err.message || err}`);
      if (isQuotaError(err)) {
        console.error('Quota/rate-limit hit — stopping. Re-run later to resume (already-formatted rows are skipped unless --force).');
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(`Done. Formatted ${done}, failed ${failed}.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
