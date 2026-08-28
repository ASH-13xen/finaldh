// quizAI.js — generates the "why this option is correct" explanation and a one-line hint
// for a single quiz question, using the pluggable AI backend (utils/aiProvider.js, provider
// chosen by AI_PROVIDER). Used only by scripts/generate_quiz_ai.mjs at ingestion time — the
// request path never calls a model.

import { runJsonExtraction } from './aiProvider.js';

const SYSTEM = [
  'You are a UPSC/CDS exam tutor writing answer keys for multiple-choice questions.',
  'You are given a question, its four options, and which option is correct.',
  'Return a compact JSON object and nothing else.'
].join(' ');

const buildPrompt = ({ questionText, options, correctKey }) => {
  const optionLines = options.map((o) => `${o.key}. ${o.text}`).join('\n');
  return [
    'QUESTION:',
    questionText,
    '',
    'OPTIONS:',
    optionLines,
    '',
    `CORRECT OPTION: ${correctKey}`,
    '',
    'Return JSON with exactly these keys:',
    '{',
    '  "whyCorrect": "2-3 sentences explaining why the correct option is right and, briefly, why the others are not. Plain text, no markdown.",',
    '  "hint": "One short sentence that nudges a student toward the answer WITHOUT naming the correct option or restating it."',
    '}'
  ].join('\n');
};

/**
 * @param {{questionText:string, options:{key:string,text:string}[], correctKey:string}} q
 * @returns {Promise<{whyCorrect:string, hint:string}>}
 */
export const generateWhyAndHint = async (q) => {
  const result = await runJsonExtraction({
    system: SYSTEM,
    prompt: buildPrompt(q),
    maxOutputTokens: 700
  });

  const whyCorrect = typeof result?.whyCorrect === 'string' ? result.whyCorrect.trim() : '';
  const hint = typeof result?.hint === 'string' ? result.hint.trim() : '';
  if (!whyCorrect) throw new Error('AI response missing "whyCorrect"');

  return { whyCorrect, hint };
};
