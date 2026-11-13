import express from 'express';
import { getGoogleConfig, verifyGoogleToken, mockLogin } from '../controllers/authController.js';

const router = express.Router();

// The developer sign-in (a shared "Developer User" account, no Google) is for local work only. Off on
// Render (which always sets RENDER) and whenever NODE_ENV is production; there it answers 404 like any
// unknown route. Read per request so a test or a local run can switch it.
export const mockLoginAllowed = () => process.env.NODE_ENV !== 'production' && !process.env.RENDER;

router.get('/config', getGoogleConfig);
router.post('/google', verifyGoogleToken);
router.post('/mock', (req, res, next) => (mockLoginAllowed() ? mockLogin(req, res, next) : res.status(404).json({ error: 'Not found' })));

export default router;
