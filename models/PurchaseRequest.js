import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

const purchaseRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  courseObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  courseId: { type: String, required: true },
  courseName: { type: String, required: true },
  price: { type: Number, required: true },
  courses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  comboOffer: { type: mongoose.Schema.Types.ObjectId, ref: 'ComboOffer' },
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

export default peopleConn.model('PurchaseRequest', purchaseRequestSchema);
