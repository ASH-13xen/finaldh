import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { 
  uploadCourse, 
  updateCourse,
  deleteCourse,
  listCourses, 
  checkoutCart, 
  getPurchasedCourses,
  analyzeCoursePage,
  downloadSecuredCoursePdf,
  getRawCoursePdf,
  getDownloadProgress,
  githubCallback
} from '../controllers/courseController.js';
import {
  createPurchaseRequest,
  getStudentPurchaseRequests,
  getAdminPurchaseRequests,
  approvePurchaseRequest,
  rejectPurchaseRequest
} from '../controllers/purchaseController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

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

router.post('/upload', upload.array('files', 50), uploadCourse);
router.put('/:id', upload.array('files', 50), updateCourse);
router.delete('/:id', deleteCourse);
router.get('/list', listCourses);
router.post('/checkout', authenticateToken, checkoutCart);
router.get('/purchased', authenticateToken, getPurchasedCourses);
router.post('/analyze-page', authenticateToken, analyzeCoursePage);

// Raw unwatermarked course PDF preview route
router.get('/raw/:id', authenticateToken, getRawCoursePdf);

// Secure watermark & barcode download route
router.get('/download/:courseId', authenticateToken, downloadSecuredCoursePdf);

// Real-time download progress endpoint
router.get('/download-progress/:courseId', authenticateToken, getDownloadProgress);

// GitHub Actions callback webhook
router.post('/github-callback', githubCallback);

// Setup screenshots directory
const screenshotsDir = 'uploads/screenshots';
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Multer storage for payment screenshot uploads
const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, screenshotsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'ss-' + uniqueSuffix + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});

const uploadScreenshot = multer({
  storage: screenshotStorage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// UPI Course purchase endpoints
router.post('/purchase-request', authenticateToken, uploadScreenshot.single('screenshot'), createPurchaseRequest);
router.get('/purchase-requests', authenticateToken, getStudentPurchaseRequests);
router.get('/admin/purchase-requests', authenticateToken, getAdminPurchaseRequests);
router.post('/admin/purchase-requests/:id/approve', authenticateToken, approvePurchaseRequest);
router.post('/admin/purchase-requests/:id/reject', authenticateToken, rejectPurchaseRequest);

export default router;
