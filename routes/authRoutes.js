import express from 'express';
import { getGoogleConfig, verifyGoogleToken, mockLogin, logout, getSession } from '../controllers/authController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/config', getGoogleConfig);
router.post('/google', verifyGoogleToken);
router.post('/mock', mockLogin);
router.post('/logout', authenticateToken, logout);
router.get('/session', authenticateToken, getSession);

export default router;
