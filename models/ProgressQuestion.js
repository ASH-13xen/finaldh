import mongoose from 'mongoose';

const progressQuestionSchema = new mongoose.Schema({
  topic: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  questionText: { type: String, required: true, trim: true },
  tag: { type: String, default: '', trim: true }, // raw literal, may contain semicolon-separated values
  pageNumber: { type: Number, required: true }, // plain reference, never used to render anything
  order: { type: Number, required: true }
}, { timestamps: true });

progressQuestionSchema.index({ topic: 1, order: 1 });
progressQuestionSchema.index({ course: 1, fileIndex: 1 });

export default mongoose.model('ProgressQuestion', progressQuestionSchema);
