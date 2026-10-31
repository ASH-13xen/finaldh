import crypto from 'crypto';
import Razorpay from 'razorpay';

// Razorpay client, created on first use (the environment is loaded after module imports, see index.js).
// RAZORPAY_KEY_ID is public - it is sent to the browser to open Checkout. RAZORPAY_KEY_SECRET and
// RAZORPAY_WEBHOOK_SECRET never leave the server.
let client = null;

export const razorpayKeyId = () => process.env.RAZORPAY_KEY_ID || '';

export const isRazorpayConfigured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

export const getRazorpay = () => {
  if (client) return client;
  if (!isRazorpayConfigured()) {
    throw new Error('Razorpay is not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env');
  }
  client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return client;
};

// Tests swap in a fake client so they never call Razorpay's API.
export const setRazorpayClient = (fake) => { client = fake; };

const hmacHex = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

// Constant-time compare, so a forged signature can't be guessed byte by byte from response timings.
const sameHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

// The signature Checkout hands the browser after a successful payment: HMAC(order_id|payment_id, key secret).
export const isValidPaymentSignature = (orderId, paymentId, signature) => {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  return sameHex(hmacHex(process.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
};

// X-Razorpay-Signature on webhooks: HMAC of the exact raw request body with the webhook secret.
export const isValidWebhookSignature = (rawBody, signature) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  return sameHex(hmacHex(process.env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
};
