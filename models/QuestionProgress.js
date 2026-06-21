import mongoose from 'mongoose';

const questionProgressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'ProgressQuestion', required: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

questionProgressSchema.index({ user: 1, question: 1 }, { unique: true });
questionProgressSchema.index({ user: 1, course: 1, fileIndex: 1, completed: 1 });

export default mongoose.model('QuestionProgress', questionProgressSchema);
