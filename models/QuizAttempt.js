import mongoose from 'mongoose';

// Snapshot per question — `correctKey` is copied in at answer time so history/scoring stay
// valid even if the question is later edited. `index` is the position within the attempt's
// questionIds array.
const quizResponseSchema = new mongoose.Schema({
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizQuestion', required: true },
  index: { type: Number, required: true },
  selectedKey: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
  correctKey: { type: String, enum: ['A', 'B', 'C', 'D'] },
  isCorrect: { type: Boolean, default: null },
  answeredAt: { type: Date, default: null }
}, { _id: false });

// One study session over a subject's pool. `mode` decides the question set:
//   topic  -> every question tagged `topic`, in seq order
//   random -> a random sample of `questionIds.length` questions
//   all    -> every question in the subject in seq order
// The student checks each answer as they go, in every mode.
// At most one non-completed topic/all attempt per (user, subject, mode, topic) — startAttempt
// resumes it; random attempts never resume.
const quizAttemptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: { type: String, required: true },

  mode: { type: String, enum: ['topic', 'random', 'all'], required: true },
  topic: { type: String, default: null },                 // set only when mode === 'topic'

  // The ordered question set for this attempt, snapshotted at creation.
  questionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

  status: { type: String, enum: ['in-progress', 'completed'], default: 'in-progress' },

  // Built lazily — one entry per answered question.
  responses: { type: [quizResponseSchema], default: [] },

  totalQuestions: { type: Number, default: 0 },
  totalAnswered: { type: Number, default: 0 },
  totalCorrect: { type: Number, default: 0 },
  score: { type: Number, default: 0 },                    // percent 0-100, set at completion

  startedAt: { type: Date, required: true, default: Date.now },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

quizAttemptSchema.index({ user: 1, subject: 1, mode: 1, topic: 1, status: 1 });
quizAttemptSchema.index({ user: 1, subject: 1, createdAt: -1 });

export default mongoose.model('QuizAttempt', quizAttemptSchema);
