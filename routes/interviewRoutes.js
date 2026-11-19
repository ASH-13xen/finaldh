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
  getKeywords,
  getFamily,
  getApproach,
  getTranscript,
  extractProfile,
  getPrep,
  savePrepItem,
  deletePrepItem,
  savePrepSettings,
  analyzePractice,
  savePracticeAttempt,
  listPracticeAttempts,
  getCredits,
  draftAnswerHandler,
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
import {
  listNotes,
  getNote,
  getGuide,
  adminListNotes,
  adminGetNote,
  adminCreateNote,
  adminUpdateNote,
  adminDeleteNote,
  adminGetGuide,
  adminGenerateGuide,
  adminUpdateGuide
} from '../controllers/interviewNotesController.js';
import { getDafStatus, submitDaf, adminListDaf, adminGetDafFile, adminVerifyDaf, adminRejectDaf } from '../controllers/interviewDafController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import { mockInterviewEnabled } from '../lib/interview/features.js';
import { requireAdmin } from '../middlewares/adminMiddleware.js';

// An uploaded DAF stays in memory and is dropped when the request ends - it is read, never stored.
const dafUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif))$/.test(file.mimetype))
});

// Recorded answers stay in memory and are dropped when the request ends.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^audio\//.test(file.mimetype) || file.mimetype === 'video/webm')
});

// The section is open to every signed-in student (launched 2026-11-20). INTERVIEW_SECTION_LIVE=false in the
// server's environment closes it to everyone but admins again.
const sectionAccess = (req, res, next) => (process.env.INTERVIEW_SECTION_LIVE !== 'false' ? next() : requireAdmin(req, res, next));

// The mock interview room's routes answer 404 like unknown routes while it is switched off (see
// lib/interview/features.js), so no session - and no Gemini call behind one - can start.
const mockAccess = (req, res, next) => (mockInterviewEnabled() ? next() : res.status(404).json({ error: 'Not found' }));

const router = express.Router();

router.get('/status', authenticateToken, sectionAccess, getStatus);

// The student's DAF
router.get('/profile', authenticateToken, sectionAccess, getProfile);
router.put('/profile', authenticateToken, sectionAccess, saveProfile);
router.delete('/profile', authenticateToken, sectionAccess, deleteProfile);
router.post('/profile/extract', authenticateToken, sectionAccess, dafUpload.single('file'), extractProfile);
router.get('/predictions', authenticateToken, sectionAccess, getPredictions);

// Question bank (built from the community transcript compilations)
router.get('/bank/search', authenticateToken, sectionAccess, searchBank);
router.get('/bank/facets', authenticateToken, sectionAccess, getFacets);
router.get('/bank/trends', authenticateToken, sectionAccess, getTrends);
router.get('/bank/keywords', authenticateToken, sectionAccess, getKeywords);
router.get('/bank/families/:id', authenticateToken, sectionAccess, getFamily);
router.get('/bank/families/:id/approach', authenticateToken, sectionAccess, getApproach);
router.post('/bank/families/:id/approach', authenticateToken, sectionAccess, getApproach);

// The student's own preparation (statuses, saved questions, notes, interview date)
router.get('/prep', authenticateToken, sectionAccess, getPrep);
router.put('/prep/items/:key', authenticateToken, sectionAccess, savePrepItem);
router.delete('/prep/items/:key', authenticateToken, sectionAccess, deletePrepItem);
router.put('/prep/settings', authenticateToken, sectionAccess, savePrepSettings);

// Practice Studio (voice only): AI feedback on a recorded answer, and the student's attempts (numbers only)
router.post('/practice/analyze', authenticateToken, sectionAccess, audioUpload.single('audio'), analyzePractice);
router.post('/practice/attempts', authenticateToken, sectionAccess, savePracticeAttempt);
router.get('/practice/attempts', authenticateToken, sectionAccess, listPracticeAttempts);
// DAF verification: the student uploads their DAF; practice and AI unlock once an admin verifies it
router.get('/daf/status', authenticateToken, sectionAccess, getDafStatus);
router.post('/daf/submit', authenticateToken, sectionAccess, dafUpload.single('file'), submitDaf);

// AI credits (15 free, then packs bought through /api/payments) and answers drafted from the DAF
router.get('/credits', authenticateToken, sectionAccess, getCredits);
router.post('/answers/draft', authenticateToken, sectionAccess, draftAnswerHandler);

// Notes: published current-topic notes and the 100-question guide
router.get('/notes', authenticateToken, sectionAccess, listNotes);
router.get('/notes/:slug', authenticateToken, sectionAccess, getNote);
router.get('/guide', authenticateToken, sectionAccess, getGuide);

// Full transcripts are for admins only (the compilations are the community's; students see questions).
router.get('/bank/transcripts/:id', authenticateToken, requireAdmin, getTranscript);

// Mock interviews
router.get('/sessions', authenticateToken, sectionAccess, mockAccess, listSessions);
router.post('/sessions', authenticateToken, sectionAccess, mockAccess, startSession);
router.get('/sessions/:id', authenticateToken, sectionAccess, mockAccess, getSession);
router.post('/sessions/:id/answer', authenticateToken, sectionAccess, mockAccess, answerSession);
router.post('/sessions/:id/end', authenticateToken, sectionAccess, mockAccess, endSession);
router.post('/sessions/:id/pause', authenticateToken, sectionAccess, mockAccess, pauseSessionNow);
router.post('/sessions/:id/resume', authenticateToken, sectionAccess, mockAccess, resumeSessionNow);
router.delete('/sessions/:id', authenticateToken, sectionAccess, mockAccess, deleteSession);
router.post('/transcribe', authenticateToken, sectionAccess, audioUpload.single('audio'), transcribe);
router.get('/sessions/:id/speech', authenticateToken, sectionAccess, mockAccess, speakTurn);
router.get('/voice-sample', authenticateToken, sectionAccess, mockAccess, voiceSample);

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

// Admin: DAF verification
router.get('/admin/daf', authenticateToken, requireAdmin, adminListDaf);
router.get('/admin/daf/:id/file', authenticateToken, requireAdmin, adminGetDafFile);
router.post('/admin/daf/:id/verify', authenticateToken, requireAdmin, adminVerifyDaf);
router.post('/admin/daf/:id/reject', authenticateToken, requireAdmin, adminRejectDaf);

// Admin: notes (AI drafts from admin-chosen sources, review, publish) and the 100-question guide
router.get('/admin/notes', authenticateToken, requireAdmin, adminListNotes);
router.post('/admin/notes', authenticateToken, requireAdmin, adminCreateNote);
router.get('/admin/notes/:id', authenticateToken, requireAdmin, adminGetNote);
router.patch('/admin/notes/:id', authenticateToken, requireAdmin, adminUpdateNote);
router.delete('/admin/notes/:id', authenticateToken, requireAdmin, adminDeleteNote);
router.get('/admin/guide', authenticateToken, requireAdmin, adminGetGuide);
router.post('/admin/guide/generate', authenticateToken, requireAdmin, adminGenerateGuide);
router.patch('/admin/guide', authenticateToken, requireAdmin, adminUpdateGuide);

export default router;
