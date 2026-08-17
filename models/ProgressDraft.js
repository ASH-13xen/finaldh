import mongoose from 'mongoose';

const draftQuestionSchema = new mongoose.Schema({
  tempId: { type: String, required: true },
  questionText: { type: String, default: '', trim: true },
  pageNumber: { type: Number, default: null }
}, { _id: false });

const draftTopicSchema = new mongoose.Schema({
  tempId: { type: String, required: true },
  name: { type: String, default: '', trim: true },
  questions: { type: [draftQuestionSchema], default: [] }
}, { _id: false });

// Whole-document autosave target for the manual topic/question authoring step of the
// Progress Section Builder (admin-only). One draft per (course, fileIndex) - no TTL,
// persists until the admin explicitly commits it (see upsertTopicsAndQuestions in
// progressController.js) or deletes it.
const progressDraftSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topics: { type: [draftTopicSchema], default: [] }
}, { timestamps: true });

progressDraftSchema.index({ course: 1, fileIndex: 1 }, { unique: true });

export default mongoose.model('ProgressDraft', progressDraftSchema);
