import mongoose from 'mongoose';

// "How to answer the 100 most-asked questions": one guide, prepared by AI from the question bank when an
// admin asks for it (lib/interview/guide.js), published by an admin. Each entry is a question boards keep
// asking, how often, and pointers in English and Hindi ({ tests, structure[], dos[], donts[] }) - pointers,
// not scripted answers.
const entrySchema = new mongoose.Schema({
  key: { type: String, required: true },
  text: { type: String, required: true },
  textHi: { type: String, default: '' },
  qtype: { type: String, default: '' },
  timesAsked: { type: Number, default: 0 },
  years: { type: [Number], default: [] },
  familyIds: { type: [String], default: [] },
  hidden: { type: Boolean, default: false },
  en: { type: mongoose.Schema.Types.Mixed, default: null },
  hi: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false, minimize: false });

const interviewGuideSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  // The working copy: what admins review and edit. 'ready' once prepared.
  status: { type: String, enum: ['empty', 'generating', 'failed', 'ready'], default: 'empty' },
  progress: { done: { type: Number, default: 0 }, total: { type: Number, default: 0 }, step: { type: String, default: '' } },
  error: { type: String, default: '' },
  entries: { type: [entrySchema], default: [] },
  corpus: { interviews: Number, years: [Number] },
  generatedAt: { type: Date, default: null },
  // What students see: a copy of the working entries made when an admin publishes, so preparing a new
  // version never takes the published one down.
  published: {
    at: { type: Date, default: null },
    corpus: { interviews: Number, years: [Number] },
    entries: { type: [entrySchema], default: [] }
  }
}, { timestamps: true, minimize: false });

export default mongoose.model('InterviewGuide', interviewGuideSchema);
