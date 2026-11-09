import mongoose from 'mongoose';

const hookSchema = new mongoose.Schema({
  type: { type: String, required: true }, // see HOOK_TYPES in lib/interview/taxonomy.js
  value: { type: String, default: '' } // the DAF item it targeted ('cricket', 'iit bombay'), '' for area-only
}, { _id: false });

// A single question asked in one transcript. Denormalises year/board from the transcript so the bank's
// filters and family statistics never need a join.
const interviewQuestionSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  transcript: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewTranscript', required: true, index: true },
  family: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewFamily', default: null, index: true },
  year: { type: Number, required: true },
  board: { type: String, default: '' },
  order: { type: Number, required: true },
  asker: { type: String, enum: ['chairman', 'm1', 'm2', 'm3', 'm4', 'm5', 'member', 'unknown'], default: 'unknown' },
  text: { type: String, required: true },
  originalText: { type: String, default: '' }, // source wording when the parser translated / rewrote it
  followUp: { type: Boolean, default: false },
  note: { type: String, default: '' }, // what the candidate answered / how the board reacted
  hooks: { type: [hookSchema], default: [] },
  topics: { type: [String], default: [] },
  qtype: { type: String, default: 'other' },
  shelfLife: { type: String, enum: ['evergreen', 'event'], default: 'evergreen' },
  trivial: { type: Boolean, default: false }, // "Why?" - kept in the transcript, left out of the bank
  // The question with its DAF item replaced by a placeholder, so "History of {X}?" asked about cricket,
  // chess and kabaddi can be offered for any hobby. pattern is the token key, patternText the wording.
  pattern: { type: String, default: '' },
  patternText: { type: String, default: '' },
  patternType: { type: String, default: '' }, // the hook type whose value was masked
  hidden: { type: Boolean, default: false }
}, { timestamps: true });

interviewQuestionSchema.index({ transcript: 1, order: 1 });
interviewQuestionSchema.index({ pattern: 1 }, { partialFilterExpression: { pattern: { $gt: '' } } });

export default mongoose.model('InterviewQuestion', interviewQuestionSchema);
