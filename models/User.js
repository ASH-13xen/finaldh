import mongoose from 'mongoose';

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
  downloadLimits: [{
    courseId: { type: String, required: true },
    downloadedCount: { type: Number, default: 0 },
    allowedCount: { type: Number, default: 1 }
  }]
}, { timestamps: true });

export default mongoose.model('User', userSchema);
