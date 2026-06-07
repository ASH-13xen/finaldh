import mongoose from 'mongoose';

const downloadSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  courseId: { type: String, required: true, index: true },
  step: { type: Number, default: 0 },
  status: { type: String, enum: ['idle', 'queued', 'processing', 'completed', 'failed'], default: 'idle' },
  error: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 7200 } // Auto-delete documents after 2 hours (7200 seconds)
}, { timestamps: true });

// Ensure unique index per student and course
downloadSessionSchema.index({ userId: 1, courseId: 1 }, { unique: true });

export default mongoose.model('DownloadSession', downloadSessionSchema);
