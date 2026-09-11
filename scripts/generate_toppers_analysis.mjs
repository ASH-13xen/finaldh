// Generates the per-question AI analysis for Toppers Copy topics in bulk, using
// the active AI provider (utils/aiProvider.js). Same output the admin
// "Analyze" button produces, one question per call — just without babysitting
// the browser. Questions are usable without this; the student view just says the
// analysis hasn't been generated yet.
//
// Usage:
//   node scripts/generate_toppers_analysis.mjs                     # every question missing an analysis
//   node scripts/generate_toppers_analysis.mjs --subject GS-1      # one subject
//   node scripts/generate_toppers_analysis.mjs --topic "Globalisation"
//   node scripts/generate_toppers_analysis.mjs --id <toppersCopyId>
//   node scripts/generate_toppers_analysis.mjs --limit 1           # test run (stop after N)
//   node scripts/generate_toppers_analysis.mjs --re-analyze        # also regenerate ones that already have an analysis
//   node scripts/generate_toppers_analysis.mjs --dry-run           # list what would be processed, no AI calls
//
// Resumable and safe to re-run: a question that already has aiAnalysis.generatedAt
// is skipped unless --re-analyze. On a quota / rate-limit error it stops so a
// later re-run picks up where it left off.

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersCopy from '../models/ToppersCopy.js';
import { generateQuestionAnalysis } from '../utils/toppersAnalysis.js';
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
const RE_ANALYZE = args.includes('--re-analyze');
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
  if (docs.length === 0) {
    console.log('No matching Toppers Copy topics.');
    await mongoose.disconnect();
    return;
  }

  // Build the work list first so we can print a total and honour --limit cleanly.
  const work = [];
  for (const doc of docs) {
    if (!doc.pdfKey?.startsWith('r2://')) continue;
    for (const q of doc.questions) {
      if (!q.answers?.length) continue;
      if (!RE_ANALYZE && q.aiAnalysis?.generatedAt) continue;
      work.push({ doc, q });
    }
  }

  console.log(`${work.length} question(s) to analyze across ${docs.length} topic(s).`);
  if (DRY_RUN) {
    for (const { doc, q } of work) {
      console.log(`  [${doc.subject}] ${doc.topic} — ${(q.questionText || '(untitled)').slice(0, 80)}`);
    }
    await mongoose.disconnect();
    return;
  }
  if (work.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let failed = 0;

  // Group by doc so we save each topic once after its questions are done.
  const byDoc = new Map();
  for (const item of work) {
    if (!byDoc.has(item.doc)) byDoc.set(item.doc, []);
    byDoc.get(item.doc).push(item.q);
  }

  outer: for (const [doc, questions] of byDoc) {
    let dirty = false;
    for (const q of questions) {
      if (LIMIT && done + failed >= LIMIT) {
        if (dirty) { doc.markModified('questions'); await doc.save(); }
        break outer;
      }
      try {
        q.aiAnalysis = await generateQuestionAnalysis(doc, q);
        dirty = true;
        done += 1;
        console.log(`  ✓ [${doc.subject}] ${doc.topic} — ${(q.questionText || '(untitled)').slice(0, 60)}  (${done} done, ${failed} failed)`);
      } catch (err) {
        failed += 1;
        console.warn(`  ✗ [${doc.subject}] ${doc.topic} — ${(q.questionText || '(untitled)').slice(0, 60)}: ${err.message || err}`);
        if (isQuotaError(err)) {
          if (dirty) { doc.markModified('questions'); await doc.save(); }
          console.error('\nQuota / rate-limit hit — stopping. Re-run later to resume.');
          break outer;
        }
      }
      await sleep(DELAY_MS);
    }
    if (dirty) { doc.markModified('questions'); await doc.save(); }
  }

  console.log(`\nGenerated ${done}, failed ${failed}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
