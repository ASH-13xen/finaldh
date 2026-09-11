import mongoose from 'mongoose';
import answerDiagramSchema from './answerDiagramSchema.js';

// AI-written model answer for one PYQ, in the house structure (opening line ->
// 3-6 headed sections of claim+example bullets -> closing line -> optional quote
// -> optional diagram + admin-uploaded images). Generated on demand by an admin
// (utils/pyqAnswer.js), then editable, then published. Students only ever see a
// published one. The source text is the question alone — never a copied answer.
const pyqAnswerPointSchema = new mongoose.Schema({
  claim: { type: String, default: '' },
  example: { type: String, default: '' },
}, { _id: false });

const pyqAnswerSectionSchema = new mongoose.Schema({
  heading: { type: String, default: '' },
  points: { type: [pyqAnswerPointSchema], default: [] },
}, { _id: false });

const pyqAnswerImageSchema = new mongoose.Schema({
  key: { type: String, default: '' },       // r2://... object key
  caption: { type: String, default: '' },
}); // keeps its _id — used to address the image in the URL

const pyqAnswerSchema = new mongoose.Schema({
  // 'ai' = written from the question alone by generatePyqAnswer(); 'pdf' = lifted
  // verbatim from a source book that already prints a model answer (rawText),
  // via a one-off import script — never AI-synthesized, so never regenerated
  // without an explicit override.
  source: { type: String, enum: ['ai', 'pdf'], default: 'ai' },
  rawText: { type: String, default: '' },          // (pdf) verbatim answer text, paragraphs kept
  pendingDiagramPages: { type: [Number], default: [] }, // (pdf) source pages with an embedded diagram/image not yet re-uploaded
  openingLine: { type: String, default: '' },
  sections: { type: [pyqAnswerSectionSchema], default: [] },
  closingLine: { type: String, default: '' },
  quote: { type: String, default: '' },
  images: { type: [pyqAnswerImageSchema], default: [] },
  diagram: { type: answerDiagramSchema, default: () => ({}) },
  aiModel: { type: String, default: '' },
  generatedAt: { type: Date, default: null },
  editedAt: { type: Date, default: null },
  published: { type: Boolean, default: false },
}, { _id: false });

// One previous-year question for the Toppers-Copy section, extracted from a PYQ
// compilation PDF (Gemini or Claude — see utils/aiProvider.js) and reviewed by an
// admin before commit. Kept in its own collection (not embedded in ToppersCopy)
// because a PYQ compilation spans every subject/topic and doesn't map 1:1 to the
// per-topic compendium PDFs. The frontend queries these by subject (+ optional
// section) and groups by microtheme.
const toppersPyqSchema = new mongoose.Schema({
  subject: { type: String, required: true, trim: true },       // 'GS-1'..'GS-4' | 'OptionalSubjectXxx'
  section: { type: String, default: '', trim: true },          // broad syllabus area, e.g. 'Society'
  topic: { type: String, default: '', trim: true },            // topic heading the question sits under, e.g. 'Effects of Globalisation on Indian Society' — carried forward from the last heading seen while extracting
  microtheme: { type: String, default: '', trim: true },       // finer tag from the source, e.g. 'Globalisation'
  questionText: { type: String, required: true, trim: true },
  year: { type: Number, required: true },
  marks: { type: Number, default: null },
  sourceLabel: { type: String, default: '' },                  // which compilation it came from
  // Short stable hash of subject+year+normalized(questionText). Used for a unique
  // index instead of indexing questionText directly (which can exceed Mongo's
  // 1024-byte index-key limit). Set by the controller on insert.
  dedupeKey: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  pyqAnswer: { type: pyqAnswerSchema, default: () => ({}) },
}, { timestamps: true });

toppersPyqSchema.index({ subject: 1, section: 1, year: -1 });
toppersPyqSchema.index({ subject: 1, topic: 1, year: -1 });
toppersPyqSchema.index({ dedupeKey: 1 }, { unique: true });

export default mongoose.model('ToppersPyq', toppersPyqSchema);
