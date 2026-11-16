// The key a student's progress on a question is stored under: a hash of its normalised wording, so the same
// question has the same key in predictions and the bank, and keeps its status when predictions are rebuilt.
import crypto from 'crypto';
import { normalizeText } from './text.js';

export const prepKey = (text) => `q:${crypto.createHash('sha1').update(normalizeText(text)).digest('hex').slice(0, 16)}`;
export const PREP_KEY_RE = /^q:[a-f0-9]{16}$/;
