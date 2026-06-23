import mongoose from 'mongoose';

const extractedQuestionSchema = new mongoose.Schema({
  pageNumber: { type: Number, required: true },
  questionText: { type: String, required: true },
  suggestedTopicName: { type: String, default: null }
}, { _id: false });

const extractedTopicRangeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  startPage: { type: Number, required: true },
  endPage: { type: Number, required: true }
}, { _id: false });

const extractionJobSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  fileIndex: { type: Number, required: true, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'extracting_index', 'extracting_questions', 'done', 'error'],
    default: 'pending'
  },
  totalPages: { type: Number, default: 0 },
  totalChunks: { type: Number, default: 0 },
  chunksCompleted: { type: Number, default: 0 },
  chunksFailed: { type: Number, default: 0 },
  failedChunkRanges: { type: [String], default: [] },
  currentChunkRange: { type: String, default: '' },
  extractedTopicsFromIndex: { type: [extractedTopicRangeSchema], default: [] },
  extractedQuestions: { type: [extractedQuestionSchema], default: [] },
  sourceFilePath: { type: String, default: '' },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
}, { timestamps: true });

extractionJobSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model('ExtractionJob', extractionJobSchema);
