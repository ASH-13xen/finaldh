import mongoose from 'mongoose';

// One document == one syllabus topic that has a bundled toppers-copy compendium.
// The scanned answer copies live in a single PDF on Cloudflare R2 (pdfKey,
// "r2://<key>").
//
// The compendium is organised QUESTION-FIRST: a printed question, then the
// handwritten answers several toppers wrote for THAT question, then the next
// question. So a topic holds `questions[]`, and each question holds `answers[]`
// where every answer is a page range inside the one topic PDF. The AI analysis
// is generated per question (Gemini or Claude — see utils/aiProvider.js).
//
// PYQs (from cross-subject compilation PDFs) still live in their own `ToppersPyq`
// collection and are surfaced as related context, matched by subject/topic.

const answerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  rank: { type: Number, default: null },
  year: { type: Number, default: null },
  marks: { type: String, default: '' }, // free text: copies aren't consistent ("109", "12.5/15", "")
  source: { type: String, default: '' }, // e.g. "Next IAS", "Vision IAS" — if the header strip names it
  curatorNote: { type: String, default: '' }, // admin's one-line "why this copy" — fed to the AI + shown to students
  startPage: { type: Number, required: true }, // 1-based, within the topic PDF
  endPage: { type: Number, required: true },
}, { _id: false });

// --- annotation-style analysis sub-schemas ---
// definition | context | data | quote | anecdote (intros); summary | wayforward |
// balanced | quote (conclusions)
const excerptSchema = new mongoose.Schema({
  text: { type: String, default: '' },
  type: { type: String, default: '' },
  topper: { type: String, default: '' },
  curatorNote: { type: String, default: '' },
  wordCount: { type: Number, default: null },
}, { _id: false });

const themePointSchema = new mongoose.Schema({
  text: { type: String, default: '' },
  example: { type: String, default: '' },
  toppers: { type: [String], default: [] },
}, { _id: false });

const bodyThemeSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  gloss: { type: String, default: '' },
  points: { type: [themePointSchema], default: [] },
}, { _id: false });

const diagramSchema = new mongoose.Schema({
  topper: { type: String, default: '' },
  description: { type: String, default: '' },
  mermaid: { type: String, default: '' },
}, { _id: false });

// Breakdown of the 2-3 hand-picked answers to one question. Keeps the legacy flat
// fields readable so older analyses still render while re-running.
const aiAnalysisSchema = new mongoose.Schema({
  modelSkeleton: { type: String, default: '' },     // ~150-word ideal answer outline
  intros: { type: [excerptSchema], default: [] },
  bodyThemes: { type: [bodyThemeSchema], default: [] },
  conclusions: { type: [excerptSchema], default: [] },
  keywords: { type: [String], default: [] },
  techniques: { type: [String], default: [] },      // transferable "how to write" lessons
  diagrams: { type: [diagramSchema], default: [] },

  // legacy (pre-2026-08-28) — still rendered if present, no longer written
  modelAnswer: { type: String, default: '' },
  commonStructure: { type: String, default: '' },
  whatToppersDidWell: { type: [String], default: [] },
  valueAddition: { type: [String], default: [] },

  aiModel: { type: String, default: '' },
  generatedAt: { type: Date, default: null },
}, { _id: false });

// Keeps its _id — the per-question analyze endpoint addresses a question by it.
const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true, trim: true },
  year: { type: Number, default: null },   // exam year printed with the question, if any
  marks: { type: Number, default: null },
  order: { type: Number, default: 0 },
  answers: { type: [answerSchema], default: [] },
  aiAnalysis: { type: aiAnalysisSchema, default: () => ({}) },
});

const toppersCopySchema = new mongoose.Schema({
  subject: { type: String, required: true, trim: true }, // 'GS-1'..'GS-4' | 'OptionalSubjectXxx'
  syllabusSection: { type: String, default: '', trim: true }, // e.g. 'Indian Society'
  topic: { type: String, required: true, trim: true }, // e.g. 'Effects of Globalisation on Indian Society'
  order: { type: Number, default: 0 }, // display order within a subject

  pdfKey: { type: String, default: '' }, // 'r2://<key>' — the scanned compendium
  pdfPageCount: { type: Number, default: 0 },
  originalFileName: { type: String, default: '' },

  questions: { type: [questionSchema], default: [] },

  published: { type: Boolean, default: false }, // admin flips this once the review looks right
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

toppersCopySchema.index({ subject: 1, order: 1 });
toppersCopySchema.index({ subject: 1, syllabusSection: 1, topic: 1 }, { unique: true });

export default mongoose.model('ToppersCopy', toppersCopySchema);
