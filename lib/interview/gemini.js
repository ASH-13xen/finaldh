// Gemini access for the interview section (and its offline pipeline). Every caller has a no-AI fallback,
// so this module never lets a missing or rejected key crash a request: after an auth failure it reports
// "unavailable" for a few minutes instead of retrying on every call.
import { GoogleGenerativeAI } from '@google/generative-ai';

export const GEMINI_MODEL = process.env.INTERVIEW_GEMINI_MODEL || 'gemini-3.5-flash';
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMS = 256;

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const AUTH_BACKOFF_MS = 5 * 60 * 1000;

const state = { authFailedAt: 0, lastError: '', lastOkAt: 0 };

export class GeminiUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

const apiKey = () => {
  const k = process.env.GEMINI_API_KEY;
  return k && k !== 'your_gemini_api_key_here' ? k : '';
};

export const geminiStatus = () => {
  const configured = !!apiKey();
  const coolingDown = state.authFailedAt && Date.now() - state.authFailedAt < AUTH_BACKOFF_MS;
  return {
    configured,
    available: configured && !coolingDown,
    lastError: state.lastError,
    lastOkAt: state.lastOkAt ? new Date(state.lastOkAt).toISOString() : null
  };
};

export const aiAvailable = () => geminiStatus().available;

// Ask Gemini once (a free model-list call) whether the key works, so the app can say "AI is off" before
// a student starts an interview rather than after the first answer. Cached for PROBE_MS.
const PROBE_MS = 10 * 60 * 1000;
let probe = { at: 0, pending: null };
export const checkGemini = async () => {
  if (!apiKey()) return false;
  if (Date.now() - probe.at < PROBE_MS) return aiAvailable();
  if (!probe.pending) {
    probe.pending = (async () => {
      try {
        const res = await fetch(`${API_ROOT}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey() }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          state.authFailedAt = 0;
          state.lastOkAt = Date.now();
          state.lastError = '';
        } else {
          const body = await res.json().catch(() => ({}));
          state.lastError = `[${res.status}] ${body?.error?.message || res.statusText}`.slice(0, 200);
          if (res.status === 401 || res.status === 403 || res.status === 400) state.authFailedAt = Date.now();
        }
      } catch (err) {
        state.lastError = String(err?.message || err).slice(0, 200); // network trouble: don't mark the key bad
      } finally {
        probe = { at: Date.now(), pending: null };
      }
    })();
  }
  await probe.pending;
  return aiAvailable();
};

const isAuthError = (err) => {
  const msg = String(err?.message || err || '');
  return /\b(401|403)\b|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED|API_KEY_INVALID/i.test(msg);
};
const isRetryable = (err) => /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(err?.message || err || ''));

const guard = () => {
  if (!apiKey()) throw new GeminiUnavailableError('GEMINI_API_KEY is not set');
  if (!aiAvailable()) throw new GeminiUnavailableError(`Gemini rejected the API key recently (${state.lastError})`);
};

const noteFailure = (err) => {
  state.lastError = String(err?.message || err).slice(0, 200);
  if (isAuthError(err)) {
    state.authFailedAt = Date.now();
    throw new GeminiUnavailableError(state.lastError);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withRetry = async (fn, { retries = 3, baseDelayMs = 1500 } = {}) => {
  let delay = baseDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      state.lastOkAt = Date.now();
      state.authFailedAt = 0;
      state.lastError = '';
      return out;
    } catch (err) {
      noteFailure(err);
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }
};

// Pull the first JSON object/array out of a model reply (tolerates ```json fences).
export const parseJsonReply = (text) => {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(s);
  } catch {
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error('Gemini did not return JSON');
  }
};

// Gemini 3.x thinks before answering, and its thinking tokens count against maxOutputTokens - left at
// the default, a short JSON reply gets cut off mid-object. Every call sets a thinking level instead:
// 'low' for the live interview (fast), higher where the extra reasoning is worth the wait.
const thinkingConfig = (level) => (level ? { thinkingConfig: { thinkingLevel: level } } : {});

// One JSON-mode generation. `parts` may include { inlineData: { data, mimeType } } for files/audio.
export const generateJson = async ({ system, prompt, parts = [], temperature = 0.4, maxOutputTokens = 8192, retries = 2, model = GEMINI_MODEL, thinking = 'low' }) => {
  guard();
  const genAI = new GoogleGenerativeAI(apiKey());
  const m = genAI.getGenerativeModel({
    model,
    systemInstruction: system || undefined,
    generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens, ...thinkingConfig(thinking) }
  });
  return withRetry(async () => {
    const res = await m.generateContent([prompt, ...parts]);
    return parseJsonReply(res.response.text());
  }, { retries });
};

// Plain-text generation (used for audio transcription).
export const generateText = async ({ system, prompt, parts = [], temperature = 0.2, maxOutputTokens = 2048, retries = 1, model = GEMINI_MODEL, thinking = 'low' }) => {
  guard();
  const genAI = new GoogleGenerativeAI(apiKey());
  const m = genAI.getGenerativeModel({ model, systemInstruction: system || undefined, generationConfig: { temperature, maxOutputTokens, ...thinkingConfig(thinking) } });
  return withRetry(async () => {
    const res = await m.generateContent([prompt, ...parts]);
    return res.response.text().trim();
  }, { retries });
};

const l2normalize = (vals) => {
  let n = 0;
  for (const v of vals) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(vals, (v) => v / n);
};

// Embeddings through the REST batch endpoint (the SDK version in package.json can't set the output size).
// taskType: SEMANTIC_SIMILARITY | RETRIEVAL_QUERY | RETRIEVAL_DOCUMENT. Returns L2-normalised vectors.
export const embedTexts = async (texts, { taskType = 'SEMANTIC_SIMILARITY', dims = EMBEDDING_DIMS, retries = 4 } = {}) => {
  guard();
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const body = {
      requests: batch.map((t) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: String(t).slice(0, 2000) }] },
        taskType,
        outputDimensionality: dims
      }))
    };
    const data = await withRetry(async () => {
      const res = await fetch(`${API_ROOT}/models/${EMBEDDING_MODEL}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`[${res.status}] ${json?.error?.message || res.statusText}`);
      return json;
    }, { retries, baseDelayMs: 4000 });
    for (const e of data.embeddings || []) out.push(l2normalize(e.values || []));
  }
  return out;
};

// Int8 storage for embeddings (1 byte per dimension) - plenty for ranking, 4x smaller than float32.
export const quantize = (vec) => Buffer.from(Int8Array.from(vec, (v) => Math.max(-127, Math.min(127, Math.round(v * 127)))).buffer);
export const dequantize = (buf) => {
  const bytes = buf?.buffer ? new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Int8Array(buf || []);
  return l2normalize(Array.from(bytes, (v) => v / 127));
};
