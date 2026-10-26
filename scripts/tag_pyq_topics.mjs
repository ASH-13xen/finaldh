// Places Toppers Copy PYQs under the right Toppers Copy topic with the active AI
// provider (utils/pyqTopicTagger.js) — the same thing that now happens automatically
// when PYQs are imported or edited. Use it once for the PYQs that existed before
// the tagger, or to re-place a subject after big topic changes.
//
// ~25 PYQs per AI call, text only, so a few hundred PYQs cost well under a cent.
// A PYQ an admin placed by hand in Manage PYQs is never touched.
//
// Usage:
//   node scripts/tag_pyq_topics.mjs                     # every PYQ not tagged yet
//   node scripts/tag_pyq_topics.mjs --subject GS-1
//   node scripts/tag_pyq_topics.mjs --limit 3 --dry-run # test: show the AI's picks, save nothing
//   node scripts/tag_pyq_topics.mjs --id <pyqId>
//   node scripts/tag_pyq_topics.mjs --all               # also re-place ones the AI already tagged

import 'dotenv/config';
import mongoose from 'mongoose';
import ToppersPyq from '../models/ToppersPyq.js';
import { tagPyqs } from '../utils/pyqTopicTagger.js';
import { assertAiConfigured, getActiveModelLabel } from '../utils/aiProvider.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const SUBJECT = getArg('--subject', null);
const ID = getArg('--id', null);
const LIMIT = Number(getArg('--limit', 0)) || 0;
const ALL = args.includes('--all');
const DRY_RUN = args.includes('--dry-run');

async function main() {
  assertAiConfigured();
  console.log(`AI provider: ${getActiveModelLabel()}${DRY_RUN ? '   (dry run — nothing saved)' : ''}`);
  await mongoose.connect(process.env.MONGODB_URI);

  const filter = { tcTopicSource: ALL ? { $ne: 'manual' } : { $in: ['', null] } };
  if (SUBJECT) filter.subject = SUBJECT;
  if (ID) filter._id = ID;
  let q = ToppersPyq.find(filter).select('_id').sort({ subject: 1, year: -1, _id: 1 });
  if (LIMIT) q = q.limit(LIMIT);
  const ids = (await q.lean()).map((r) => String(r._id));
  console.log(`${ids.length} PYQ(s) to place.`);

  const r = await tagPyqs(ids, { save: !DRY_RUN, log: (m) => console.log(`  ${m}`) });
  for (const p of r.proposals) {
    console.log(`\n• ${p.questionText.slice(0, 110)}${p.questionText.length > 110 ? '…' : ''}\n  → ${p.topic || '(no topic)'}  — ${p.reason}`);
  }
  console.log(`\nDone: ${r.tagged} placed under a topic, ${r.none} in no topic, ${r.failed} failed${DRY_RUN ? ' (dry run, nothing saved)' : ''}.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
