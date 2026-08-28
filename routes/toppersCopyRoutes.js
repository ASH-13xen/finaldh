import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import {
  startCompendiumJob,
  commitCompendiumJob,
  startPyqJob,
  commitPyqJob,
  getJobStatus,
  updateToppersCopy,
  deleteToppersCopy,
  analyzeQuestion,
  listToppersPyqs,
  updateToppersPyq,
  deleteToppersPyq,
  listSubjects,
  listTopics,
  getToppersCopy,
  streamToppersCopyPdf,
} from '../controllers/toppersCopyController.js';

// Ingestion PDFs can be large scans — write them to a temp dir on disk, not memory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => {
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `tc-${suffix}-${file.originalname.replace(/\s+/g, '_')}`);
  },
});
const uploadPdf = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } }); // 300MB

const router = express.Router();

// -------- Admin: AI ingestion + review/commit --------
router.post('/admin/compendium/start', authenticateToken, uploadPdf.single('pdf'), startCompendiumJob);
router.post('/admin/compendium/:jobId/commit', authenticateToken, commitCompendiumJob);
router.post('/admin/pyq/start', authenticateToken, uploadPdf.single('pdf'), startPyqJob);
router.post('/admin/pyq/:jobId/commit', authenticateToken, commitPyqJob);
router.get('/admin/jobs/:jobId', authenticateToken, getJobStatus);

// -------- Admin: committed PYQ browse / edit / delete --------
router.get('/admin/pyqs', authenticateToken, listToppersPyqs);
router.patch('/admin/pyqs/:id', authenticateToken, updateToppersPyq);
router.delete('/admin/pyqs/:id', authenticateToken, deleteToppersPyq);

// -------- Admin: direct CRUD + analysis --------
router.patch('/admin/:id', authenticateToken, updateToppersCopy);
router.delete('/admin/:id', authenticateToken, deleteToppersCopy);
router.post('/admin/:id/questions/:qid/analyze', authenticateToken, analyzeQuestion);

// -------- Student / admin: read + stream --------
router.get('/subjects', authenticateToken, listSubjects);
router.get('/topics', authenticateToken, listTopics);
router.get('/:id', authenticateToken, getToppersCopy);
router.get('/:id/pdf', authenticateToken, streamToppersCopyPdf);

export default router;
