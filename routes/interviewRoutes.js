import express from 'express';
import multer from 'multer';
import {
  getStatus,
  getProfile,
  saveProfile,
  deleteProfile,
  getPredictions,
  searchBank,
  getFacets,
  getTrends,
  getFamily,
  getTranscript,
  startSession,
  getSession,
  answerSession,
  endSession,
  pauseSessionNow,
  resumeSessionNow,
  listSessions,
  deleteSession,
  transcribe,
  speakTurn,
  voiceSample
} from '../controllers/interviewController.js';
import {
  getOverview,
  listTranscripts,
  getTranscriptAdmin,
  updateTranscript,
  updateQuestion,
  moveQuestion,
  mergeFamilies,
  updateFamily,
  findFamiliesAdmin
} from '../controllers/interviewAdminController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/adminMiddleware.js';

// Recorded answers stay in memory and are dropped when the request ends.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^audio\//.test(file.mimetype) || file.mimetype === 'video/webm')
});

// Until the section launches (INTERVIEW_SECTION_LIVE=true in the server's environment) only admins can use
// it. The frontend hides it from students as well; this check is what actually keeps them (and the
// Gemini calls behind these routes) out.
const sectionAccess = (req, res, next) => (process.env.INTERVIEW_SECTION_LIVE === 'true' ? next() : requireAdmin(req, res, next));

const router = express.Router();

router.get('/status', authenticateToken, sectionAccess, getStatus);

// The student's DAF
router.get('/profile', authenticateToken, sectionAccess, getProfile);
router.put('/profile', authenticateToken, sectionAccess, saveProfile);
router.delete('/profile', authenticateToken, sectionAccess, deleteProfile);
router.get('/predictions', authenticateToken, sectionAccess, getPredictions);

// Question bank (built from the community transcript compilations)
router.get('/bank/search', authenticateToken, sectionAccess, searchBank);
router.get('/bank/facets', authenticateToken, sectionAccess, getFacets);
router.get('/bank/trends', authenticateToken, sectionAccess, getTrends);
router.get('/bank/families/:id', authenticateToken, sectionAccess, getFamily);
router.get('/bank/transcripts/:id', authenticateToken, sectionAccess, getTranscript);

// Mock interviews
router.get('/sessions', authenticateToken, sectionAccess, listSessions);
router.post('/sessions', authenticateToken, sectionAccess, startSession);
router.get('/sessions/:id', authenticateToken, sectionAccess, getSession);
router.post('/sessions/:id/answer', authenticateToken, sectionAccess, answerSession);
router.post('/sessions/:id/end', authenticateToken, sectionAccess, endSession);
router.post('/sessions/:id/pause', authenticateToken, sectionAccess, pauseSessionNow);
router.post('/sessions/:id/resume', authenticateToken, sectionAccess, resumeSessionNow);
router.delete('/sessions/:id', authenticateToken, sectionAccess, deleteSession);
router.post('/transcribe', authenticateToken, sectionAccess, audioUpload.single('audio'), transcribe);
router.get('/sessions/:id/speech', authenticateToken, sectionAccess, speakTurn);
router.get('/voice-sample', authenticateToken, sectionAccess, voiceSample);

// Admin: corpus review
router.get('/admin/overview', authenticateToken, requireAdmin, getOverview);
router.get('/admin/transcripts', authenticateToken, requireAdmin, listTranscripts);
router.get('/admin/transcripts/:id', authenticateToken, requireAdmin, getTranscriptAdmin);
router.patch('/admin/transcripts/:id', authenticateToken, requireAdmin, updateTranscript);
router.patch('/admin/questions/:id', authenticateToken, requireAdmin, updateQuestion);
router.post('/admin/questions/:id/move', authenticateToken, requireAdmin, moveQuestion);
router.post('/admin/families/merge', authenticateToken, requireAdmin, mergeFamilies);
router.patch('/admin/families/:id', authenticateToken, requireAdmin, updateFamily);
router.get('/admin/families', authenticateToken, requireAdmin, findFamiliesAdmin);

export default router;
