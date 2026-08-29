import mongoose from 'mongoose';

// A Question Bank is a named pool of MCQs for one subject (e.g. "Geography", "Indian Polity").
// The questions themselves live in the QuizQuestion collection, matched by `subject`. This doc
// is just the bank's metadata + publish state; the student practice engine (topic / random /
// all modes) is shared with every bank.
//
// `subject` is the stable key that ties a bank to its QuizQuestion rows and to QuizAttempt
// history — it is set once at creation and never edited.
const questionBankSchema = new mongoose.Schema({
  subject: { type: String, required: true, unique: true, trim: true },
  title: { type: String, required: true, trim: true },   // display name, e.g. "Geography — Question Bank"
  description: { type: String, default: '' },
  isPublished: { type: Boolean, default: false },         // hidden from students until true
  order: { type: Number, default: 0 }                     // sort order on the student landing
}, { timestamps: true });

questionBankSchema.index({ isPublished: 1, order: 1 });

export default mongoose.model('QuestionBank', questionBankSchema);
