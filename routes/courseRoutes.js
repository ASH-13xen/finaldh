import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  uploadCourse,
  updateCourse,
  deleteCourse,
  listCourses,
  getPurchasedCourses,
  analyzeCoursePage,
  downloadSecuredCoursePdf,
  getRawCoursePdf,
  getDownloadProgress,
  githubCallback,
  uploadCourseSample,
  removeCourseSample,
  getCourseSamplePdf,
  getSiteContent,
  updateSiteContent,
  listDownloadLogs
} from '../controllers/courseController.js';
import {
  createPurchaseRequest,
  getStudentPurchaseRequests,
  getAdminPurchaseRequests,
  approvePurchaseRequest,
  rejectPurchaseRequest,
  trackTelegramNotification,
  highlightPurchaseRequest,
  getPurchaseRequestScreenshot
} from '../controllers/purchaseController.js';
import {
  listActiveComboOffers,
  listComboOffers,
  createComboOffer,
  updateComboOffer,
  deleteComboOffer
} from '../controllers/comboOfferController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/adminMiddleware.js';

const tempUploadDir = 'uploads/temp';
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Multer storage configuration for saving to temp folder on disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 750 * 1024 * 1024 } // 750MB limit to handle 500MB files safely
});

const router = express.Router();

// Admin-only. These three routes used to have no auth at all, so anyone on the internet could upload,
// overwrite or delete courses (and their files in R2). Auth runs BEFORE multer so unauthenticated
// callers cannot make the server buffer a 750MB upload.
router.post('/upload', authenticateToken, requireAdmin, upload.array('files', 50), uploadCourse);
router.put('/:id', authenticateToken, requireAdmin, upload.array('files', 50), updateCourse);
router.delete('/:id', authenticateToken, requireAdmin, deleteCourse);
router.get('/list', listCourses);
// (POST /checkout was removed: it was a leftover "mock payment" that let any student mark any course as purchased.)
router.get('/purchased', authenticateToken, getPurchasedCourses);
router.post('/analyze-page', authenticateToken, analyzeCoursePage);

// Raw unwatermarked course PDF preview route
router.get('/raw/:id', authenticateToken, getRawCoursePdf);

// Secure watermark & barcode download route
router.get('/download/:courseId', authenticateToken, downloadSecuredCoursePdf);

// Real-time download progress endpoint
router.get('/download-progress/:courseId', authenticateToken, getDownloadProgress);

// Admin: trace a leaked PDF back to whoever it was issued to (by License ID, email, user id...)
router.get('/admin/download-logs', authenticateToken, requireAdmin, listDownloadLogs);

// Course sample PDF endpoints
router.post('/:id/sample', authenticateToken, upload.single('sample'), uploadCourseSample);
router.delete('/:id/sample', authenticateToken, removeCourseSample);
router.get('/:id/sample', getCourseSamplePdf); // public — no auth, marketing teaser

// GitHub Actions callback webhook
router.post('/github-callback', githubCallback);

// Admin-editable site text snippets (e.g. the common "Optional Subjects" description
// shown on the Purchase Courses page) — public read, admin-only write
router.get('/site-content/:key', getSiteContent);
router.put('/site-content/:key', authenticateToken, updateSiteContent);

// Payment screenshots are stored directly in MongoDB (PurchaseRequest.screenshotData) rather than
// on local disk, since the local uploads/ directory doesn't persist across deploys/restarts on most
// hosts — that was causing "Image Unavailable" for older requests once the underlying file was gone.
const uploadScreenshot = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// UPI Course purchase endpoints
router.post('/purchase-request', authenticateToken, uploadScreenshot.single('screenshot'), createPurchaseRequest);
router.get('/purchase-requests', authenticateToken, getStudentPurchaseRequests);
router.get('/purchase-requests/:id/screenshot', authenticateToken, getPurchaseRequestScreenshot);
router.post('/purchase-requests/:id/notify-telegram', authenticateToken, trackTelegramNotification);
router.get('/admin/purchase-requests', authenticateToken, getAdminPurchaseRequests);
router.post('/admin/purchase-requests/:id/approve', authenticateToken, approvePurchaseRequest);
router.post('/admin/purchase-requests/:id/reject', authenticateToken, rejectPurchaseRequest);
router.put('/admin/purchase-requests/:id/highlight', authenticateToken, highlightPurchaseRequest);

// Combo offer endpoints
router.get('/combo-offers/active', listActiveComboOffers);
router.get('/combo-offers', authenticateToken, listComboOffers);
router.post('/combo-offers', authenticateToken, createComboOffer);
router.put('/combo-offers/:id', authenticateToken, updateComboOffer);
router.delete('/combo-offers/:id', authenticateToken, deleteComboOffer);

export default router;
