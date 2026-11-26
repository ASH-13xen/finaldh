import express from 'express';
import multer from 'multer';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import {
  overview, sectionQuestions, answer, resetAttempts,
  adminSets, adminCreateSet, adminUploadFiles, adminUpdateSet, adminDeleteSet,
  adminQuestions, adminUpdateQuestion,
  adminRunPractice, adminStopPractice, adminApproveAll,
  adminGenerateOne, adminAddPractice, adminUpdatePractice, adminDeletePractice,
} from '../controllers/tdhController.js';

// /api/tdh — PYQ & TDH Research. See controllers/tdhController.js for the contract.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.fieldname === 'solutions' ? /\.docx$/i.test(file.originalname) : /\.(docx|json)$/i.test(file.originalname);
    cb(ok ? null : new Error(file.fieldname === 'solutions' ? 'Solutions must be a Word (.docx) file' : 'Questions must be a Word (.docx) or JSON file'), ok);
  },
}).fields([{ name: 'questions', maxCount: 1 }, { name: 'solutions', maxCount: 1 }]);

const withUpload = (req, res, next) => upload(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));

const router = express.Router();
router.use(authenticateToken);

router.get('/', overview);
router.get('/sets/:id/sections/:num', sectionQuestions);
router.post('/questions/:id/answer', answer);
router.delete('/sets/:id/attempts', resetAttempts);

router.get('/admin/sets', adminSets);
router.post('/admin/sets', withUpload, adminCreateSet);
router.post('/admin/sets/:id/files', withUpload, adminUploadFiles);
router.patch('/admin/sets/:id', adminUpdateSet);
router.delete('/admin/sets/:id', adminDeleteSet);
router.get('/admin/sets/:id/questions', adminQuestions);
router.patch('/admin/questions/:id', adminUpdateQuestion);
router.post('/admin/sets/:id/practice/run', adminRunPractice);
router.post('/admin/sets/:id/practice/stop', adminStopPractice);
router.post('/admin/sets/:id/practice/approve', adminApproveAll);
router.post('/admin/questions/:id/practice/generate', adminGenerateOne);
router.post('/admin/questions/:id/practice', adminAddPractice);
router.patch('/admin/questions/:id/practice/:pid', adminUpdatePractice);
router.delete('/admin/questions/:id/practice/:pid', adminDeletePractice);

export default router;
