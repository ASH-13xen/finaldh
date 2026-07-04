import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 259200 } // Auto-delete after 72 hours
});

export default mongoose.model('Message', messageSchema);
