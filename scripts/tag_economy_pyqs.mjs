#!/usr/bin/env node
// AI-place Economy Question Bank PYQs under Economy Master File topics (utils/economyPyqTagging.js).
//
//   node scripts/tag_economy_pyqs.mjs --limit 3          # try a few first
//   node scripts/tag_economy_pyqs.mjs                    # every untagged question
//   node scripts/tag_economy_pyqs.mjs --retag            # redo AI placements (admin ones are kept)
//
// Same job as Admin → Economy Data → PYQs → "AI-place". Prints what it placed so a small run
// can be eyeballed before the full one.

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import QuizQuestion from '../models/QuizQuestion.js';
import EconomyTopic from '../models/EconomyTopic.js';
import { assertAiConfigured, getActiveModelLabel } from '../utils/aiProvider.js';
import { tagManyPyqs, tagTargetFilter } from '../utils/economyPyqTagging.js';

dotenv.config();
const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const limit = parseInt(val('limit'), 10) || 0;
const retag = argv.includes('--retag');

assertAiConfigured();
await mongoose.connect(process.env.MONGODB_URI);
try {
  let query = QuizQuestion.find(tagTargetFilter({ retag })).sort({ seq: 1 }).select('_id');
  if (limit) query = query.limit(limit);
  const ids = (await query.lean()).map((q) => q._id);
  console.log(`${ids.length} question(s) to tag with ${getActiveModelLabel()} (db: ${mongoose.connection.db.databaseName})`);
  const state = await tagManyPyqs(ids, {
    onProgress: (s) => process.stdout.write(`  ${s.done}/${s.total} done, ${s.placed} placed, ${s.failed} failed\r`),
  });
  console.log(`\n${state.placed}/${state.total} placed under a topic; ${state.failed} failed.`);
  for (const e of state.errors) console.log(`  ! ${e.error}`);

  if (ids.length <= 30) {
    const qs = await QuizQuestion.find({ _id: { $in: ids } }).sort({ seq: 1 }).lean();
    const topics = await EconomyTopic.find({ _id: { $in: qs.flatMap((q) => q.econTopics) } }).select('themeKey title source').lean();
    const byId = Object.fromEntries(topics.map((t) => [String(t._id), t]));
    for (const q of qs) {
      console.log(`\n[${q.sourceRef}] ${q.questionText.slice(0, 110)}`);
      console.log(`  confidence ${q.econTag?.confidence}`);
      for (const id of q.econTopics) { const t = byId[String(id)]; console.log(`  → ${t.themeKey} / ${t.title} (${t.source})`); }
      if (!q.econTopics.length) console.log('  → (no topic)');
    }
  }
} finally {
  await mongoose.disconnect();
}
