import mongoose from 'mongoose';

const mcqTestSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subject: { type: String, required: true },
  description: { type: String, default: '' },
  durationMinutes: { type: Number, required: true },
  totalMarks: { type: Number, default: 0 },
  marksPerQuestion: { type: Number, default: 2 },
  negativeMarkingRatio: { type: Number, default: 0.33 },
  questionCount: { type: Number, default: 0 },
  // Defaults to a draft (unpublished) so a test being built (metadata created, questions still
  // being added) never appears live to students with 0 questions. Admin explicitly publishes
  // once ready - see the publish guard in updateTest requiring questionCount > 0.
  isPublished: { type: Boolean, default: false },
  instructions: { type: [String], default: [] },

  // Paywall fields, mirroring Course.js's pricing shape (price default 499) so the same UPI
  // purchase-request flow/UI pattern can be reused for MCQ tests. Locked by default - admin
  // marks specific tests free per subject via the requiresPurchase toggle.
  requiresPurchase: { type: Boolean, default: true },
  price: { type: Number, default: 499 },
  discountedPrice: { type: Number, default: 0 },
  useDiscount: { type: Boolean, default: false }
}, { timestamps: true });

mcqTestSchema.index({ subject: 1, isPublished: 1 });

export default mongoose.model('McqTest', mcqTestSchema);
