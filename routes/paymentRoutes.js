import express from 'express';
import {
  createOrder,
  verifyPayment,
  getPaymentStatus,
  razorpayWebhook,
  listPaymentsAdmin
} from '../controllers/paymentController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/adminMiddleware.js';

const router = express.Router();

// Razorpay webhook. Its signature is computed over the raw request bytes, so this route reads the body
// with express.raw and the router must be mounted BEFORE the app-wide express.json() (see index.js) -
// a body that was already parsed and re-serialised would no longer match the signature.
router.post('/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), razorpayWebhook);

// Everything else is ordinary JSON from our own frontend
router.use(express.json());

router.post('/order', authenticateToken, createOrder);
router.post('/verify', authenticateToken, verifyPayment);
router.get('/orders/:orderId/status', authenticateToken, getPaymentStatus);
router.get('/admin', authenticateToken, requireAdmin, listPaymentsAdmin);

export default router;
