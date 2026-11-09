import mongoose from 'mongoose';

// One candidate's interview transcript from the community compilations (2020-2024). Loaded by
// scripts/interview/pipeline.mjs seed; admins correct it from the Interview Data screen.
const profileSchema = new mongoose.Schema({
  board: { type: String, default: '' }, // canonical chairperson name, '' when the transcript doesn't say
  boardRaw: { type: String, default: '' },
  date: { type: String, default: '' },
  session: { type: String, default: '' }, // 'FN' | 'AN' | ''
  optional: { type: String, default: '' },
  homeState: { type: String, default: '' },
  home: { type: String, default: '' },
  keywords: { type: [String], default: [] },
  hobbies: { type: [String], default: [] },
  education: { type: [String], default: [] },
  work: { type: [String], default: [] },
  achievements: { type: [String], default: [] },
  servicePreference: { type: String, default: '' },
  duration: { type: String, default: '' }
}, { _id: false });

const interviewTranscriptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // "<year>-<seq>", stable across re-seeds of the same parse
  year: { type: Number, required: true, index: true },
  seq: { type: Number, required: true },
  engine: { type: String, enum: ['heuristic', 'gemini'], default: 'heuristic' },
  pageStart: { type: Number, default: null },
  pageEnd: { type: Number, default: null },
  profile: { type: profileSchema, default: () => ({}) },
  experience: { type: String, default: '' },
  // The text as it appears in the compilation - admin review only, never sent to students.
  rawText: { type: String, default: '', select: false },
  questionCount: { type: Number, default: 0 },
  reviewed: { type: Boolean, default: false, index: true },
  hidden: { type: Boolean, default: false }
}, { timestamps: true });

interviewTranscriptSchema.index({ year: 1, seq: 1 });
interviewTranscriptSchema.index({ 'profile.board': 1 });

export default mongoose.model('InterviewTranscript', interviewTranscriptSchema);
