#!/usr/bin/env node
// Move Economy PYQ → topic placements between databases (e.g. reviewed on test_db, then the main
// DB), so the AI is paid for once and admin fixes survive.
//
//   node scripts/economy_pyq_placements.mjs --export data/economy_pyq_placements.json
//   node scripts/economy_pyq_placements.mjs --apply  data/economy_pyq_placements.json [--dry-run]
//
// Keys are stable, not Mongo ids: QuizQuestion.sourceRef ("econ-pyq:6.12") → EconomyTopic.importKey.
// So the target DB needs the Economy bank imported (scripts/import_bank_questions.mjs) and the
// Master File imported (scripts/import_economy_master.mjs) first. Re-running --apply is safe; it
// sets each listed question's placement to exactly what the file says.

import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import QuizQuestion from '../models/QuizQuestion.js';
import EconomyTopic from '../models/EconomyTopic.js';
import { ECONOMY_PYQ_SUBJECT } from '../utils/economyPyqTagging.js';

dotenv.config();
const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const exportFile = val('export');
const applyFile = val('apply');
const dryRun = argv.includes('--dry-run');
if (!exportFile === !applyFile) {
  console.error('usage: economy_pyq_placements.mjs --export <file> | --apply <file> [--dry-run]');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
console.log(`db: ${mongoose.connection.db.databaseName}`);
try {
  if (exportFile) {
    const qs = await QuizQuestion.find({ subject: ECONOMY_PYQ_SUBJECT, 'econTag.by': { $ne: null } })
      .sort({ seq: 1 }).select('sourceRef econTopics econTag').lean();
    const topics = await EconomyTopic.find({ _id: { $in: qs.flatMap((q) => q.econTopics) } }).select('importKey').lean();
    const keyOf = Object.fromEntries(topics.map((t) => [String(t._id), t.importKey]));
    const rows = qs.filter((q) => q.sourceRef).map((q) => ({
      ref: q.sourceRef,
      topics: q.econTopics.map((id) => keyOf[String(id)]).filter(Boolean),
      by: q.econTag.by,
      confidence: q.econTag.confidence,
    }));
    fs.writeFileSync(exportFile, JSON.stringify(rows, null, 1));
    const missingRef = qs.length - rows.length;
    console.log(`exported ${rows.length} placement(s) → ${exportFile}${missingRef ? ` (${missingRef} without sourceRef skipped)` : ''}`);
  } else {
    const rows = JSON.parse(fs.readFileSync(applyFile, 'utf8'));
    const topics = await EconomyTopic.find({ importKey: { $in: rows.flatMap((r) => r.topics) } }).select('_id importKey').lean();
    const idOf = Object.fromEntries(topics.map((t) => [t.importKey, t._id]));
    const qs = await QuizQuestion.find({ subject: ECONOMY_PYQ_SUBJECT, sourceRef: { $in: rows.map((r) => r.ref) } }).select('_id sourceRef').lean();
    const qOf = Object.fromEntries(qs.map((q) => [q.sourceRef, q._id]));
    const missingQ = rows.filter((r) => !qOf[r.ref]).map((r) => r.ref);
    const missingT = [...new Set(rows.flatMap((r) => r.topics).filter((k) => !idOf[k]))];
    const ops = rows.filter((r) => qOf[r.ref]).map((r) => ({
      updateOne: {
        filter: { _id: qOf[r.ref] },
        update: { $set: { econTopics: r.topics.map((k) => idOf[k]).filter(Boolean), econTag: { by: r.by, confidence: r.confidence ?? null, at: new Date() } } },
      },
    }));
    console.log(`${ops.length}/${rows.length} question(s) found, ${topics.length} topic(s) matched.`);
    if (missingQ.length) console.log(`  missing questions (import the Economy bank first?): ${missingQ.slice(0, 10).join(', ')}${missingQ.length > 10 ? ` … +${missingQ.length - 10}` : ''}`);
    if (missingT.length) console.log(`  missing topics (import the Master File first?): ${missingT.length}, e.g. ${missingT.slice(0, 3).join(' ; ')}`);
    if (dryRun) console.log('(dry run — nothing written)');
    else if (ops.length) console.log(`updated ${(await QuizQuestion.bulkWrite(ops)).modifiedCount} question(s).`);
  }
} finally {
  await mongoose.disconnect();
}
