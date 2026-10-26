import express from 'express';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import {
  listItems,
  listBookmarkKeys,
  toggleBookmark,
  createNote,
  updateNote,
  deleteItem,
  markRevised,
  restoreItem,
  emptyBin,
  listNotebooks,
  createNotebook,
  renameNotebook,
  deleteNotebook,
  getSeen,
  setSeen,
  importSeen,
} from '../controllers/studyController.js';

// /api/study — a student's own bookmarks, notes and Toppers Copy progress. All per-user.
const router = express.Router();
router.use(authenticateToken);

router.get('/items', listItems);
router.patch('/items/:id', updateNote);
router.delete('/items/:id', deleteItem);
router.post('/items/:id/revised', markRevised);
router.post('/items/:id/restore', restoreItem);
router.delete('/bin', emptyBin);

router.get('/notebooks', listNotebooks);
router.post('/notebooks', createNotebook);
router.patch('/notebooks/:id', renameNotebook);
router.delete('/notebooks/:id', deleteNotebook);

router.get('/bookmarks', listBookmarkKeys);
router.post('/bookmarks/toggle', toggleBookmark);

router.post('/notes', createNote);

router.get('/tc-seen', getSeen);
router.post('/tc-seen/import', importSeen);
router.put('/tc-seen/:questionId', setSeen);

export default router;
