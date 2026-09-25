import express from 'express';
import multer from 'multer';
import { uploadQuestionPaper, getAllQuestions } from '../controllers/questionController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/adminMiddleware.js';

// Setup multer memory storage (stores file in memory buffer instead of writing to disk)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit
});

const router = express.Router();

// Runs a paid Gemini extraction, so it is admin-only (auth runs before the file is read).
router.post('/upload', authenticateToken, requireAdmin, upload.single('file'), uploadQuestionPaper);
router.get('/list', getAllQuestions);

export default router;
