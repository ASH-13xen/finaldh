import mongoose from 'mongoose';

const extractedPyqSchema = new mongoose.Schema({
  pageNumber: { type: Number, required: true },
  year: { type: Number, required: true },
  questionText: { type: String, required: true },
  suggestedTag: { type: String, default: null }
}, { _id: false });

const pyqExtractionJobSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'extracting_pyqs', 'done', 'error'],
    default: 'pending'
  },
  totalPages: { type: Number, default: 0 },
  totalChunks: { type: Number, default: 0 },
  chunksCompleted: { type: Number, default: 0 },
  chunksFailed: { type: Number, default: 0 },
  failedChunkRanges: { type: [String], default: [] },
  currentChunkRange: { type: String, default: '' },
  topicNames: { type: [String], default: [] }, // fixed vocabulary fetched from DB before the job starts
  extractedPyqs: { type: [extractedPyqSchema], default: [] },
  sourceFilePath: { type: String, default: '' },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
}, { timestamps: true });

pyqExtractionJobSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model('PyqExtractionJob', pyqExtractionJobSchema);
