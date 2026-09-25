import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// One row per issued secured PDF. The License ID printed on every page (and hidden in the file) is the
// key: given a leaked copy, look up its License ID here to see who it was issued to, when and from
// where. Name/email/mobile are snapshotted at issue time because profile fields can be edited later.
const downloadLogSchema = new mongoose.Schema({
  licenseId: { type: String, required: true, unique: true },
  fingerprint: { type: Number }, // uint32 carried by the per-page position marks

  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userEmail: { type: String, required: true, index: true },
  userName: { type: String, default: '' },
  userMobile: { type: String, default: '' },

  courseObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },
  courseId: { type: String, required: true }, // composite key for multi-file courses: "<courseId>_<index>"
  courseName: { type: String, default: '' },
  fileIndex: { type: Number, default: 0 },

  ip: { type: String, default: '' },
  forwardedFor: { type: String, default: '' },
  userAgent: { type: String, default: '' },

  status: { type: String, enum: ['queued', 'ready', 'delivered', 'failed'], default: 'queued' },
  issuedAt: { type: Date, default: Date.now }
}, { timestamps: true });

downloadLogSchema.index({ issuedAt: -1 });

export default peopleConn.model('DownloadLog', downloadLogSchema);
