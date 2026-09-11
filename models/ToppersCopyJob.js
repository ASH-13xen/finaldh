import mongoose from 'mongoose';

// Background job for AI-driven ingestion in the Toppers-Copy section. Mirrors the
// existing PyqExtractionJob / ExtractionJob pattern: chunked AI passes, per-chunk
// progress, 24h TTL, results parked here for an admin review pass before they get
// committed into real ToppersCopy / ToppersPyq documents.
//
// `kind` picks the flow:
//   'compendium' — a scanned toppers-copy PDF for ONE syllabus SECTION that holds
//                  SEVERAL topics. Each topic starts on a divider page (series
//                  title + a highlighted topic name); within a topic it's
//                  question -> its toppers' answers -> next question. AI (vision)
//                  detects topic dividers + question/answer boundaries
//                  -> detectedTopics[].questions[].answers[].
//   'pyq'        — a cross-subject PYQ compilation PDF. AI extracts question rows
//                  -> extractedPyqs[].

const detectedAnswerSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  rank: { type: Number, default: null },
  year: { type: Number, default: null },
  marks: { type: String, default: '' },
  source: { type: String, default: '' },
  startPage: { type: Number, required: true },
  endPage: { type: Number, required: true }
}, { _id: false });

const detectedQuestionSchema = new mongoose.Schema({
  questionText: { type: String, default: '' },
  year: { type: Number, default: null },
  marks: { type: Number, default: null },
  startPage: { type: Number, required: true },
  endPage: { type: Number, required: true },
  answers: { type: [detectedAnswerSchema], default: [] }
}, { _id: false });

const detectedTopicSchema = new mongoose.Schema({
  topic: { type: String, default: '' },
  startPage: { type: Number, required: true },
  endPage: { type: Number, required: true },
  questions: { type: [detectedQuestionSchema], default: [] }
}, { _id: false });

const extractedPyqSchema = new mongoose.Schema({
  subject: { type: String, default: '' },
  section: { type: String, default: '' },
  topic: { type: String, default: '' },
  microtheme: { type: String, default: '' },
  questionText: { type: String, required: true },
  year: { type: Number, required: true },
  marks: { type: Number, default: null },
  // Set only by a JSON-source ingest (a source book that already prints a model
  // answer) — carried through review so commit can attach it as
  // ToppersPyq.pyqAnswer.source='pdf' instead of leaving the question answerless.
  answerText: { type: String, default: '' },
  diagramPages: { type: [Number], default: [] },
}, { _id: false });

const toppersCopyJobSchema = new mongoose.Schema({
  kind: { type: String, enum: ['compendium', 'pyq'], required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'uploading', 'extracting', 'done', 'error'],
    default: 'pending'
  },
  aiModelLabel: { type: String, default: '' }, // provider/model snapshot at job start

  // --- 'compendium' inputs (admin-supplied, editable during review) ---
  subject: { type: String, default: '' },
  syllabusSection: { type: String, default: '' },
  startingTopic: { type: String, default: '' },  // topic for pages before the first divider (mid-topic chunk / no dividers)

  originalFileName: { type: String, default: '' },
  sourceFilePath: { type: String, default: '' }, // local temp path, unlinked when the job ends
  pdfKey: { type: String, default: '' },         // 'r2://<key>' once uploaded (compendium only)
  fromPage: { type: Number, default: 1 },        // compendium: first page to process (resume after a rate limit)

  // --- progress ---
  totalPages: { type: Number, default: 0 },
  totalChunks: { type: Number, default: 0 },
  chunksCompleted: { type: Number, default: 0 },
  chunksFailed: { type: Number, default: 0 },
  failedChunkRanges: { type: [String], default: [] },
  currentChunkRange: { type: String, default: '' },

  // --- results ---
  detectedSubject: { type: String, default: '' },       // compendium: what the AI read off the title page
  detectedTopics: { type: [detectedTopicSchema], default: [] },
  extractedPyqs: { type: [extractedPyqSchema], default: [] },

  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
}, { timestamps: true });

toppersCopyJobSchema.index({ createdBy: 1, createdAt: -1 });

export default mongoose.model('ToppersCopyJob', toppersCopyJobSchema);
