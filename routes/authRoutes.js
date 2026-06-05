import express from 'express';
import { getGoogleConfig, verifyGoogleToken, mockLogin } from '../controllers/authController.js';

const router = express.Router();

router.get('/config', getGoogleConfig);
router.post('/google', verifyGoogleToken);
router.post('/mock', mockLogin);

export default router;
