import mongoose from 'mongoose';

const responseTagSchema = new mongoose.Schema({
  section: { type: String, required: true },
  title: { type: String, default: '' }
}, { _id: false });

const optionSnapshotSchema = new mongoose.Schema({
  label: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  text: { type: String, required: true }
}, { _id: false });

// Every field here is a snapshot taken at attempt-start time (not a live join to McqQuestion),
// so historical analytics stay valid even if a question is later edited/removed, and every
// analytics feature can be computed from McqAttempt alone with no cross-collection joins.
// `order` is the position of the question WITHIN THIS ATTEMPT (1..N), not the test's question number.
const questionResponseSchema = new mongoose.Schema({
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'McqQuestion', required: true },
  order: { type: Number, required: true },

  // Snapshot of what the student was shown, so an admin edit or delete mid-attempt can never make the
  // runner disagree with the answers it already recorded. (Attempts created before this existed have
  // neither field and fall back to a live lookup by question id.)
  questionText: { type: String },
  options: { type: [optionSnapshotSchema], default: undefined },

  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'] },
  tags: { type: [responseTagSchema], default: [] },
  maxMarks: { type: Number, required: true },
  negativeMarks: { type: Number, required: true },

  selectedOption: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
  correctOption: { type: String, enum: ['A', 'B', 'C', 'D'] },
  isCorrect: { type: Boolean, default: null },

  // Practice mode only: the student pressed "Check answer" and was shown the key. The response is then
  // locked so the accuracy numbers stay honest.
  revealed: { type: Boolean, default: false },

  // Self-reported confidence at answer time - metadata only, never affects scoring.
  // Powers the Decision Confidence breakdown and Decision Intelligence Index in getAttemptResult.
  confidenceTag: { type: String, enum: ['sure', 'elimination', 'guess', null], default: null },

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

const isTimedTest = function () { return this.mode !== 'practice'; };

const mcqAttemptSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Absent for cross-test practice sessions (flagged questions / my mistakes).
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest' },
  subject: { type: String, required: true }, // denormalized from McqTest for fast history queries

  // 'test' = timed, scored, answers hidden until submit. 'practice' = untimed (timer is a display toggle),
  // answers can be checked question by question. Attempts created before modes existed are all 'test'.
  mode: { type: String, enum: ['test', 'practice'], default: 'test' },
  // Where the questions came from. Only 'test' attempts use up one of the student's attempts and appear in ranks.
  source: { type: String, enum: ['test', 'flagged', 'mistakes'], default: 'test' },
  sourceAttempt: { type: mongoose.Schema.Types.ObjectId, ref: 'McqAttempt', default: undefined },
  // Practice only: show a running stopwatch. Time is tracked either way; this only controls display.
  timerEnabled: { type: Boolean, default: true },

  status: { type: String, enum: ['in-progress', 'submitted', 'auto-submitted', 'abandoned'], default: 'in-progress' },

  startedAt: { type: Date, required: true, default: Date.now },
  submittedAt: { type: Date, default: null },
  durationMinutes: { type: Number, required: isTimedTest }, // snapshot of McqTest.durationMinutes (pacing reference for practice)
  serverDeadline: { type: Date, required: isTimedTest, default: null }, // startedAt + durationMinutes - source of truth for timing; null in practice

  responses: { type: [questionResponseSchema], default: [] },

  lastActiveQuestionOrder: { type: Number, default: 1 },

  // Aggregate scoring snapshot, computed server-side once at submission.
  totalMarksObtained: { type: Number, default: 0 },
  totalMaxMarks: { type: Number, default: 0 },
  totalCorrect: { type: Number, default: 0 },
  totalWrong: { type: Number, default: 0 },
  totalUnattempted: { type: Number, default: 0 },
  totalMarked: { type: Number, default: 0 },
  accuracyPercent: { type: Number, default: 0 },
  totalTimeSpentSeconds: { type: Number, default: 0 }
}, { timestamps: true });

mcqAttemptSchema.index({ user: 1, test: 1, createdAt: -1 });
mcqAttemptSchema.index({ user: 1, subject: 1, status: 1 });
mcqAttemptSchema.index({ 'responses.question': 1, user: 1 });
// One unfinished test attempt per student per test. Makes "start" idempotent even when a double-click or
// a second tab fires two requests at once - the loser resumes the winner's attempt instead of creating another.
mcqAttemptSchema.index(
  { user: 1, test: 1 },
  { unique: true, partialFilterExpression: { status: 'in-progress', source: 'test' } }
);

export default mongoose.model('McqAttempt', mcqAttemptSchema);
