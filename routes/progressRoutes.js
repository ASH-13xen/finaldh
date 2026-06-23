import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  uploadTopicQuestionsCsv,
  renameTopic,
  moveTopic,
  deleteTopic,
  updateQuestion,
  moveQuestion,
  deleteQuestion,
  uploadProgressPyqsCsv,
  listProgressPyqsAdmin,
  deleteProgressPyq,
  listTopicsWithQuestions,
  toggleQuestionProgress,
  listFilePyqs,
  togglePyqProgress,
  listProgressEnabledCourses,
  listVisibleCourses
} from '../controllers/progressController.js';
import {
  startExtractionJob,
  getExtractionJobStatus,
  bulkCreateTopicQuestions,
  startPyqExtractionJob,
  getPyqExtractionJobStatus,
  bulkCreatePyqs
} from '../controllers/extractionController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Separate disk-storage multer for the (potentially large) extraction-source PDF upload.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extractionTempDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(extractionTempDir)) {
  fs.mkdirSync(extractionTempDir, { recursive: true });
}
const extractionStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, extractionTempDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `extract-${uniqueSuffix}-${file.originalname.replace(/\s+/g, '_')}`);
  }
});
const uploadExtractionPdf = multer({
  storage: extractionStorage,
  limits: { fileSize: 750 * 1024 * 1024 } // 750MB — matches courseRoutes.js's PDF limit
});

const router = express.Router();

// Admin: topic/question CSV upload (additive) + direct CRUD/reorder
router.post('/admin/topic-questions/upload-csv', authenticateToken, upload.single('file'), uploadTopicQuestionsCsv);
router.patch('/admin/topics/:topicId/move', authenticateToken, moveTopic);
router.patch('/admin/topics/:topicId', authenticateToken, renameTopic);
router.delete('/admin/topics/:topicId', authenticateToken, deleteTopic);
router.patch('/admin/questions/:questionId/move', authenticateToken, moveQuestion);
router.patch('/admin/questions/:questionId', authenticateToken, updateQuestion);
router.delete('/admin/questions/:questionId', authenticateToken, deleteQuestion);

// Admin: PYQ CSV upload (replace-all-for-subject) + curation
router.post('/admin/pyqs/upload-csv', authenticateToken, upload.single('file'), uploadProgressPyqsCsv);
router.get('/admin/pyqs', authenticateToken, listProgressPyqsAdmin);
router.delete('/admin/pyqs/:id', authenticateToken, deleteProgressPyq);

// Admin: Gemini-powered PDF extraction (topic index + per-page question text) + commit
router.post('/admin/extract-questions/start', authenticateToken, uploadExtractionPdf.single('pdf'), startExtractionJob);
router.get('/admin/extract-questions/:jobId/status', authenticateToken, getExtractionJobStatus);
router.post('/admin/topic-questions/bulk-create', authenticateToken, bulkCreateTopicQuestions);

// Admin: course+file combos with progress data (for the PYQ-extraction course/file picker)
router.get('/admin/progress-enabled-courses', authenticateToken, listProgressEnabledCourses);

// Admin: Gemini-powered PYQ extraction (course+file scoped, no index pass) + commit
router.post('/admin/extract-pyqs/start', authenticateToken, uploadExtractionPdf.single('pdf'), startPyqExtractionJob);
router.get('/admin/extract-pyqs/:jobId/status', authenticateToken, getPyqExtractionJobStatus);
router.post('/admin/pyqs/bulk-create', authenticateToken, bulkCreatePyqs);

// Student (and admin, via the same purchase-or-admin gate)
router.get('/courses', authenticateToken, listVisibleCourses);
router.get('/topics', authenticateToken, listTopicsWithQuestions);
router.patch('/questions/:questionId/toggle', authenticateToken, toggleQuestionProgress);
router.get('/file-pyqs', authenticateToken, listFilePyqs);
router.patch('/pyqs/:pyqId/toggle', authenticateToken, togglePyqProgress);

export default router;
