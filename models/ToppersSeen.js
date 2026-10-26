import mongoose from 'mongoose';

// "Seen / completed" tick on a Toppers Copy question, per student. Replaces the old
// per-browser localStorage `tc_seen_v1` so progress follows the student across devices.
// `question` is a ToppersCopy.questions[]._id; `toppersCopy` is the owning topic doc (lets a
// collapsed topic report its progress without loading its questions).
const toppersSeenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: { type: mongoose.Schema.Types.ObjectId, required: true },
  toppersCopy: { type: mongoose.Schema.Types.ObjectId, ref: 'ToppersCopy', default: null },
}, { timestamps: true });

toppersSeenSchema.index({ user: 1, question: 1 }, { unique: true });

export default mongoose.model('ToppersSeen', toppersSeenSchema);
