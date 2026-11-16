import mongoose from 'mongoose';

// Corpus-wide facts computed when the bank is built (lib/interview/meta.js): how often boards asked about
// each DAF area and item, the DAF keywords with counts, each board's style, and the keyword table used to
// match a student's DAF. One document per key; re-seeded with the corpus.
const interviewMetaSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, minimize: false });

export default mongoose.model('InterviewMeta', interviewMetaSchema);
