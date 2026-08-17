import mongoose from 'mongoose';

const sortedPyqSchema = new mongoose.Schema({
  year: { type: Number, required: true },
  questionText: { type: String, required: true },
  suggestedTag: { type: String, default: null }
}, { _id: false });

// Background job for the Progress Section Builder's "paste PYQs" step - mirrors
// PyqExtractionJob.js but the source is admin-pasted text blocks instead of a PDF.
// PYQs are auto-committed to ProgressPyq by the background worker (no separate review/
// bulk-create step); this document is left behind purely as a processing/result summary,
// same 24h TTL as the PDF-based extraction jobs.
const progressPyqSortJobSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'sorting', 'done', 'error'],
    default: 'pending'
  },
  textBlocks: { type: [String], default: [] },
  totalChunks: { type: Number, default: 0 },
  chunksCompleted: { type: Number, default: 0 },
  chunksFailed: { type: Number, default: 0 },
  failedChunkRanges: { type: [String], default: [] },
  currentChunkRange: { type: String, default: '' },
  topicNames: { type: [String], default: [] }, // fixed classification vocabulary, snapshot at job start
  sortedPyqs: { type: [sortedPyqSchema], default: [] }, // result summary of what was actually inserted
  insertedCount: { type: Number, default: 0 },
  skippedCount: { type: Number, default: 0 },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
}, { timestamps: true });

progressPyqSortJobSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model('ProgressPyqSortJob', progressPyqSortJobSchema);
