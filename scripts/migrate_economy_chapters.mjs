// Move the Economy Master File from its old 12 themes onto the 15 syllabus chapters
// (utils/economyThemes.js). No AI. Topic ids, facts, research, notes and student progress stay; only
// the chapter a topic sits under changes. A chapter is published if any topic in it came from a
// published theme. Safe to run again, but it re-places topics an admin moved by hand.
//
//   node scripts/migrate_economy_chapters.mjs --dry-run       print the result, change nothing
//   node scripts/migrate_economy_chapters.mjs                 apply (writes a backup to scratch/)

import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import EconomyTopic from '../models/EconomyTopic.js';
import EconomyTheme from '../models/EconomyTheme.js';
import EconomyProgress from '../models/EconomyProgress.js';
import { ECONOMY_THEMES, chapterForTopic } from '../utils/economyThemes.js';

const dryRun = process.argv.includes('--dry-run');
await mongoose.connect(process.env.MONGODB_URI);

const topics = await EconomyTopic.find({}).select('themeKey title sourceTheme source hidden').lean();
const oldThemes = await EconomyTheme.find({}).lean();
const publishedBefore = new Set(oldThemes.filter((t) => t.isPublished).map((t) => t.key));
const moves = topics.map((t) => ({ t, to: chapterForTopic(t) || t.themeKey }));
const valid = new Set(ECONOMY_THEMES.map((t) => t.key));
const stuck = moves.filter((m) => !valid.has(m.to));

for (const ch of ECONOMY_THEMES) {
  const inCh = moves.filter((m) => m.to === ch.key);
  console.log(`${String(ch.order).padStart(2)}. ${ch.title}: ${inCh.length}`);
}
console.log(`${moves.filter((m) => m.t.themeKey !== m.to).length} of ${topics.length} topics change theme; ${stuck.length} could not be placed`);
stuck.forEach((m) => console.log(`  unplaced: ${m.t.title} [${m.t.sourceTheme}]`));

if (dryRun || stuck.length) {
  if (stuck.length) console.log('Nothing changed: fix the rules in utils/economyThemes.js first.');
  await mongoose.disconnect();
  process.exit(stuck.length ? 1 : 0);
}

fs.mkdirSync('scratch', { recursive: true });
const backup = `scratch/economy_themes_backup_${Date.now()}.json`;
fs.writeFileSync(backup, JSON.stringify({ themes: oldThemes, topics: topics.map((t) => ({ _id: t._id, themeKey: t.themeKey })) }));
console.log(`backup: ${backup}`);

const ops = moves.map((m) => ({ updateOne: { filter: { _id: m.t._id }, update: { $set: { themeKey: m.to } } } }));
for (let i = 0; i < ops.length; i += 500) await EconomyTopic.bulkWrite(ops.slice(i, i + 500), { ordered: false });

const progress = await EconomyProgress.find({}).select('topic').lean();
const toOf = new Map(moves.map((m) => [String(m.t._id), m.to]));
const progressOps = progress.filter((p) => toOf.has(String(p.topic)))
  .map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: { themeKey: toOf.get(String(p.topic)) } } } }));
if (progressOps.length) await EconomyProgress.bulkWrite(progressOps, { ordered: false });

// New theme list. Each chapter links its PYQs: a placed Economy PYQ's topic is its chapter's title.
for (const ch of ECONOMY_THEMES) {
  const published = moves.some((m) => m.to === ch.key && publishedBefore.has(m.t.themeKey));
  await EconomyTheme.updateOne(
    { key: ch.key },
    { $set: { title: ch.title, order: ch.order, isPublished: published, pyq: { subject: 'Economy', topics: [ch.title] } } },
    { upsert: true },
  );
}
await EconomyTheme.deleteMany({ key: { $nin: [...valid] } });
console.log(`Done: ${ECONOMY_THEMES.length} chapters, ${progressOps.length} progress rows updated.`);
await mongoose.disconnect();
