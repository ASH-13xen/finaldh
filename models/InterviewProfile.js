import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

const educationSchema = new mongoose.Schema({
  degree: { type: String, default: '' }, // "B.Tech"
  discipline: { type: String, default: '' }, // "Electronics & Communication"
  institution: { type: String, default: '' }, // "IIT Bombay"
  year: { type: String, default: '' }
}, { _id: false });

const workSchema = new mongoose.Schema({
  role: { type: String, default: '' },
  organization: { type: String, default: '' },
  duration: { type: String, default: '' }
}, { _id: false });

// The interview-relevant parts of a student's DAF (Detailed Application Form), entered by hand or read
// from an uploaded DAF by Gemini. The uploaded file itself is never stored. Lives in the people cluster
// because it describes a real person.
const interviewProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  homeState: { type: String, default: '' },
  homeDistrict: { type: String, default: '' },
  hometown: { type: String, default: '' },
  education: { type: [educationSchema], default: [] },
  work: { type: [workSchema], default: [] },
  optional: { type: String, default: '' },
  hobbies: { type: [String], default: [] },
  achievements: { type: [String], default: [] }, // NCC/NSS, awards, papers, positions of responsibility
  servicePreference: { type: [String], default: [] },
  familyBackground: { type: String, default: '' },
  languages: { type: [String], default: [] },
  otherNotes: { type: String, default: '' },
  source: { type: String, enum: ['manual', 'upload'], default: 'manual' },

  // Predictions are expensive with Gemini, so the last result is kept until the profile changes.
  predictionCache: {
    hash: { type: String, default: '' },
    generatedAt: { type: Date, default: null },
    aiUsed: { type: Boolean, default: false },
    data: { type: mongoose.Schema.Types.Mixed, default: null }
  },

  // Per-day counters for the Gemini-backed actions (reset when `day` changes).
  usage: {
    day: { type: String, default: '' },
    extracts: { type: Number, default: 0 },
    predictionRuns: { type: Number, default: 0 },
    transcribes: { type: Number, default: 0 }
  }
}, { timestamps: true });

export default peopleConn.model('InterviewProfile', interviewProfileSchema);
