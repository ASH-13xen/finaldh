import express from 'express';
import multer from 'multer';
import {
  createTest,
  uploadQuestionsCsv,
  listTestsAdmin,
  updateTest,
  deleteTest,
  listQuestionsAdmin,
  getSubjects,
  getTests,
  startTest,
  getAttempt,
  saveResponse,
  submitAttempt,
  getAttemptResult,
  getAttemptHistory
} from '../controllers/mcqController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

// CSVs are small text files - memory storage, same pattern as pdfPyqRoutes.js
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const router = express.Router();

// Admin
router.post('/admin/tests', authenticateToken, createTest);
router.post('/admin/tests/:testId/questions/upload-csv', authenticateToken, upload.single('file'), uploadQuestionsCsv);
router.get('/admin/tests', authenticateToken, listTestsAdmin);
router.patch('/admin/tests/:testId', authenticateToken, updateTest);
router.delete('/admin/tests/:testId', authenticateToken, deleteTest);
router.get('/admin/tests/:testId/questions', authenticateToken, listQuestionsAdmin);

// Student
router.get('/subjects', authenticateToken, getSubjects);
router.get('/tests', authenticateToken, getTests);
router.post('/tests/:testId/start', authenticateToken, startTest);
router.get('/attempts/history', authenticateToken, getAttemptHistory);
router.get('/attempts/:attemptId', authenticateToken, getAttempt);
router.patch('/attempts/:attemptId/responses/:order', authenticateToken, saveResponse);
router.post('/attempts/:attemptId/submit', authenticateToken, submitAttempt);
router.get('/attempts/:attemptId/result', authenticateToken, getAttemptResult);

export default router;
