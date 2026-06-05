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
  downloadSecuredCoursePdf
} from '../controllers/courseController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const uploadDir = 'uploads/courses';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage configuration for saving to disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

const router = express.Router();

router.post('/upload', upload.single('file'), uploadCourse);
router.put('/:id', upload.single('file'), updateCourse);
router.delete('/:id', deleteCourse);
router.get('/list', listCourses);
router.post('/checkout', authenticateToken, checkoutCart);
router.get('/purchased', authenticateToken, getPurchasedCourses);
router.post('/analyze-page', authenticateToken, analyzeCoursePage);

// Secure watermark & barcode download route
router.get('/download/:courseId', authenticateToken, downloadSecuredCoursePdf);

export default router;
