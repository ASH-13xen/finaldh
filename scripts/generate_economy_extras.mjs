#!/usr/bin/env node
// AI-draft the Economy Master File extras ("Real-world link" facts + "Beyond the book" research)
// for every topic in a theme that has none yet.
//
//   node scripts/generate_economy_extras.mjs --theme monetary-policy [--limit 5] [--redraft] [--concurrency 3] [--dry-run]
//   node scripts/generate_economy_extras.mjs --theme all
//
// Same logic as Admin → Economy Data → Themes → "Draft extras" (utils/economyExtras.js).
// Everything is saved as a DRAFT — review and publish from the admin screen.
// --redraft also redoes existing drafts; published extras are never touched.

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import EconomyTopic from '../models/EconomyTopic.js';
import { ECONOMY_THEMES } from '../utils/economyThemes.js';
import { bulkTargetFilter, draftManyExtras } from '../utils/economyExtras.js';
import { assertAiConfigured, getActiveModelLabel } from '../utils/aiProvider.js';

dotenv.config();
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const theme = val('theme');
const keys = theme === 'all' ? ECONOMY_THEMES.map((t) => t.key) : [theme];
if (!theme || keys.some((k) => !ECONOMY_THEMES.some((t) => t.key === k))) {
  console.error(`usage: generate_economy_extras.mjs --theme <${ECONOMY_THEMES.map((t) => t.key).join('|')}|all> [--limit N] [--redraft] [--concurrency N] [--dry-run]`);
  process.exit(1);
}
const limit = Number(val('limit')) || 0;
const concurrency = Number(val('concurrency')) || 3;

assertAiConfigured();
await mongoose.connect(process.env.MONGODB_URI);
try {
  console.log(`model: ${getActiveModelLabel()}`);
  for (const key of keys) {
    let q = EconomyTopic.find(bulkTargetFilter(key, { redraft: flag('redraft') })).sort({ order: 1 }).select('_id title');
    if (limit) q = q.limit(limit);
    const topics = await q.lean();
    console.log(`\n${key}: ${topics.length} topic(s) to draft`);
    if (flag('dry-run') || !topics.length) continue;
    const started = Date.now();
    const r = await draftManyExtras(topics.map((t) => t._id), {
      concurrency,
      onProgress: (s) => process.stdout.write(`\r  ${s.done} drafted, ${s.failed} failed / ${s.total}`),
    });
    console.log(`\n  done in ${Math.round((Date.now() - started) / 1000)}s`);
    for (const e of r.errors) console.log(`  ✗ ${topics.find((t) => String(t._id) === e.id)?.title || e.id}: ${e.error}`);
  }
  if (flag('dry-run')) console.log('\n(dry run — nothing written)');
} finally {
  await mongoose.disconnect();
}
