import mongoose from 'mongoose';

const progressPyqSchema = new mongoose.Schema({
  questionText: { type: String, required: true, trim: true },
  subject: { type: String, required: true }, // matches Course.subject
  section: { type: String, required: true, trim: true }, // free text, not syllabus-matched
  year: { type: Number, required: true }
}, { timestamps: true });

progressPyqSchema.index({ subject: 1 });

export default mongoose.model('ProgressPyq', progressPyqSchema);
