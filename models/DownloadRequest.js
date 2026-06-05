import mongoose from 'mongoose';

const downloadRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  courseId: { type: String, required: true },
  courseName: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model('DownloadRequest', downloadRequestSchema);
