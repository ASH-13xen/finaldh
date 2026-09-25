import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  fullName: { type: String },
  mobileNumber: { type: String },
  telegramUsername: { type: String },
  interestedCourses: { type: [String], default: [] },
  picture: { type: String },
  optionalSubject: { type: String, default: null },
  completedTopics: { type: [String], default: [] },
  purchasedCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  purchasedMcqTests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'McqTest' }],
  // Owning a subject unlocks every test in it - present and future - rather than a fixed
  // snapshot; see McqSubjectPricing and the isOwned checks in mcqController.js.
  purchasedMcqSubjects: [{ type: String }],
  // The one active login for this account - see utils/session.js. id is cleared on
  // logout; lastSeenAt is kept so the device-switch lock still applies afterwards.
  session: {
    id: { type: String, default: null },
    deviceId: { type: String, default: null },
    device: { type: String, default: null },
    startedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null }
  },
  downloadLimits: [{
    courseId: { type: String, required: true },
    downloadedCount: { type: Number, default: 0 },
    allowedCount: { type: Number, default: 1 }
  }]
}, { timestamps: true });

export default peopleConn.model('User', userSchema);
