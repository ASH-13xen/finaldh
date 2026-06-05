import mongoose from 'mongoose';

const courseSchema = new mongoose.Schema({
  courseId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subject: { type: String, required: true },
  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  price: { type: Number, default: 499 }
}, { timestamps: true });

export default mongoose.model('Course', courseSchema);
