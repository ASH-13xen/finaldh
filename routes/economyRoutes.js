import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import {
  listThemes,
  getTheme,
  getThemePyqs,
  getTopic,
  searchTopics,
  revisionQueue,
  setProgress,
  getSourcePage,
  adminStatus,
  adminListTopics,
  adminUpdateTopic,
  adminAiExtras,
  adminUpdateTheme,
  adminImport,
  adminUploadSourcePdf,
} from '../controllers/economyController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => cb(null, `em-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// /api/economy — Economy Master File. See controllers/economyController.js for the contract.
const router = express.Router();
router.use(authenticateToken);

router.get('/themes', listThemes);
router.get('/themes/:key', getTheme);
router.get('/themes/:key/pyqs', getThemePyqs);
router.get('/topics/:id', getTopic);
router.get('/search', searchTopics);
router.get('/revision', revisionQueue);
router.put('/progress/:topicId', setProgress);
router.get('/source-page/:page', getSourcePage);

router.get('/admin/status', adminStatus);
router.get('/admin/topics', adminListTopics);
router.patch('/admin/topics/:id', adminUpdateTopic);
router.post('/admin/topics/:id/ai-extras', adminAiExtras);
router.patch('/admin/themes/:key', adminUpdateTheme);
router.post('/admin/import', upload.single('file'), adminImport);
router.post('/admin/source-pdf', upload.single('file'), adminUploadSourcePdf);

export default router;
