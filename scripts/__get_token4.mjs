import 'dotenv/config';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Course from '../models/Course.js';

await mongoose.connect(process.env.MONGODB_URI);

const email = '__verification_viewer4@local.test';
await User.deleteOne({ email });
const aCourse = await Course.findOne({ courseId: 'Essay' }) || await Course.findOne({});

const student = await User.create({
  googleId: '__verify_viewer4_' + Date.now(),
  email,
  name: 'Verification Viewer 4',
  fullName: 'Verification Viewer 4',
  interestedCourses: [aCourse.courseId],
  purchasedCourses: [aCourse._id],
  downloadLimits: []
});
const token = jwt.sign({ userId: student._id.toString() }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '1h' });
console.log(JSON.stringify({ token, courseId: aCourse.courseId, courseName: aCourse.name, pdfCount: (aCourse.fileUrls?.length || 1) }));
await mongoose.disconnect();
