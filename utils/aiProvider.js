// ============================================================================
// aiProvider.js — pluggable AI backend for document-extraction tasks
// ----------------------------------------------------------------------------
// The app has several "read a PDF / a block of text and give me back structured
// JSON" jobs (PYQ extraction, topic indexing, toppers-copy ingestion, AI
// analysis). Historically each of those hard-coded the Google Gemini SDK.
//
// This module hides the provider behind one function, `runJsonExtraction()`, so
// the same job code can run on either Google Gemini OR Anthropic Claude. Which
// one is used is decided ONLY by environment variables — no code change needed
// to switch:
//
//   AI_PROVIDER        'gemini' (default) | 'claude'
//   AI_MODEL_GEMINI    default 'gemini-3.5-flash'
//   AI_MODEL_CLAUDE    default 'claude-opus-5'   (see cost note below)
//   GEMINI_API_KEY     required when AI_PROVIDER=gemini
//   ANTHROPIC_API_KEY  required when AI_PROVIDER=claude
//
// COST NOTE: Claude Opus 5 is the most capable model but also the priciest
// ($5 / $25 per 1M tokens in/out). For high-volume bulk extraction you may want
// to set AI_MODEL_CLAUDE=claude-sonnet-5 or =claude-haiku-4-5 — that is a
// deliberate cost/quality trade-off and is left to whoever configures the
// deployment, not decided here.
// ============================================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Config resolution (all env-driven, evaluated lazily per call so tests / a
// restart-free config change are picked up).
// ---------------------------------------------------------------------------
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

// Retry/backoff tuning — matches the values the old inline Gemini helpers used.
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 3000;

/** Which provider is active: 'gemini' | 'claude'. */
export const getActiveProvider = () => {
  const raw = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  return raw === 'claude' || raw === 'anthropic' ? 'claude' : 'gemini';
};

/** Human-readable "provider/model" string, handy for logs and job records. */
export const getActiveModelLabel = () => {
  const provider = getActiveProvider();
  const model =
    provider === 'claude'
      ? process.env.AI_MODEL_CLAUDE || DEFAULT_CLAUDE_MODEL
      : process.env.AI_MODEL_GEMINI || DEFAULT_GEMINI_MODEL;
  return `${provider}/${model}`;
};

/**
 * Throws a clear error if the active provider has no API key configured.
 * Call this once before kicking off a long job so it fails fast instead of
 * dying on the first chunk.
 */
export const assertAiConfigured = () => {
  const provider = getActiveProvider();
  if (provider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'AI_PROVIDER=claude but ANTHROPIC_API_KEY is not set in the backend environment.'
      );
    }
  } else {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === 'your_gemini_api_key_here') {
      throw new Error(
        'AI_PROVIDER=gemini but GEMINI_API_KEY is not set in the backend environment.'
      );
    }
  }
};

// ---------------------------------------------------------------------------
// JSON parsing — models occasionally wrap output in ```json fences or add a
// stray sentence despite instructions. Be forgiving.
// ---------------------------------------------------------------------------
const parseJsonLoose = (text) => {
  if (typeof text !== 'string') throw new Error('AI response was not text');
  let s = text.trim();

  // Strip a leading/trailing markdown code fence if present.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  try {
    return JSON.parse(s);
  } catch {
    // Last resort: grab the outermost {...} or [...] block.
    const firstBrace = s.search(/[[{]/);
    const lastBrace = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(s.slice(firstBrace, lastBrace + 1));
      } catch { /* fall through */ }
    }
    console.error('[aiProvider] unparseable response (first 800 chars):', s.slice(0, 800));
    throw new Error(
      `Could not parse JSON from AI response (${s.length} chars). Likely truncated — raise maxOutputTokens or shorten the prompt.`
    );
  }
};

