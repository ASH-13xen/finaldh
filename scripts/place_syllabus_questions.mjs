// Place a subject's Question Bank PYQs, or one test's questions, under its syllabus using AI.
// Uses AI credits: try a few with --limit --dry-run first.
//
//   node scripts/place_syllabus_questions.mjs --bank Economy --limit 3 --dry-run   print, don't save
//   node scripts/place_syllabus_questions.mjs --bank Economy                       every unplaced PYQ
//   node scripts/place_syllabus_questions.mjs --test <testId>                      every unplaced question
//   add --retag to redo AI placements (an admin's placements are always kept)

import 'dotenv/config';
import mongoose from 'mongoose';
import McqQuestion from '../models/McqQuestion.js';
import QuizQuestion from '../models/QuizQuestion.js';
import { placeBatch, placementSet, subjectOf, syllabusFor, targetFilter } from '../utils/syllabusTagging.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (name) => process.argv.includes(`--${name}`);

const kind = arg('bank') ? 'bank' : 'test';
const ref = arg('bank') || arg('test');
if (!ref) { console.error('usage: --bank <subject> | --test <testId> [--limit n] [--dry-run] [--retag]'); process.exit(1); }

await mongoose.connect(process.env.MONGODB_URI);
const Model = kind === 'bank' ? QuizQuestion : McqQuestion;
const subject = await subjectOf(kind, ref);
const syllabus = subject && await syllabusFor(subject);
if (!syllabus) { console.error(`No syllabus uploaded for ${subject || ref}`); process.exit(1); }

let query = Model.find(targetFilter(kind, ref, { retag: has('retag') })).sort(kind === 'bank' ? { seq: 1 } : { order: 1 });
if (arg('limit')) query = query.limit(Number(arg('limit')));
const questions = await query.lean();
console.log(`${questions.length} question(s) to place under ${syllabus.chapters.length} chapters of ${subject}`);

const byKey = new Map(syllabus.chapters.map((c) => [c.key, c]));
let placed = 0;
for (let i = 0; i < questions.length; i += 15) {
  const chunk = questions.slice(i, i + 15);
  const results = await placeBatch(chunk, syllabus);
  for (const [n, r] of results.entries()) {
    const chapter = byKey.get(r.chapter) || null;
    if (chapter) placed += 1;
    if (has('dry-run')) {
      console.log(`\n${chunk[n].questionText.slice(0, 110)}\n  → ${chapter ? `${chapter.number}. ${chapter.title}` : 'not placed'} / ${r.subtopic || '-'} (${r.confidence})`);
    } else {
      await Model.updateOne(
        { _id: r._id, 'syllabusTag.by': { $ne: 'admin' } },
        { $set: placementSet(kind, chunk[n], chapter, { subtopic: r.subtopic, by: 'ai', confidence: r.confidence }) },
      );
    }
  }
  console.log(`${Math.min(i + 15, questions.length)}/${questions.length}`);
}
console.log(`${placed} placed${has('dry-run') ? ' (dry run, nothing saved)' : ''}`);
await mongoose.disconnect();
