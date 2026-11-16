import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// One spoken answer in the Practice Studio: the numbers measured on the student's device (pace, pauses,
// fillers...) and, when they asked for it, the AI's scores. Never the recording itself.
const practiceAttemptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  questionKey: { type: String, default: '' },
  question: { type: String, default: '' },
  lang: { type: String, enum: ['en', 'hi'], default: 'en' },
  metrics: {
    durationSec: Number,
    speakingSec: Number,
    words: Number,
    wpm: Number,
    fillers: Number,
    fillersPerMin: Number,
    longPauses: Number,
    pauses: Number,
    hedges: Number,
    startDelaySec: Number,
    pitchVariation: Number,
    trailingOff: Boolean
  },
  scores: {
    pace: Number,
    fluency: Number,
    confidence: Number,
    tone: Number,
    content: Number
  },
  ai: { type: Boolean, default: false },
  toneLabel: { type: String, default: '' }
}, { timestamps: true });

practiceAttemptSchema.index({ user: 1, createdAt: -1 });

export default peopleConn.model('PracticeAttempt', practiceAttemptSchema);
