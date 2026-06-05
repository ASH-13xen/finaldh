import express from 'express';
import multer from 'multer';
import { uploadQuestionPaper, getAllQuestions } from '../controllers/questionController.js';

// Setup multer memory storage (stores file in memory buffer instead of writing to disk)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit
});

const router = express.Router();

router.post('/upload', upload.single('file'), uploadQuestionPaper);
router.get('/list', getAllQuestions);

export default router;
