import mongoose from 'mongoose';

const optionSchema = new mongoose.Schema({
  key: { type: String, required: true, enum: ['A', 'B', 'C', 'D'] },
  text: { type: String, required: true }
}, { _id: false });

// For "Match List I with List II" questions: the two lists, so the client can render them
// as side-by-side columns instead of one flat text blob. Null for normal questions.
const matchColumnSchema = new mongoose.Schema({
  header: { type: String, default: '' },
  items: { type: [{ _id: false, key: String, text: String }], default: [] }
}, { _id: false });

const matchListsSchema = new mongoose.Schema({
  left: { type: matchColumnSchema, default: null },   // List I  (items keyed A, B, C, D…)
  right: { type: matchColumnSchema, default: null }   // List II (items keyed 1, 2, 3, 4…)
}, { _id: false });

// One question in a subject's practice pool (e.g. every Geography question lives in one flat
// pool, tagged by topic). No fixed "sets" — the student picks a mode (a topic, a random test,
// or the whole pool) and an attempt snapshots which questions it covers.
//
// `correctKey` / `whyCorrect` / `hint` are secret: quizController never sends them with the
// question list — they come back only from POST /answer and /hint (same rule as
// McqQuestion.correctOption / .explanation).
const quizQuestionSchema = new mongoose.Schema({
  subject: { type: String, required: true },        // e.g. "Geography"
  topic: { type: String, required: true, default: 'Miscellaneous' },
  seq: { type: Number, required: true },            // stable global order within the subject (import index)

  questionText: { type: String, required: true },
  matchLists: { type: matchListsSchema, default: null },
  options: { type: [optionSchema], required: true },
  correctKey: { type: String, required: true, enum: ['A', 'B', 'C', 'D'] },

  // Filled by scripts/generate_quiz_ai.mjs via utils/quizAI.js. Questions are usable before
  // this runs — the UI just shows "Explanation coming soon".
  whyCorrect: { type: String, default: '' },
  hint: { type: String, default: '' },
  aiStatus: { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },

  examSource: { type: String, default: '' }         // e.g. "CDS (I) 2015"
}, { timestamps: true });

quizQuestionSchema.index({ subject: 1, topic: 1, seq: 1 });
quizQuestionSchema.index({ subject: 1, seq: 1 });
quizQuestionSchema.index({ aiStatus: 1 });

export default mongoose.model('QuizQuestion', quizQuestionSchema);
