import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// A DAF a student uploaded for verification. An admin checks it is a genuine DAF (Admin -> DAF Checks); until
// then the student can't practise, use the free AI uses or buy credits. The file is kept only while it waits:
// it is deleted as soon as an admin verifies or rejects it. Lives in the people cluster with the student's
// other personal data.
const dafSubmissionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userEmail: { type: String, default: '' },
  userName: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending', index: true },
  fileName: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  file: { type: Buffer, select: false },
  reason: { type: String, default: '' },
  reviewedBy: { type: String, default: '' },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

dafSubmissionSchema.index({ status: 1, createdAt: -1 });

export default peopleConn.model('DafSubmission', dafSubmissionSchema);
