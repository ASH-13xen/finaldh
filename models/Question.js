import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  subject: { type: String, required: true },
  year: { type: Number, required: true },
  tags: {
    subject: { type: String },
    section: { type: String },
    title: { type: String }
  }
}, { timestamps: true });

export default mongoose.model('Question', questionSchema);
