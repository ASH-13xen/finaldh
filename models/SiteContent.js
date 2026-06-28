import mongoose from 'mongoose';

const siteContentSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, default: '' }
}, { timestamps: true });

export default mongoose.model('SiteContent', siteContentSchema);
