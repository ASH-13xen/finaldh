import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// Where a question came from, shown to the student as a chip ("Asked in 2023 · similar asked 9x").
const sourceSchema = new mongoose.Schema({
  kind: { type: String, enum: ['opening', 'family', 'pattern', 'predicted', 'followup', 'generated', 'closing'], required: true },
  family: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewFamily', default: null },
  familyText: { type: String, default: '' },
  timesAsked: { type: Number, default: 0 },
  years: { type: [Number], default: [] },
  hookType: { type: String, default: '' },
  hookValue: { type: String, default: '' },
  label: { type: String, default: '' } // e.g. "Predicted from your DAF: hobby → gaming"
}, { _id: false });

const feedbackSchema = new mongoose.Schema({
  score: { type: Number, min: 0, max: 10, default: null },
  verdict: { type: String, default: '' }, // one line
  strengths: { type: [String], default: [] },
  improve: { type: [String], default: [] },
  betterAnswer: { type: String, default: '' }, // pointers for a stronger answer
  pastNote: { type: String, default: '' } // what a past candidate answered / how that board reacted
}, { _id: false });

const turnSchema = new mongoose.Schema({
  idx: { type: Number, required: true },
  asker: { type: String, required: true }, // chairman | m1..m4
  question: { type: String, required: true },
  source: { type: sourceSchema, required: true },
  planSlot: { type: Number, default: null },
  answer: { type: String, default: '' },
  answerMode: { type: String, enum: ['text', 'voice', null], default: null },
  skipped: { type: Boolean, default: false },
  askedAt: { type: Date, default: Date.now },
  answeredAt: { type: Date, default: null },
  answerSeconds: { type: Number, default: 0 },
  feedback: { type: feedbackSchema, default: undefined }
}, { _id: false });

// One planned question slot. The interviewer works through these in order, inserting follow-ups between.
const planItemSchema = new mongoose.Schema({
  slot: { type: Number, required: true },
  asker: { type: String, required: true },
  text: { type: String, required: true },
  source: { type: sourceSchema, required: true },
  followUps: { type: [String], default: [] }, // past follow-ups to this family, used without Gemini
  used: { type: Boolean, default: false }
}, { _id: false });

const traitSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  score: { type: Number, min: 0, max: 10, default: null },
  comment: { type: String, default: '' }
}, { _id: false });

const interviewSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // 'practice' shows sources and per-answer feedback as you go; 'real' keeps everything for the report.
  mode: { type: String, enum: ['practice', 'real'], default: 'practice' },
  inputMode: { type: String, enum: ['text', 'voice'], default: 'text' },
  durationMinutes: { type: Number, default: 20 },
  focus: { type: [String], default: [] }, // DAF item keys the student asked to concentrate on
  profileSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  status: { type: String, enum: ['in-progress', 'completed', 'abandoned'], default: 'in-progress', index: true },
  aiUsed: { type: Boolean, default: false },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  plan: { type: [planItemSchema], default: [] },
  turns: { type: [turnSchema], default: [] },
  report: {
    generatedBy: { type: String, enum: ['gemini', 'basic', null], default: null },
    overall: { type: Number, default: null },
    summary: { type: String, default: '' },
    traits: { type: [traitSchema], default: [] },
    strengths: { type: [String], default: [] },
    improvements: { type: [String], default: [] },
    dafGaps: { type: [String], default: [] },
    stats: { type: mongoose.Schema.Types.Mixed, default: null }
  }
}, { timestamps: true });

interviewSessionSchema.index({ user: 1, createdAt: -1 });

export default peopleConn.model('InterviewSession', interviewSessionSchema);
