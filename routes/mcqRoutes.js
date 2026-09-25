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
  getAttemptHistory,
  getOverview,
  revealAnswer,
  updateAttemptSettings,
  startFlaggedPractice,
  startMistakesPractice,
  getAttemptQuotaAdmin,
  updateAttemptQuotaAdmin
} from '../controllers/mcqController.js';
import { flagQuestion, unflagQuestion, listFlags } from '../controllers/mcqFlagController.js';
import {
  submitReport,
  myReports,
  listReportsAdmin,
  reportsCountAdmin,
  resolveReport,
  rejectAllForQuestion
} from '../controllers/mcqReportController.js';
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

// Admin: reported questions (grouped per question) + one-click resolution
router.get('/admin/reports/count', authenticateToken, reportsCountAdmin);
router.get('/admin/reports', authenticateToken, listReportsAdmin);
router.post('/admin/reports/:reportId/resolve', authenticateToken, resolveReport);
router.post('/admin/questions/:questionId/reports/reject-all', authenticateToken, rejectAllForQuestion);

// Admin: per-student attempt allowance (support tool)
router.get('/admin/quota', authenticateToken, getAttemptQuotaAdmin);
router.post('/admin/quota', authenticateToken, updateAttemptQuotaAdmin);

// Student
router.get('/subjects', authenticateToken, getSubjects);
router.get('/overview', authenticateToken, getOverview);
router.get('/tests', authenticateToken, getTests);
router.post('/tests/:testId/start', authenticateToken, startTest);
router.post('/practice/flagged', authenticateToken, startFlaggedPractice);
router.post('/practice/mistakes', authenticateToken, startMistakesPractice);
router.get('/attempts/history', authenticateToken, getAttemptHistory);
router.get('/attempts/:attemptId', authenticateToken, getAttempt);
router.patch('/attempts/:attemptId/responses/:order', authenticateToken, saveResponse);
router.post('/attempts/:attemptId/responses/:order/reveal', authenticateToken, revealAnswer);
router.patch('/attempts/:attemptId/settings', authenticateToken, updateAttemptSettings);
router.post('/attempts/:attemptId/submit', authenticateToken, submitAttempt);
router.get('/attempts/:attemptId/result', authenticateToken, getAttemptResult);

// Flagged questions (a student's personal bookmarks) and question reports
router.get('/flags', authenticateToken, listFlags);
router.put('/flags/:questionId', authenticateToken, flagQuestion);
router.delete('/flags/:questionId', authenticateToken, unflagQuestion);
router.post('/questions/:questionId/report', authenticateToken, submitReport);
router.get('/reports/mine', authenticateToken, myReports);

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
