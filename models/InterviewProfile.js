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

// The interview-relevant parts of a student's DAF (Detailed Application Form), entered by hand on the
// website's form. Lives in the people cluster because it describes a real person.
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
  source: { type: String, enum: ['manual', 'upload'], default: 'manual' }, // 'upload' only on profiles from when a DAF file could be read

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
    predictionRuns: { type: Number, default: 0 },
    transcribes: { type: Number, default: 0 },
    extracts: { type: Number, default: 0 }, // DAF files read by AI
    approaches: { type: Number, default: 0 }, // "how to approach" guides generated (cached ones are free)
    practiceAI: { type: Number, default: 0 }, // Practice Studio answers given AI feedback
    aiUses: { type: Number, default: 0 } // credits spent today (lib/interview/credits.js caps the day)
  },

  // DAF verification (lib/interview/dafCheck.js): an admin checks the uploaded DAF before practice and AI
  // credits unlock.
  // UPSC roll number, read from the uploaded DAF and confirmed by the student; matched to the interview
  // schedule (models/InterviewSchedule.js). Shown back only to the student, once their DAF is verified.
  rollNo: { type: String, default: '' },
  // When the DAF details were first saved: after verification, changing them is a paid re-upload.
  detailsSavedAt: { type: Date, default: null },
  // A change of DAF after verification (paid, re-uploaded, verified again). The current details and
  // predictions stay until an admin verifies the new DAF; then its fields replace them.
  dafChange: {
    status: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
    submissionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reason: { type: String, default: '' },
    fields: { type: mongoose.Schema.Types.Mixed, default: null },
    appliedAt: { type: Date, default: null }
  },
  // DAF uploads: one per account, plus one more each time an admin rejects the DAF (no defaults, so
  // students who uploaded before this existed are counted from dafCheck - see lib/interview/dafCheck.js).
  dafUploads: {
    used: { type: Number },
    allowed: { type: Number }
  },
  dafCheck: {
    status: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
    submissionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reason: { type: String, default: '' }
  },

  // AI credits (lib/interview/credits.js): free ones used so far, and bought ones left.
  credits: {
    freeUsed: { type: Number, default: 0 },
    paid: { type: Number, default: 0 }
  },

  // Predictions per language ({ en: { hash, generatedAt, aiUsed, data }, hi: {...} }); replaces predictionCache.
  predictionCaches: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

export default peopleConn.model('InterviewProfile', interviewProfileSchema);
