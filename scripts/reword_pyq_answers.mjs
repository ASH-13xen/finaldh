// Bulk-runs the reword pass (utils/pyqAnswerFormat.js rewordPyqAnswerText) over
// book-sourced ToppersPyq answers, so what students read is in our own words
// while the facts stay the book's. rawText keeps the original — re-run any time.
// Same resumable/quota-abort shape as format_pyq_answers.mjs.
//
// Usage:
//   node scripts/reword_pyq_answers.mjs                # every book answer not reworded yet
//   node scripts/reword_pyq_answers.mjs --subject GS-1
//   node scripts/reword_pyq_answers.mjs --id <pyqId>
//   node scripts/reword_pyq_answers.mjs --limit 3 --preview   # print the result, save nothing
//   node scripts/reword_pyq_answers.mjs --force         # also redo ones already reworded
//   node scripts/reword_pyq_answers.mjs --dry-run       # only count
//   node scripts/reword_pyq_answers.mjs --concurrency 4 # several at once (default 1)

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';
import { rewordPyqAnswerText } from '../utils/pyqAnswerFormat.js';
import { assertAiConfigured, getActiveModelLabel, isQuotaError } from '../utils/aiProvider.js';

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
const SUBJECT = getArg('--subject', null);
const ID = getArg('--id', null);
const LIMIT = Number(getArg('--limit', 0)) || 0;
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const PREVIEW = args.includes('--preview');
const CONCURRENCY = Math.max(1, Number(getArg('--concurrency', 1)) || 1);
const DELAY_MS = Number(process.env.AI_INTER_CHUNK_DELAY_MS) || 4000;
// A result that still shares this much of its wording with the book is retried once.
const MAX_COPIED_SHARE = 0.1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n) => `${Math.round(n * 100)}%`;

async function main() {
  if (!DRY_RUN) {
    assertAiConfigured();
    console.log(`AI provider: ${getActiveModelLabel()}   delay between calls: ${DELAY_MS}ms`);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const filter = { 'pyqAnswer.source': 'pdf', 'pyqAnswer.rawText': { $ne: '' } };
  if (ID) filter._id = ID;
  if (SUBJECT) filter.subject = SUBJECT;
  if (!FORCE) filter['pyqAnswer.reworded'] = { $ne: true };

  // .lean() + atomic updateOne, for the same reason as format_pyq_answers.mjs.
  let rows = await ToppersPyq.find(filter).select('_id questionText pyqAnswer.rawText').sort({ subject: 1, year: -1 }).lean();
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`${rows.length} answer(s) to reword.`);
  if (DRY_RUN) { await mongoose.disconnect(); return; }

  let done = 0, failed = 0, stop = false;
  const flagged = [];
  const queue = [...rows];
  const worker = async () => {
    while (queue.length && !stop) {
    const doc = queue.shift();
    try {
      let out = await rewordPyqAnswerText(doc.pyqAnswer.rawText, { questionText: doc.questionText });
      if (out.report.copiedShare > MAX_COPIED_SHARE) {
        await sleep(DELAY_MS);
        const again = await rewordPyqAnswerText(doc.pyqAnswer.rawText, { questionText: doc.questionText });
        if (again.report.copiedShare < out.report.copiedShare) out = again;
      }
      const { report, ...fields } = out;
      const note = `still-copied ${pct(report.copiedShare)}, length ${pct(report.lengthRatio)}` +
        (report.missingNumbers.length ? `, figures not found: ${report.missingNumbers.join(' ')}` : '');
      if (report.copiedShare > MAX_COPIED_SHARE || report.missingNumbers.length || report.lengthRatio < 0.7) {
        flagged.push(`${doc._id}  ${note}  | ${doc.questionText.slice(0, 60)}`);
      }
      if (PREVIEW) {
        console.log(`\n===== ${doc.questionText}\n--- BOOK\n${doc.pyqAnswer.rawText}\n--- OURS\n${JSON.stringify(fields, null, 1)}\n--- ${note}`);
      } else {
        await ToppersPyq.updateOne({ _id: doc._id }, {
          $set: {
            'pyqAnswer.openingLine': fields.openingLine,
            'pyqAnswer.sections': fields.sections,
            'pyqAnswer.closingLine': fields.closingLine,
            'pyqAnswer.quote': fields.quote,
            'pyqAnswer.reworded': true,
          },
        });
      }
      done += 1;
      console.log(`[${done}/${rows.length}] ${PREVIEW ? 'previewed' : 'reworded'} (${note}): ${doc.questionText.slice(0, 60)}`);
    } catch (err) {
      failed += 1;
      console.error(`  failed (${doc._id}): ${err.message || err}`);
      if (isQuotaError(err)) {
        console.error('Quota/rate-limit hit — stopping. Re-run later to resume (reworded rows are skipped unless --force).');
        stop = true;
      }
    }
    await sleep(DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`Done. ${PREVIEW ? 'Previewed' : 'Reworded'} ${done}, failed ${failed}.`);
  if (flagged.length) console.log(`\nWorth a human look (${flagged.length}):\n${flagged.join('\n')}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
