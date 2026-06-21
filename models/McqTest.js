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
  isPublished: { type: Boolean, default: true },
  instructions: { type: [String], default: [] },

  // Inert until a future paywall phase - lets purchase-gating be added later without a migration.
  requiresPurchase: { type: Boolean, default: false },
  price: { type: Number, default: 0 }
}, { timestamps: true });

mcqTestSchema.index({ subject: 1, isPublished: 1 });

export default mongoose.model('McqTest', mcqTestSchema);
