import mongoose from 'mongoose';

// A current-topic note for the interview (e.g. "One Nation One Election"): why it is in the news, short
// notes, the questions a board may ask with model answers, and who is likely to be asked. Written by AI from
// sources an admin supplies, reviewed and published by an admin; the same for every student. English and
// Hindi are stored side by side ({ title, why, sections, questions, likelyFor, keywords }).
const interviewNoteSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  status: { type: String, enum: ['generating', 'failed', 'draft', 'published'], default: 'generating', index: true },
  topic: { type: String, default: '' },
  category: { type: String, default: '' },
  // Lowercase DAF words (subjects, professions, states, hobbies) used to show the note "for you".
  tags: { type: [String], default: [] },
  en: { type: mongoose.Schema.Types.Mixed, default: null },
  hi: { type: mongoose.Schema.Types.Mixed, default: null },
  // The pages and text the note was written from (admin-supplied; never Google Search results).
  sources: { type: [{ _id: false, title: String, url: String }], default: [] },
  input: { urls: { type: [String], default: [] }, textChars: { type: Number, default: 0 } },
  error: { type: String, default: '' },
  createdBy: { type: String, default: '' },
  publishedAt: { type: Date, default: null }
}, { timestamps: true, minimize: false });

interviewNoteSchema.index({ status: 1, publishedAt: -1 });

export default mongoose.model('InterviewNote', interviewNoteSchema);
