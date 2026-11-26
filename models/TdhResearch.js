import mongoose from 'mongoose';

// PYQ & TDH Research — a subject's PYQ compilation (Questions file) read together with its
// "Explanations & TDH Research" file (Solutions file). One upload = one TdhSet; every numbered
// question ("1.1", "6.14"…) is a TdhQuestion holding the PYQ, its explanation, the TDH Research
// notes and the practice MCQs written from those notes. See utils/tdhDocx.js + utils/tdhPractice.js.

const sectionSchema = new mongoose.Schema({
  number: { type: Number, required: true },
  title: { type: String, required: true },
}, { _id: false });

const tdhSetSchema = new mongoose.Schema({
  subject: { type: String, required: true, trim: true },   // "Economy"
  title: { type: String, required: true, trim: true },     // "Economy PYQs 1995-2026"
  sections: { type: [sectionSchema], default: [] },
  questionsFile: { type: String, default: '' },
  solutionsFile: { type: String, default: '' },
  order: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: false },
}, { timestamps: true });

// A heading with its points. Points keep the Word file's bold key terms as **…**.
const blockSchema = new mongoose.Schema({
  heading: { type: String, default: '' },
  points: { type: [String], default: [] },
}, { _id: false });

const optionSchema = new mongoose.Schema({
  key: { type: String, required: true },   // a | b | c | d
  text: { type: String, default: '' },
}, { _id: false });

// A practice MCQ written from the TDH Research. Students only see approved ones.
const practiceSchema = new mongoose.Schema({
  type: { type: String, enum: ['Factual', 'Conceptual'], default: 'Factual' },
  questionText: { type: String, required: true },
  statements: { type: [String], default: [] },
  options: { type: [optionSchema], default: [] },
  answer: { type: String, default: '' },
  why: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'approved'], default: 'draft' },
  by: { type: String, enum: ['ai', 'admin'], default: 'ai' },
}, { timestamps: true });

const tdhQuestionSchema = new mongoose.Schema({
  set: { type: mongoose.Schema.Types.ObjectId, ref: 'TdhSet', required: true },
  subject: { type: String, required: true },
  ref: { type: String, required: true },             // "1.1" — the number both files share
  section: { type: Number, required: true },
  n: { type: Number, required: true },               // position inside the section
  year: { type: String, default: '' },
  examSource: { type: String, default: '' },         // "UPSC CSE 2024"
  type: { type: String, enum: ['Factual', 'Conceptual', ''], default: '' },
  questionText: { type: String, default: '' },
  lines: { type: [String], default: [] },            // statements / pairs / the closing "Which of the above…" line
  options: { type: [optionSchema], default: [] },
  answer: { type: String, default: '' },             // '' until the file or the admin gives one
  hidden: { type: Boolean, default: false },

  title: { type: String, default: '' },              // from the Solutions file
  explanation: { type: [blockSchema], default: [] },
  research: { type: [blockSchema], default: [] },
  note: { type: [String], default: [] },             // "Additional note"

  practice: { type: [practiceSchema], default: [] },
  practiceAt: { type: Date, default: null },         // last AI run for this question
}, { timestamps: true });

tdhQuestionSchema.index({ set: 1, ref: 1 }, { unique: true });
tdhQuestionSchema.index({ set: 1, section: 1, n: 1 });

// One row per student per PYQ: their pick ('' = they just revealed the answer).
const tdhAttemptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  set: { type: mongoose.Schema.Types.ObjectId, ref: 'TdhSet', required: true },
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'TdhQuestion', required: true },
  section: { type: Number, required: true },
  picked: { type: String, default: '' },
  correct: { type: Boolean, default: false },
}, { timestamps: true });

tdhAttemptSchema.index({ user: 1, question: 1 }, { unique: true });
tdhAttemptSchema.index({ user: 1, set: 1 });

export const TdhSet = mongoose.model('TdhSet', tdhSetSchema);
export const TdhQuestion = mongoose.model('TdhQuestion', tdhQuestionSchema);
export const TdhAttempt = mongoose.model('TdhAttempt', tdhAttemptSchema);
