import mongoose from 'mongoose';

// Near-identical questions asked in different interviews, grouped. The statistics are recomputed from
// the member questions whenever they change (lib/interview/familyStats.js), never edited by hand.
const interviewFamilySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  text: { type: String, required: true }, // the wording shown in the bank
  size: { type: Number, default: 0 }, // member questions
  transcriptCount: { type: Number, default: 0 }, // distinct interviews it was asked in
  years: { type: [Number], default: [] },
  yearCounts: { type: Map, of: Number, default: {} },
  firstYear: { type: Number },
  lastYear: { type: Number, index: true },
  boards: { type: [String], default: [] },
  // A list rather than a Map: board names like "B.B. Swain" contain dots, which Map keys can't.
  boardCounts: { type: [{ _id: false, board: String, n: Number }], default: [] },
  topics: { type: [String], default: [], index: true },
  hookTypes: { type: [String], default: [] },
  hookValues: { type: [String], default: [] },
  askers: { type: Map, of: Number, default: {} },
  qtype: { type: String, default: 'other' },
  shelfLife: { type: String, default: 'evergreen' },
  // Gemini embedding of the family (int8, 256 dims) for semantic search; absent until `pipeline embed`.
  vec: { type: Buffer, default: undefined, select: false },
  hidden: { type: Boolean, default: false }
}, { timestamps: true });

interviewFamilySchema.index({ transcriptCount: -1 });

export default mongoose.model('InterviewFamily', interviewFamilySchema);
