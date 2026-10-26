import mongoose from 'mongoose';

// A student's saved study item: either a BOOKMARK (one per thing, toggled on/off) or a NOTE
// (any number per thing — a quote they selected plus their own comment). Both point back at
// what they were reading so My Notes can reopen it.
//
// refType decides which `ref` fields are set:
//   tc_question -> ref.toppersCopy + ref.question               (a Toppers Copy question)
//   tc_answer   -> ref.toppersCopy + ref.question + ref.answerIdx (one topper's scanned answer)
//   tc_pyq      -> ref.pyq                                      (a Related PYQ)
//   qb_question -> ref.quizQuestion                             (a Question Bank MCQ)
// `refKey` is the canonical string form of the ref, built server-side (studyController), so
// bookmark uniqueness and client-side "is this starred?" lookups are one string compare.
//
// `context` is a snapshot taken at save time (question text, topper, pages…) so the list still
// reads sensibly if the source is later edited or re-imported with new _ids.

export const REF_TYPES = ['tc_question', 'tc_answer', 'tc_pyq', 'qb_question'];
export const SECTIONS = ['toppers_copy', 'question_bank'];

const userNoteSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['bookmark', 'note'], required: true },
  refType: { type: String, enum: REF_TYPES, required: true },
  refKey: { type: String, required: true },

  ref: {
    toppersCopy: { type: mongoose.Schema.Types.ObjectId, ref: 'ToppersCopy', default: null },
    question: { type: mongoose.Schema.Types.ObjectId, default: null },   // ToppersCopy.questions[]._id
    answerIdx: { type: Number, default: null },
    pyq: { type: mongoose.Schema.Types.ObjectId, ref: 'ToppersPyq', default: null },
    quizQuestion: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizQuestion', default: null },
  },

  context: {
    section: { type: String, enum: SECTIONS, required: true },
    subject: { type: String, default: '' },
    topic: { type: String, default: '' },
    title: { type: String, default: '' },      // question text
    subtitle: { type: String, default: '' },   // e.g. "Anudeep Durishetty · AIR 1 · pp. 12-14"
    startPage: { type: Number, default: null },
    endPage: { type: Number, default: null },
  },

  quote: { type: String, default: '' },        // text the student selected (notes only)
  quoteFrom: { type: String, default: '' },    // where it was selected, e.g. "AI analysis"
  body: { type: String, default: '' },         // the student's own words (notes only)

  revisedCount: { type: Number, default: 0 },
  lastRevisedAt: { type: Date, default: null },
}, { timestamps: true });

userNoteSchema.index(
  { user: 1, refKey: 1 },
  { unique: true, partialFilterExpression: { kind: 'bookmark' } }
);
userNoteSchema.index({ user: 1, 'context.section': 1, updatedAt: -1 });
userNoteSchema.index({ user: 1, refType: 1, 'context.subject': 1 });

export default mongoose.model('UserNote', userNoteSchema);
