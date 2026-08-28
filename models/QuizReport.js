import mongoose from 'mongoose';

// Backs the "Report" button on the quiz runner — a user flagging a wrong answer key,
// bad options, typo, etc. Reviewed manually (no admin UI yet).
const quizReportSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quizQuestion: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizQuestion', required: true },
  subject: { type: String, default: '' },
  reason: { type: String, default: '' },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' }
}, { timestamps: true });

quizReportSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('QuizReport', quizReportSchema);
