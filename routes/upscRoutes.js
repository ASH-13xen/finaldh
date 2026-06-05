import express from 'express';
import { getUPSCQuestions, proxyPDF } from '../controllers/upscController.js';

const router = express.Router();

router.get('/list', getUPSCQuestions);
router.get('/proxy-pdf', proxyPDF);

export default router;
