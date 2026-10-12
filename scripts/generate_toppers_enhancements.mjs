// Drafts the margin "enhancement layer" (green done-well + blue make-it-stronger notes) for
// topper answer copies in bulk — the same output as the admin "✨ Enhance" button,
// one answer per AI call. Drafts are NOT shown to students until an admin
// reviews and publishes them (or pass --publish to skip that for clean ones).
//
// Usage:
//   node scripts/generate_toppers_enhancements.mjs                  # every answer without a layer
//   node scripts/generate_toppers_enhancements.mjs --subject GS-4
//   node scripts/generate_toppers_enhancements.mjs --topic "Emotional Intelligence"
//   node scripts/generate_toppers_enhancements.mjs --id <toppersCopyId>
//   node scripts/generate_toppers_enhancements.mjs --limit 1        # test run
//   node scripts/generate_toppers_enhancements.mjs --regenerate     # also redo existing layers (back to draft)
//   node scripts/generate_toppers_enhancements.mjs --publish        # publish layers with no tone issues
//   node scripts/generate_toppers_enhancements.mjs --dry-run
//
// Resumable: an answer that already has a layer is skipped unless --regenerate.
// Stops on a quota / rate-limit error so a re-run picks up where it left off.

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersEnhancement from '../models/ToppersEnhancement.js';
import { generateAnswerEnhancement, loadTopicPdf, findToneIssues } from '../utils/toppersEnhancement.js';
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
  if (TOPIC) filter.topic = TOPIC;
  const docs = await ToppersCopy.find(filter).sort({ subject: 1, syllabusSection: 1, topic: 1 });

  const work = [];
  for (const doc of docs) {
    if (!doc.pdfKey?.startsWith('r2://')) continue;
    const existing = new Set(
      (await ToppersEnhancement.find({ toppersCopy: doc._id }, { startPage: 1, endPage: 1 }).lean())
        .map((e) => `${e.startPage}-${e.endPage}`)
    );
    for (const q of doc.questions) {
      q.answers.forEach((a) => {
        if (!REGENERATE && existing.has(`${a.startPage}-${a.endPage}`)) return;
        work.push({ doc, q, a });
      });
    }
  }

  console.log(`${work.length} answer(s) to enhance across ${docs.length} topic(s).`);
  if (DRY_RUN || work.length === 0) {
    for (const { doc, a } of work) console.log(`  [${doc.subject}] ${doc.topic} — ${a.name} p${a.startPage}-${a.endPage}`);
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let failed = 0;
  let pdfFor = null;
  let srcDoc = null;

  for (const { doc, q, a } of work) {
    if (LIMIT && done + failed >= LIMIT) break;
    const label = `[${doc.subject}] ${doc.topic} — ${a.name} p${a.startPage}-${a.endPage}`;
    try {
      if (pdfFor !== doc) { srcDoc = await loadTopicPdf(doc); pdfFor = doc; }
      const gen = await generateAnswerEnhancement(doc, q, a, { srcDoc });
      const issues = findToneIssues(gen);
      await ToppersEnhancement.findOneAndUpdate(
        { toppersCopy: doc._id, startPage: a.startPage, endPage: a.endPage },
        {
          $set: {
            questionId: q._id, topperName: a.name, notes: gen.notes, takeaways: gen.takeaways,
            aiModel: gen.aiModel, generatedAt: gen.generatedAt, editedAt: null,
            published: PUBLISH && issues.length === 0,
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
      done += 1;
      const tone = issues.length ? `  ⚠ ${issues.length} tone issue(s) — left as draft` : '';
      console.log(`  ✓ ${label}  ${gen.notes.length} notes${tone}  (${done} done, ${failed} failed)`);
    } catch (err) {
      failed += 1;
      console.warn(`  ✗ ${label}: ${err.message || err}`);
      if (isQuotaError(err)) {
        console.error('\nQuota / rate-limit hit — stopping. Re-run later to resume.');
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDrafted ${done}, failed ${failed}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
