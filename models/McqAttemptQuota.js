import mongoose from 'mongoose';

// How many attempts a student has used on a test. Kept as its own atomic counter (instead of counting
// McqAttempt documents) so that two simultaneous "start" requests can never both slip under the limit:
// the increment is a single conditional findOneAndUpdate. See consumeAttempt() in utils/mcqAttempts.js.
const mcqAttemptQuotaSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest', required: true },
  used: { type: Number, default: 0, min: 0 },
  extra: { type: Number, default: 0, min: 0 } // attempts an admin granted this student on top of the test's limit
}, { timestamps: true });

mcqAttemptQuotaSchema.index({ user: 1, test: 1 }, { unique: true });

export default mongoose.model('McqAttemptQuota', mcqAttemptQuotaSchema);
