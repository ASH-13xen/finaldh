import express from 'express';
import multer from 'multer';
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
  togglePyqProgress
} from '../controllers/progressController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
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

// Student (and admin, via the same purchase-or-admin gate)
router.get('/topics', authenticateToken, listTopicsWithQuestions);
router.patch('/questions/:questionId/toggle', authenticateToken, toggleQuestionProgress);
router.get('/file-pyqs', authenticateToken, listFilePyqs);
router.patch('/pyqs/:pyqId/toggle', authenticateToken, togglePyqProgress);

export default router;
