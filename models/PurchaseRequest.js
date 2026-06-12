import mongoose from 'mongoose';

const purchaseRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  courseObjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  courseId: { type: String, required: true },
  courseName: { type: String, required: true },
  price: { type: Number, required: true },
  screenshotUrl: { type: String, required: true },
  upiTxnId: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  telegramNotificationCount: { type: Number, default: 0 }
}, { timestamps: true });

export default mongoose.model('PurchaseRequest', purchaseRequestSchema);
