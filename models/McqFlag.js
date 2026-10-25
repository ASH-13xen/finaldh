import mongoose from 'mongoose';

// A student's personal bookmark on a question ("show me this again"). Deliberately separate from an
// attempt's "marked for review", which only lives for one attempt: flags persist across attempts and
// power the Flagged Questions page and "practice my flagged questions".
const mcqFlagSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'McqQuestion', required: true },
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest' },
  subject: { type: String, default: '' }, // denormalized for the per-subject Flagged list
  note: { type: String, default: '', maxlength: 300 }
}, { timestamps: true });

mcqFlagSchema.index({ user: 1, question: 1 }, { unique: true });
mcqFlagSchema.index({ user: 1, subject: 1, createdAt: -1 });

export default mongoose.model('McqFlag', mcqFlagSchema);
