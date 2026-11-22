import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// A DAF a student uploaded for verification. An admin checks it is a genuine DAF (Admin -> DAF Checks); until
// then the student can't practise, use the free AI uses or buy credits. The file is kept (admins can look at it
// again after reviewing it, or delete the entry). Lives in the people cluster with the student's other personal
// data.
const dafSubmissionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userEmail: { type: String, default: '' },
  userName: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending', index: true },
  // 'first': the DAF that unlocks the section; 'change': a paid re-upload by a verified student; 'roll': a
  // verified student's roll number with proof (the file is the proof), free.
  kind: { type: String, enum: ['first', 'change', 'roll'], default: 'first' },
  // How the DAF came in: 'file' (uploaded) or 'form' (filled in by hand: `fields` holds what the student typed,
  // and `file`, if any, is the proof of the roll number they gave).
  source: { type: String, enum: ['file', 'form'], default: 'file' },
  fields: { type: mongoose.Schema.Types.Mixed, default: null },
  // The UPSC roll number read from it (or, for 'roll', the one the student asks for); once verified, the
  // one the admin saved. Checked against the schedule.
  rollNo: { type: String, default: '' },
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
