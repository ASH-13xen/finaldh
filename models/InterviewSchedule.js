import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// UPSC's published interview (Personality Test) schedule: one row per candidate, uploaded by an admin from
// the PDF UPSC publishes (Admin -> DAF Checks). Used to show a verified student their own interview date and
// to help admins check an uploaded DAF. Personal data, so it lives in the people cluster, and a student only
// ever sees the row with their own roll number.
const interviewScheduleSchema = new mongoose.Schema({
  roll: { type: String, required: true, unique: true }, // 7 digits, e.g. "0811049"
  name: { type: String, default: '' },
  date: { type: String, required: true }, // "2026-12-07"
  day: { type: String, default: '' }, // "Monday"
  session: { type: String, enum: ['Forenoon', 'Afternoon'], required: true },
  reportingTime: { type: String, required: true }, // "09:00" (Indian time)
  sl: { type: Number, default: 0 },
  fileName: { type: String, default: '' }
}, { timestamps: true });

export default peopleConn.model('InterviewSchedule', interviewScheduleSchema);
