import mongoose from 'mongoose';

export const REPORT_REASONS = ['wrong-answer', 'wrong-question', 'typo', 'wrong-explanation', 'other'];

// A student's report that a question is wrong. For "wrong-answer" the student can say which option they
// believe is correct and why; the admin console shows these grouped per question and can apply the
// suggestion with one click.
const mcqReportSchema = new mongoose.Schema({
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'McqQuestion', required: true },
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest' },
  subject: { type: String, default: '' },
  attempt: { type: mongoose.Schema.Types.ObjectId, ref: 'McqAttempt' },
  reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  reason: { type: String, enum: REPORT_REASONS, required: true },
  suggestedOption: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
  suggestedExplanation: { type: String, default: '', maxlength: 2000 },
  comment: { type: String, default: '', maxlength: 1000 },

  // What the question looked like when it was reported, so the admin still sees the original
  // context after the question is edited.
  snapshot: {
    questionText: String,
    options: [{ _id: false, label: String, text: String }],
    correctOption: String,
    explanation: String
  },

  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolvedAt: { type: Date },
  adminNote: { type: String, default: '', maxlength: 500 },
  // Set when this report was closed automatically because another report with the same suggestion was accepted.
  autoResolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'McqReport' },
  appliedChange: {
    previousOption: String,
    newOption: String,
    explanationChanged: Boolean,
    rescoredAttempts: Number
  }
}, { timestamps: true });

mcqReportSchema.index({ status: 1, createdAt: -1 });
mcqReportSchema.index({ question: 1, status: 1 });
// One open report per student per question (they can edit it instead of piling up duplicates).
mcqReportSchema.index({ reporter: 1, question: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });

export default mongoose.model('McqReport', mcqReportSchema);
