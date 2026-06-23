import mongoose from 'mongoose';

const progressPyqSchema = new mongoose.Schema({
  questionText: { type: String, required: true, trim: true },
  subject: { type: String, default: '' }, // legacy denormalized field; kept for backward-compat with pre-existing CSV rows
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null }, // course+fileIndex scoping for the extraction flow
  fileIndex: { type: Number, default: null },
  section: { type: String, required: true, trim: true }, // free text OR a Topic name; legacy CSV rows keep arbitrary free text
  year: { type: Number, required: true }
}, { timestamps: true });

progressPyqSchema.index({ subject: 1 });
progressPyqSchema.index({ course: 1, fileIndex: 1 });

export default mongoose.model('ProgressPyq', progressPyqSchema);
