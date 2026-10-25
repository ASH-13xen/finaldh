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
  serveEditedPDF,
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

// Every route requires a login. `init` used to be open to the whole internet: it accepted 2GB uploads
// and could copy any course's raw PDF into a publicly served folder. Ownership of the requested course
// is now checked inside initPDFEdit.
router.post('/init', authenticateToken, upload.single('file'), initPDFEdit);
router.post('/detect-prefix', authenticateToken, detectPrefix);
router.post('/apply-whiteout', authenticateToken, applyWhiteout);
router.post('/auto-clean', authenticateToken, autoCleanPDF);
router.post('/clean-pages', authenticateToken, cleanPagesPDF);
// Edited files are served only through these authenticated routes (the browser <a href> and pdf.js
// pass ?token= / a header); /uploads/user_edits is no longer served statically.
router.get('/file/:editId', authenticateToken, serveEditedPDF);
router.get('/download/:editId', authenticateToken, downloadPDF);

export default router;
