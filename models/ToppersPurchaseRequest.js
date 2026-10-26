import mongoose from 'mongoose';

// Manual UPI-screenshot-plus-admin-approval purchase of Toppers Copy access, mirroring
// McqPurchaseRequest.js. plan is a subject, or ALL_SUBJECTS (ToppersCopyPricing.js) for
// the bundle.
const toppersPurchaseRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  plan: { type: String, required: true },
  price: { type: Number, required: true },
  screenshotUrl: { type: String, required: true },
  screenshotData: { type: Buffer },
  screenshotContentType: { type: String },
  upiTxnId: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  telegramNotificationCount: { type: Number, default: 0 },
  highlight: { type: String, enum: ['none', 'red', 'yellow'], default: 'none' }
}, { timestamps: true });

export default mongoose.model('ToppersPurchaseRequest', toppersPurchaseRequestSchema);
