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
  getTopicPyqs,
  checkPyq,
  searchTopics,
  revisionQueue,
  setProgress,
  getSourcePage,
  adminStatus,
  adminListTopics,
  adminUpdateTopic,
  adminAiExtras,
  adminThemeAiExtras,
  adminStopThemeAiExtras,
  adminPublishThemeExtras,
  adminAiExtrasJobs,
  adminUpdateTheme,
  adminImport,
  adminUploadSourcePdf,
  adminListPyqs,
  adminPlacePyq,
  adminStartPyqTagging,
  adminStopPyqTagging,
  adminPyqTaggingStatus,
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
router.get('/topics/:id/pyqs', getTopicPyqs);
router.post('/pyqs/:id/check', checkPyq);
router.get('/search', searchTopics);
router.get('/revision', revisionQueue);
router.put('/progress/:topicId', setProgress);
router.get('/source-page/:page', getSourcePage);

router.get('/admin/status', adminStatus);
router.get('/admin/topics', adminListTopics);
router.patch('/admin/topics/:id', adminUpdateTopic);
router.post('/admin/topics/:id/ai-extras', adminAiExtras);
router.patch('/admin/themes/:key', adminUpdateTheme);
router.post('/admin/themes/:key/ai-extras', adminThemeAiExtras);
router.post('/admin/themes/:key/ai-extras/stop', adminStopThemeAiExtras);
router.post('/admin/themes/:key/publish-extras', adminPublishThemeExtras);
router.get('/admin/ai-extras-jobs', adminAiExtrasJobs);
router.post('/admin/import', upload.single('file'), adminImport);
router.post('/admin/source-pdf', upload.single('file'), adminUploadSourcePdf);
router.get('/admin/pyqs', adminListPyqs);
router.patch('/admin/pyqs/:id', adminPlacePyq);
router.post('/admin/pyq-tagging', adminStartPyqTagging);
router.post('/admin/pyq-tagging/stop', adminStopPyqTagging);
router.get('/admin/pyq-tagging', adminPyqTaggingStatus);

export default router;
