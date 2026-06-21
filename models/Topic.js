import mongoose from 'mongoose';

const topicSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  name: { type: String, required: true, trim: true },
  order: { type: Number, required: true }
}, { timestamps: true });

topicSchema.index({ course: 1, fileIndex: 1, order: 1 });
topicSchema.index({ course: 1, fileIndex: 1, name: 1 });

export default mongoose.model('Topic', topicSchema);
