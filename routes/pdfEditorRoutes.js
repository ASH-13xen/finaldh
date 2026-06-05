import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  initPDFEdit, 
  detectPrefix, 
  applyWhiteout, 
  downloadPDF,
  autoCleanPDF,
  cleanPagesPDF
} from '../controllers/pdfEditorController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tempUploadDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Multer disk storage for temp file uploads
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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB limit (at least 1.5GB)
});

const router = express.Router();

router.post('/init', upload.single('file'), initPDFEdit);
router.post('/detect-prefix', authenticateToken, detectPrefix);
router.post('/apply-whiteout', authenticateToken, applyWhiteout);
router.post('/auto-clean', authenticateToken, autoCleanPDF);
router.post('/clean-pages', authenticateToken, cleanPagesPDF);
router.get('/download/:editId', downloadPDF);

export default router;
