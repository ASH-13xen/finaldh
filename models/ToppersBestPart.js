import mongoose from 'mongoose';

// "Best part of the answer" — a region an admin cropped out of a topper's answer copy
// to show students the strongest stretch of it (a sharp intro, a diagram, a conclusion).
// The crop is rendered in the admin's browser from the topic PDF and stored as an image.
//
// Kept in its own collection (not inside ToppersCopy.questions[]) for the same reason as
// ToppersEnhancement: the admin PATCH /admin/:id rewrites questions[] wholesale. Attached
// to its question by questionId, falling back to the answer whose page range holds `page`.

const toppersBestPartSchema = new mongoose.Schema({
  toppersCopy: { type: mongoose.Schema.Types.ObjectId, ref: 'ToppersCopy', required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  page: { type: Number, required: true },            // absolute page in the topic PDF
  // The cropped box as fractions of the page (0 = top/left), kept so a crop can be redone.
  rect: {
    x: { type: Number, min: 0, max: 1, default: 0 },
    y: { type: Number, min: 0, max: 1, default: 0 },
    w: { type: Number, min: 0, max: 1, default: 1 },
    h: { type: Number, min: 0, max: 1, default: 1 },
  },
  topperName: { type: String, default: '', trim: true },
  caption: { type: String, default: '', trim: true }, // why this part is good
  key: { type: String, required: true },              // 'r2://tc-best-parts/…'
  width: { type: Number, default: 0 },                // image pixels, for layout before load
  height: { type: Number, default: 0 },
  order: { type: Number, default: 0 },
}, { timestamps: true });

toppersBestPartSchema.index({ toppersCopy: 1, questionId: 1, order: 1 });

export default mongoose.model('ToppersBestPart', toppersBestPartSchema);
