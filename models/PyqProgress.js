import mongoose from 'mongoose';

const pyqProgressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  pyq: { type: mongoose.Schema.Types.ObjectId, ref: 'ProgressPyq', required: true },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

pyqProgressSchema.index({ user: 1, pyq: 1 }, { unique: true });

export default mongoose.model('PyqProgress', pyqProgressSchema);
