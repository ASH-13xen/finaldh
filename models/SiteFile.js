import mongoose from 'mongoose';

// A single named file in object storage that isn't owned by any one document — e.g. the
// Economy Master File source PDF. `key` is our stable name, `storageKey` the r2://… pointer.

const siteFileSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  storageKey: { type: String, required: true },
  originalName: { type: String, default: '' },
  pageCount: { type: Number, default: 0 },
  size: { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.model('SiteFile', siteFileSchema);
