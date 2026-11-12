import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import {
  correctPlacement, deleteSyllabus, getPlacement, listSyllabi, runPlacement, stopPlacement, uploadSyllabus,
} from '../controllers/syllabusController.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(/\.docx$/i.test(file.originalname) ? null : new Error('Only Word (.docx) files'), true),
});

const router = express.Router();

router.get('/admin', authenticateToken, listSyllabi);
router.post('/admin', authenticateToken, upload.single('file'), uploadSyllabus);
router.get('/admin/placement', authenticateToken, getPlacement);
router.post('/admin/placement/run', authenticateToken, runPlacement);
router.post('/admin/placement/stop', authenticateToken, stopPlacement);
router.patch('/admin/placement/:kind/:id', authenticateToken, correctPlacement);
router.delete('/admin/:subject', authenticateToken, deleteSyllabus);

export default router;
