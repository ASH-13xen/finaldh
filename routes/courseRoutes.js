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

export default router;
