import mongoose from 'mongoose';

const responseTagSchema = new mongoose.Schema({
  section: { type: String, required: true },
  title: { type: String, default: '' }
}, { _id: false });

// Every field here is a snapshot taken at attempt-start time (not a live join to McqQuestion),
// so historical analytics stay valid even if a question is later edited/removed, and every
// analytics feature can be computed from McqAttempt alone with no cross-collection joins.
const questionResponseSchema = new mongoose.Schema({
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'McqQuestion', required: true },
  order: { type: Number, required: true },

  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'] },
  tags: { type: [responseTagSchema], default: [] },
  maxMarks: { type: Number, required: true },
  negativeMarks: { type: Number, required: true },

  selectedOption: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
  correctOption: { type: String, enum: ['A', 'B', 'C', 'D'] },
  isCorrect: { type: Boolean, default: null },

  status: {
    type: String,
    enum: ['not-visited', 'not-answered', 'answered', 'marked-for-review', 'answered-marked-for-review'],
    default: 'not-visited'
  },

  timeSpentSeconds: { type: Number, default: 0 },
  visitCount: { type: Number, default: 0 },
  firstVisitedAt: { type: Date, default: null },
  lastVisitedAt: { type: Date, default: null },
  answerChangedCount: { type: Number, default: 0 },
  marksAwarded: { type: Number, default: 0 }
}, { _id: false });

const mcqAttemptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest', required: true },
  subject: { type: String, required: true }, // denormalized from McqTest for fast history queries

  status: { type: String, enum: ['in-progress', 'submitted', 'auto-submitted', 'abandoned'], default: 'in-progress' },

  startedAt: { type: Date, required: true, default: Date.now },
  submittedAt: { type: Date, default: null },
  durationMinutes: { type: Number, required: true }, // snapshot of McqTest.durationMinutes at start
  serverDeadline: { type: Date, required: true }, // startedAt + durationMinutes - source of truth for timing

  responses: { type: [questionResponseSchema], default: [] },

  lastActiveQuestionOrder: { type: Number, default: 1 },

  // Aggregate scoring snapshot, computed server-side once at submission.
  totalMarksObtained: { type: Number, default: 0 },
  totalCorrect: { type: Number, default: 0 },
  totalWrong: { type: Number, default: 0 },
  totalUnattempted: { type: Number, default: 0 },
  totalMarked: { type: Number, default: 0 },
  accuracyPercent: { type: Number, default: 0 },
  totalTimeSpentSeconds: { type: Number, default: 0 }
}, { timestamps: true });

mcqAttemptSchema.index({ user: 1, test: 1, createdAt: -1 });
mcqAttemptSchema.index({ user: 1, subject: 1, status: 1 });

export default mongoose.model('McqAttempt', mcqAttemptSchema);
