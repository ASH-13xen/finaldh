import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

// One Razorpay order and what it unlocks once paid. Covers every paid product (single course, combo
// offer, MCQ subject) in one collection - unlike the legacy UPI flow, which kept courses in
// PurchaseRequest and MCQ in McqPurchaseRequest.
//
// status: 'created' when the order is made, 'paid' once Razorpay confirms the money (via the browser's
// verify call, the webhook, or a status check - whichever arrives first), 'failed' if the last attempt
// on the order failed. A failed order can still turn 'paid' if the student retries inside Checkout.
// Access is granted when fulfilledAt is set; granting is idempotent, so a crash between 'paid' and
// fulfilledAt is repaired by the next verify / webhook / status check.
const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  kind: { type: String, enum: ['course', 'combo', 'mcq_subject'], required: true },
  itemLabel: { type: String, required: true },
  courses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  courseIds: { type: [String], default: [] },
  comboOffer: { type: mongoose.Schema.Types.ObjectId, ref: 'ComboOffer' },
  subject: { type: String },
  // In paise, exactly as sent to Razorpay (₹499 = 49900)
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  razorpayOrderId: { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, index: true },
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created', index: true },
  method: { type: String },
  failureReason: { type: String },
  paidAt: { type: Date },
  fulfilledAt: { type: Date },
  confirmedVia: { type: String, enum: ['verify', 'webhook', 'status-check'] }
}, { timestamps: true });

export default peopleConn.model('Payment', paymentSchema);
