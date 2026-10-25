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
  samplePageCount: { type: Number, default: 0 },
  progressEnabled: { type: Boolean, default: false },
  telegramGroupLink: { type: String, default: '' },
  // Which exam stage this course belongs to. Defaults to 'Mains' so every course created
  // before this field existed keeps behaving exactly as before with zero data migration
  // required - only courses explicitly tagged 'Prelims' move into the Prelims section.
  examStage: { type: String, enum: ['Prelims', 'Mains'], default: 'Mains' }
}, { timestamps: true });

export default mongoose.model('Course', courseSchema);
