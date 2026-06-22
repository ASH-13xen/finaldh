import mongoose from 'mongoose';

const courseSchema = new mongoose.Schema({
  courseId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  subject: { type: String, required: true },
  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  fileUrls: { type: [String], default: [] },
  fileNames: { type: [String], default: [] },
  partPageCounts: { type: [Number], default: [] },
  price: { type: Number, default: 499 },
  discountedPrice: { type: Number, default: 499 },
  useDiscount: { type: Boolean, default: false },
  discountLimitTag: { type: Boolean, default: false },
  sampleFileUrl: { type: String, default: '' },
  sampleFileName: { type: String, default: '' },
  samplePageCount: { type: Number, default: 0 }
}, { timestamps: true });

export default mongoose.model('Course', courseSchema);
