import express from 'express';
import multer from 'multer';
import {
  createTest,
  uploadQuestionsCsv,
  listTestsAdmin,
  updateTest,
  deleteTest,
  listQuestionsAdmin,
  createQuestion,
  updateQuestion,
  deleteQuestionById,
  getSubjects,
  getTests,
  startTest,
  getAttempt,
  saveResponse,
  submitAttempt,
  getAttemptResult,
  getAttemptHistory
} from '../controllers/mcqController.js';
import {
  createMcqPurchaseRequest,
  getStudentMcqPurchaseRequests,
  getAdminMcqPurchaseRequests,
  approveMcqPurchaseRequest,
  rejectMcqPurchaseRequest,
  trackMcqTelegramNotification,
  highlightMcqPurchaseRequest,
  getMcqPurchaseRequestScreenshot,
  getSubjectPricingAdmin,
  upsertSubjectPricing
} from '../controllers/mcqPurchaseController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

// CSVs are small text files - memory storage, same pattern as pdfPyqRoutes.js
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Payment screenshots stored directly in MongoDB, same pattern as courseRoutes.js.
const uploadScreenshot = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const router = express.Router();

// Admin
router.post('/admin/tests', authenticateToken, createTest);
router.post('/admin/tests/:testId/questions/upload-csv', authenticateToken, upload.single('file'), uploadQuestionsCsv);
router.get('/admin/tests', authenticateToken, listTestsAdmin);
router.patch('/admin/tests/:testId', authenticateToken, updateTest);
router.delete('/admin/tests/:testId', authenticateToken, deleteTest);
router.get('/admin/tests/:testId/questions', authenticateToken, listQuestionsAdmin);
router.post('/admin/tests/:testId/questions', authenticateToken, createQuestion);
router.patch('/admin/tests/:testId/questions/:questionId', authenticateToken, updateQuestion);
router.delete('/admin/tests/:testId/questions/:questionId', authenticateToken, deleteQuestionById);

// Student
router.get('/subjects', authenticateToken, getSubjects);
router.get('/tests', authenticateToken, getTests);
router.post('/tests/:testId/start', authenticateToken, startTest);
router.get('/attempts/history', authenticateToken, getAttemptHistory);
router.get('/attempts/:attemptId', authenticateToken, getAttempt);
router.patch('/attempts/:attemptId/responses/:order', authenticateToken, saveResponse);
router.post('/attempts/:attemptId/submit', authenticateToken, submitAttempt);
router.get('/attempts/:attemptId/result', authenticateToken, getAttemptResult);

// UPI MCQ test purchase endpoints (mirrors courseRoutes.js's purchase-request flow)
router.post('/purchase-requests', authenticateToken, uploadScreenshot.single('screenshot'), createMcqPurchaseRequest);
router.get('/purchase-requests', authenticateToken, getStudentMcqPurchaseRequests);
router.get('/purchase-requests/:id/screenshot', authenticateToken, getMcqPurchaseRequestScreenshot);
router.post('/purchase-requests/:id/notify-telegram', authenticateToken, trackMcqTelegramNotification);
router.get('/admin/purchase-requests', authenticateToken, getAdminMcqPurchaseRequests);
router.post('/admin/purchase-requests/:id/approve', authenticateToken, approveMcqPurchaseRequest);
router.post('/admin/purchase-requests/:id/reject', authenticateToken, rejectMcqPurchaseRequest);
router.put('/admin/purchase-requests/:id/highlight', authenticateToken, highlightMcqPurchaseRequest);

// Subject bundle pricing (Admin)
router.get('/admin/subject-pricing', authenticateToken, getSubjectPricingAdmin);
router.put('/admin/subject-pricing/:subject', authenticateToken, upsertSubjectPricing);

export default router;
