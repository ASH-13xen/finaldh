import mongoose from 'mongoose';

// A student-facing theme of the Economy Master File. Seeded from utils/economyThemes.js by the
// importer; admins can rename, describe, publish and link it to Question Bank PYQs.
//
// pyq.subject + pyq.topics point at QuizQuestion docs (the Question Bank pool), so the theme's
// "PYQs" tab reuses the existing practice engine instead of a second MCQ store.

const economyThemeSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  order: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: false },
  pyq: {
    subject: { type: String, default: '' },        // QuestionBank.subject, e.g. "Economy"
    topics: { type: [String], default: [] },       // QuizQuestion.topic values in that bank
  },
}, { timestamps: true });

export default mongoose.model('EconomyTheme', economyThemeSchema);
