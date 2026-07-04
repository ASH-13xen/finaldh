import express from 'express';
import {
  sendMessage,
  getInbox,
  markMessageRead,
  deleteMessage
} from '../controllers/messageController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Admin: compose + send/broadcast
router.post('/send', authenticateToken, sendMessage);

// Any logged-in user: their own inbox
router.get('/inbox', authenticateToken, getInbox);
router.patch('/:id/read', authenticateToken, markMessageRead);
router.delete('/:id', authenticateToken, deleteMessage);

export default router;