/** True when an error looks like a rate-limit / quota problem (used by callers to stop early). */
export const isQuotaError = (err) => {
  const m = (err && (err.message || String(err))) || '';
  return /quota|rate limit|429|too many requests|overloaded|insufficient_quota/i.test(m);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Provider implementations. Each returns the raw text of the model's reply.
// ---------------------------------------------------------------------------

// --- Gemini -----------------------------------------------------------------
let _geminiClient = null;
const geminiClient = () => {
  if (!_geminiClient) _geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _geminiClient;
};

const runGemini = async ({ prompt, system, pdfBase64, mimeType, maxOutputTokens }) => {
  const model = geminiClient().getGenerativeModel({
    model: process.env.AI_MODEL_GEMINI || DEFAULT_GEMINI_MODEL,
    // Gemini has no separate "system" role in this SDK version — prepend it.
    systemInstruction: system || undefined,
    generationConfig: {
      responseMimeType: 'application/json',
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      // These are structured-extraction tasks — no reasoning budget needed, and on
      // 2.5/3.x models "thinking" tokens eat the output cap and truncate the JSON.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const parts = [prompt];
  if (pdfBase64) {
    parts.push({ inlineData: { data: pdfBase64, mimeType: mimeType || 'application/pdf' } });
  }

  const result = await model.generateContent(parts);
  const resp = result.response;
  const text = resp.text();
  if (!text || !text.trim()) {
    const reason = resp.candidates?.[0]?.finishReason || 'unknown';
    const block = resp.promptFeedback?.blockReason;
    throw new Error(
      `Gemini returned no text (finishReason: ${reason}${block ? `, blockReason: ${block}` : ''}). ` +
      (reason === 'MAX_TOKENS' ? 'Raise maxOutputTokens.' : 'Check the prompt / safety settings.')
    );
  }
  return text;
};

// --- Claude ----------------------------------------------------------------
let _claudeClient = null;
const claudeClient = () => {
  if (!_claudeClient) _claudeClient = new Anthropic(); // reads ANTHROPIC_API_KEY
  return _claudeClient;
};

const runClaude = async ({ prompt, system, pdfBase64, mimeType, maxOutputTokens }) => {
  const content = [];
  if (pdfBase64) {
    // A document block must come BEFORE the instruction text.
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: mimeType || 'application/pdf', data: pdfBase64 },
    });
  }
  content.push({ type: 'text', text: prompt });

  // Stream so large chunk outputs don't hit the SDK's HTTP timeout, then collect
  // the final message. `.finalMessage()` returns the assembled Message object.
  const stream = claudeClient().messages.stream({
    model: process.env.AI_MODEL_CLAUDE || DEFAULT_CLAUDE_MODEL,
    max_tokens: maxOutputTokens || 32000,
    // Adaptive thinking + medium effort: extraction is structured but not trivial;
    // this keeps quality up without paying for max-effort reasoning on every chunk.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system:
      (system ? system + '\n\n' : '') +
      'Respond with raw JSON only. Do not wrap it in markdown code fences and do not add any commentary before or after the JSON.',
    messages: [{ role: 'user', content }],
  });

  const message = await stream.finalMessage();
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one extraction call against the active provider and return PARSED JSON.
 *
 * @param {Object}  opts
 * @param {string}  opts.prompt          The instruction / task text (required).
 * @param {string} [opts.system]         Optional system-level guidance.
 * @param {string} [opts.pdfBase64]      Optional base64-encoded PDF (no data: prefix, no newlines).
 * @param {string} [opts.mimeType]       Defaults to 'application/pdf'.
 * @param {number} [opts.maxOutputTokens] Cap the model's reply length (Gemini maxOutputTokens / Claude max_tokens).
 * @param {number} [opts.maxRetries]     Defaults to MAX_RETRIES.
 * @param {number} [opts.initialDelayMs] First backoff delay; defaults to INITIAL_RETRY_DELAY_MS.
 *                                       Pass a larger value for long batch jobs on a tight quota.
 * @returns {Promise<any>}               The parsed JSON value the model returned.
 *
 * Retries transient failures with exponential backoff. A quota/rate-limit error
 * is retried too, but if it persists the final throw will satisfy isQuotaError()
 * so the caller can abort the whole job instead of grinding through every chunk.
 */
export const runJsonExtraction = async ({
  prompt,
  system,
  pdfBase64,
  mimeType,
  maxOutputTokens,
  maxRetries = MAX_RETRIES,
  initialDelayMs = INITIAL_RETRY_DELAY_MS,
} = {}) => {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('runJsonExtraction: `prompt` is required');
  }

  const provider = getActiveProvider();
  const run = provider === 'claude' ? runClaude : runGemini;

  let delay = initialDelayMs;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const text = await run({ prompt, system, pdfBase64, mimeType, maxOutputTokens });
      return parseJsonLoose(text);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      console.warn(
        `[aiProvider:${provider}] attempt ${attempt}/${maxRetries} failed: ${err.message || err}. Retrying in ${delay}ms`
      );
      await sleep(delay);
      delay *= 2;
    }
  }
  throw lastErr;
};
