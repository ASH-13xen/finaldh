import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// A student's own preparation: where each question stands (not started -> confident), saved questions,
// their answer notes, and the interview date for the countdown. Keyed by a hash of the question's wording
// (lib/interview/prep.js), so a question keeps its status when predictions are rebuilt.
const prepItemSchema = new mongoose.Schema({
  key: { type: String, required: true },
  text: { type: String, default: '' }, // the question, so lists render without the bank
  familyId: { type: String, default: '' },
  source: { type: String, default: '' }, // past | tailored | new | bank
  status: { type: String, enum: ['todo', 'drafted', 'practised', 'confident'], default: 'todo' },
  saved: { type: Boolean, default: false },
  note: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const interviewPrepSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: { type: [prepItemSchema], default: [] },
  interviewDate: { type: Date, default: null }
}, { timestamps: true });

export default peopleConn.model('InterviewPrep', interviewPrepSchema);
