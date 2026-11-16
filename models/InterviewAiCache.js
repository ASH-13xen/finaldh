import mongoose from 'mongoose';

// AI output that is the same for every student (how to approach a question, a translation), made once and
// reused. Keyed by kind + a hash of the input + language. Kept in the content database, apart from student
// data; it survives re-seeding the bank because keys come from wording, not database ids.
const interviewAiCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

export default mongoose.model('InterviewAiCache', interviewAiCacheSchema);
