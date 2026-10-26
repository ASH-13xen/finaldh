import mongoose from 'mongoose';

// A student's state on one Economy Master File topic.
//   read     — went through it once
//   revised  — came back to it at least once after a gap
//   mastered — student says they've got it; drops out of the revision queue
// Each "read" / "revised" schedules the next revision (1 → 3 → 7 → 21 days), so the
// tracker can show what's due today.

export const STATUSES = ['read', 'revised', 'mastered'];

const economyProgressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: mongoose.Schema.Types.ObjectId, ref: 'EconomyTopic', required: true },
  themeKey: { type: String, required: true },      // denormalised for per-theme counts
  status: { type: String, enum: STATUSES, required: true },
  reviews: { type: Number, default: 0 },
  lastReviewedAt: { type: Date, default: null },
  nextReviewAt: { type: Date, default: null },
}, { timestamps: true });

economyProgressSchema.index({ user: 1, topic: 1 }, { unique: true });
economyProgressSchema.index({ user: 1, themeKey: 1 });
economyProgressSchema.index({ user: 1, nextReviewAt: 1 });

export default mongoose.model('EconomyProgress', economyProgressSchema);
