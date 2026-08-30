import mongoose from 'mongoose';

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
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

toppersPyqSchema.index({ subject: 1, section: 1, year: -1 });
toppersPyqSchema.index({ subject: 1, topic: 1, year: -1 });
toppersPyqSchema.index({ dedupeKey: 1 }, { unique: true });

export default mongoose.model('ToppersPyq', toppersPyqSchema);
