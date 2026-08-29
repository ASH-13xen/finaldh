import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import { listPublishedBanks } from '../controllers/questionBankController.js';
import {
  listBanks,
  createBank,
  updateBank,
  deleteBank,
  importQuestions,
  listQuestions,
  updateQuestion,
  deleteQuestion,
  listTopics,
  renameTopic
} from '../controllers/questionBankAdminController.js';

const router = express.Router();

// PYQ dumps run to a few MB — allow a generous cap for both the file upload and a raw JSON body.
const uploadJson = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const jsonBody = express.json({ limit: '25mb' });

router.use(authenticateToken);

// Student
router.get('/', listPublishedBanks);

// Admin
router.get('/admin/banks', listBanks);
router.post('/admin/banks', createBank);
router.patch('/admin/banks/:id', updateBank);
router.delete('/admin/banks/:id', deleteBank);
router.post('/admin/banks/:id/import', uploadJson.single('file'), jsonBody, importQuestions);

router.get('/admin/questions', listQuestions);
router.patch('/admin/questions/:id', updateQuestion);
router.delete('/admin/questions/:id', deleteQuestion);

router.get('/admin/topics', listTopics);
router.post('/admin/topics/rename', renameTopic);

export default router;
