import mongoose from 'mongoose';

// Mirrors PurchaseRequest.js's shape, scoped to McqTest/subject instead of Course/combo
// bundles - same manual UPI-screenshot-plus-admin-approval flow, separate collection so
// this doesn't need to touch the Course-specific fields on the existing model.
//
// Two shapes share this collection, discriminated by purchaseType:
// - 'test': single-test purchase (legacy path, kept working for pre-existing data/requests).
// - 'subject': unlocks an entire subject (see McqSubjectPricing / User.purchasedMcqSubjects).
const mcqPurchaseRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  purchaseType: { type: String, enum: ['test', 'subject'], default: 'test' },
  mcqTestObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest' },
  mcqTestTitle: { type: String },
  subject: { type: String },
  price: { type: Number, required: true },
  screenshotUrl: { type: String, required: true },
  screenshotData: { type: Buffer },
  screenshotContentType: { type: String },
  upiTxnId: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  telegramNotificationCount: { type: Number, default: 0 },
  highlight: { type: String, enum: ['none', 'red', 'yellow'], default: 'none' }
}, { timestamps: true });

export default mongoose.model('McqPurchaseRequest', mcqPurchaseRequestSchema);
