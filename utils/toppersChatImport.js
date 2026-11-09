// ============================================================================
// toppersChatImport.js — bring a Toppers Copy question analysis in from a
// Claude CHAT session (claude.ai), not the API
// ----------------------------------------------------------------------------
// Flow (admin):
//   1. GET  …/questions/:qid/chat-prompt    → the same prompt the API pipeline
//      uses, worded for a chat where the admin attaches the exported answer pages
//      (…/export-pages) by hand.
//   2. Claude replies with the JSON. The admin pastes it, or uploads it as a
//      .json / .txt / .md file, or as a PDF of the chat.
//   3. POST …/questions/:qid/import-analysis → parsed + shaped exactly like an
//      API analysis (shapeAnalysis), so the student view renders it the same way.
//
// No AI call happens here: word counts are recomputed, never trimmed by a model.
// ============================================================================

import { PDFParse } from 'pdf-parse';
import { buildPrompt, shapeAnalysis, withRealCounts, MAX_ANSWER_WORDS } from './toppersAnalysis.js';

export const CHAT_IMPORT_LABEL = 'Claude chat (manual import)';

const asStr = (v) => String(v ?? '').trim();

/**
 * Prompt for a chat session. Page numbers refer to the PDF that
 * GET …/export-pages returns: only this question's answer pages, in order.
 */
export const buildChatPrompt = (doc, question) => {
  const wanted = new Set();
  for (const a of question.answers || []) {
    for (let p = a.startPage; p <= a.endPage; p++) wanted.add(p);
  }
  const pages = [...wanted].sort((a, b) => a - b);
  const pos = (abs) => pages.indexOf(abs) + 1;

  const answerLines = (question.answers || [])
    .map((a) => {
      const who = `${a.name}${a.rank ? ` (AIR ${a.rank}${a.year ? `, ${a.year}` : ''})` : ''}${a.marks ? `, ${a.marks} marks` : ''}`;
      const note = a.curatorNote ? `\n   Curator note: ${a.curatorNote}` : '';
      return `- ${who} — pages ${pos(a.startPage)}-${pos(a.endPage)}.${note}`;
    })
    .join('\n') || '- (no answer pages recorded — use the attached copies)';

  const body = buildPrompt({ subject: doc.subject, topic: doc.topic, question, answerLines });
  return `${body}\n\nReply with ONLY that JSON object (a single \`\`\`json code block is fine) and nothing else — it will be pasted straight into our website.`;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Text out of an uploaded file (PDF via pdf-parse, anything else as UTF-8). */
export const fileToText = async (file) => {
  if (!file) return '';
  const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
  if (!isPdf) return file.buffer.toString('utf8');
  const parser = new PDFParse({ data: file.buffer });
  try {
    const out = await parser.getText();
    return out.text || '';
  } finally {
    await parser.destroy?.().catch(() => {});
  }
};

/** The outermost {...} block, ignoring braces inside strings. */
const outerObject = (s) => {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start); // unbalanced — let JSON.parse report it
};

const tryParse = (s) => {
  try { return JSON.parse(s); } catch { return undefined; }
};

/**
 * Find the analysis JSON in whatever was pasted: bare JSON, a ```json fence,
 * chat text around it, or text pulled out of a PDF (where long strings get
 * broken across lines and quotes may come out curly).
 */
export const extractJson = (raw) => {
  let text = asStr(raw).replace(/^﻿/, '');
  if (!text) throw Object.assign(new Error('Nothing to import — paste the reply or choose a file.'), { code: 'EMPTY' });

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1];

  const candidates = [];
  const block = outerObject(text);
  if (block) {
    candidates.push(block);
    candidates.push(block.replace(/\r?\n/g, ' '));                       // line-wrapped strings (PDF / copy)
    candidates.push(block.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\r?\n/g, ' '));
    candidates.push(block.replace(/\r?\n/g, ' ').replace(/,\s*([}\]])/g, '$1')); // trailing commas
  }
  for (const c of candidates) {
    const v = tryParse(c);
    if (v && typeof v === 'object') return v;
  }
  throw Object.assign(
    new Error('Could not read JSON from this. Ask Claude to reply with only the JSON object (the copied prompt asks for that), then paste it again.'),
    { code: 'BAD_JSON' },
  );
};

/** Accept {modelAnswer…}, {aiAnalysis:{…}} or {analysis:{…}}. */
const unwrap = (obj) => {
  if (obj?.modelAnswer || obj?.answerImprovements || obj?.learnings) return obj;
  for (const k of ['aiAnalysis', 'analysis', 'result', 'data']) {
    if (obj?.[k] && typeof obj[k] === 'object') return obj[k];
  }
  return obj;
};

/**
 * Raw text → shaped aiAnalysis + warnings for the admin preview.
 * @throws Error with .code EMPTY | BAD_JSON | NO_CONTENT
 */
export const parseChatAnalysis = (raw, { label } = {}) => {
  const parsed = unwrap(extractJson(raw));
  const analysis = shapeAnalysis(parsed || {});
  analysis.modelAnswer = withRealCounts(analysis.modelAnswer);
  analysis.aiModel = asStr(label) || CHAT_IMPORT_LABEL;
  analysis.generatedAt = new Date();

  const ma = analysis.modelAnswer;
  const hasAnswer = ma.introduction.text || ma.body.length || ma.conclusion.text;
  if (!hasAnswer && !analysis.answerImprovements.length && !analysis.learnings.length) {
    throw Object.assign(
      new Error('The JSON has none of the expected parts (modelAnswer, answerImprovements, learnings). Use the copied prompt so Claude replies in our format.'),
      { code: 'NO_CONTENT' },
    );
  }

  const warnings = [];
  if (!ma.introduction.text) warnings.push('No introduction in the model answer.');
  if (!ma.body.length) warnings.push('No body points in the model answer.');
  else if (ma.body.length !== 2) warnings.push(`Body has ${ma.body.length} parts (the format expects 2).`);
  if (ma.body.some((p) => p.points.some((pt) => !pt.heading))) warnings.push('Some body bullets have no heading.');
  if (!ma.conclusion.text) warnings.push('No conclusion in the model answer.');
  if (ma.totalWordCount > MAX_ANSWER_WORDS) warnings.push(`Model answer is ${ma.totalWordCount} words (limit ${MAX_ANSWER_WORDS}). It is kept as is — ask Claude to shorten it if you want.`);
  const rawDia = parsed?.diagram;
  if (!rawDia || typeof rawDia !== 'object' || !Object.keys(rawDia).length) warnings.push('No diagram.');
  if (!analysis.answerImprovements.length) warnings.push('No answerImprovements.');
  if (!analysis.learnings.length) warnings.push('No learnings.');

  return { analysis, warnings };
};
