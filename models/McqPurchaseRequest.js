import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// Mirrors PurchaseRequest.js's shape, scoped to McqTest/subject instead of Course/combo
// bundles - same pay-then-admin-verifies flow, separate collection so this doesn't need to
// touch the Course-specific fields on the existing model.
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
  // 'upi_manual': legacy QR payment proven by a screenshot. 'razorpay': paid through Razorpay Checkout
  // (see paymentController.js) - the money is confirmed, the admin still verifies the buyer before access.
  paymentMethod: { type: String, enum: ['upi_manual', 'razorpay'], default: 'upi_manual' },
  razorpayOrderId: { type: String, unique: true, sparse: true },
  razorpayPaymentId: { type: String },
  // What the buyer typed into Razorpay Checkout - shown to the admin next to the account's name and email
  payerContact: { type: String },
  payerEmail: { type: String },
  payerMethod: { type: String },
  screenshotUrl: { type: String, required: function () { return this.paymentMethod !== 'razorpay'; } },
  screenshotData: { type: Buffer },
  screenshotContentType: { type: String },
  upiTxnId: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  rejectedAt: { type: Date },
  // Set when the student dismisses the "payment rejected" alert, so it stops showing
  rejectionAcknowledgedAt: { type: Date },
  telegramNotificationCount: { type: Number, default: 0 },
  highlight: { type: String, enum: ['none', 'red', 'yellow'], default: 'none' }
}, { timestamps: true });

export default peopleConn.model('McqPurchaseRequest', mcqPurchaseRequestSchema);
