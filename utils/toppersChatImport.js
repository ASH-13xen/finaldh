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
// A JSON reply is saved as is, with no AI call (word counts recomputed only).
// Two OPTIONAL, admin-clicked, text-only AI steps (cheap, no PDF):
//   • formatWithAi — a reply that is NOT our JSON (plain text, a PDF of a written
//     answer) is rearranged into our shape. Reorganise only, never rewrite facts.
//   • fixWithAi    — a parsed analysis with preview warnings (too long, missing
//     headings, wrong part count, no diagram…) gets just those problems fixed.
// ============================================================================

import { PDFParse } from 'pdf-parse';
import { buildPrompt, shapeAnalysis, withRealCounts, MAX_ANSWER_WORDS } from './toppersAnalysis.js';
import { runJsonExtraction, getActiveModelLabel } from './aiProvider.js';

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

const isAnalysisShape = (obj) => !!(obj?.modelAnswer || obj?.answerImprovements || obj?.learnings);

/** Accept {modelAnswer…}, {aiAnalysis:{…}} or {analysis:{…}}. */
const unwrap = (obj) => {
  if (isAnalysisShape(obj)) return obj;
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
  const parsed = unwrap(typeof raw === 'object' && raw ? raw : extractJson(raw));
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

// ---------------------------------------------------------------------------
// Optional AI steps (text only)
// ---------------------------------------------------------------------------

const MAX_FORMAT_CHARS = 60000;

const SHAPE_SPEC = `{
  "modelAnswer": {
    "introduction": { "text": "..." },
    "body": [
      { "part": "short label for part 1", "points": [ { "heading": "2-4 word heading", "text": "the point" } ] },
      { "part": "short label for part 2", "points": [ { "heading": "...", "text": "..." } ] }
    ],
    "wayForward": { "text": "...", "sources": ["committee / report names cited"] },
    "conclusion": { "text": "...", "quote": "a quote used, else \\"\\"" }
  },
  "diagram": {
    "kind": "flow | table | chart | quadrant | pyramid | timeline",
    "title": "...", "howToDraw": "...", "keywords": ["labels used"],
    "layout": "(flow) flow-vertical | flow-horizontal | cycle | hub-spoke",
    "nodes": [ { "id": "n1", "label": "<= 4 words", "shape": "box | circle | pill | diamond" } ],
    "edges": [ { "from": "n1", "to": "n2", "label": "" } ],
    "columns": ["(table) header row, first column = row label"],
    "rows": [ { "cells": ["row label", "...", "..."] } ],
    "chartType": "(chart) bar | pie | line", "unit": "", "source": "(chart, required) dataset",
    "series": [ { "label": "", "points": [ { "label": "", "value": 0 } ] } ],
    "xAxis": { "low": "", "high": "" }, "yAxis": { "low": "", "high": "" },
    "quadrantItems": [ { "label": "", "x": 0, "y": 0 } ],
    "levels": ["(pyramid) top first"],
    "events": [ { "when": "(timeline)", "label": "" } ]
  },
  "answerImprovements": [ { "area": "intro | structure | content | evidence | diagram | conclusion | presentation", "observation": "...", "fix": "...", "priority": "high | medium | low" } ],
  "learnings": [ { "lesson": "...", "seenIn": "...", "applyElsewhere": "..." } ],
  "keywords": ["high-value terms"]
}`;

const buildFormatPrompt = ({ question, text }) => `
You are putting an ALREADY-WRITTEN UPSC Mains answer analysis into a fixed JSON layout for a website. It was written by another assistant in a chat; it may be plain text, markdown, or text pulled out of a PDF (sentences can be split across lines, and page headers / footers may appear).

Your ONLY job is to place this exact content into the JSON below. This is REARRANGING, not writing:
- Do NOT add, remove, invent or change any fact, figure, name, report, judgment, date, example or quote. Keep the wording; only merge lines that were split and drop chat chatter, page headers / footers.
- Put the model answer into introduction / body / wayForward / conclusion. The body must have EXACTLY 2 parts (group the points into the two most natural halves and label them); every body point gets a 2-4 word "heading" — use the source's own heading if it has one, otherwise a 2-4 word phrase taken from the point itself.
- If there is no separate way forward or conclusion, leave its "text" as "".
- diagram: if the source has a diagram, table, flowchart or chart, convert it to the matching "kind" and fill ONLY that kind's fields. If it has none, build ONE small diagram (flow, table or pyramid) using ONLY terms that already appear in the source. Never use "chart" unless the source gives the numbers and their source.
- answerImprovements / learnings / keywords: fill them only from what the source says; if the source has none, return [].

QUESTION: ${question || '(not given)'}

SOURCE:
"""
${text}
"""

Return ONE JSON object, no markdown fences, in exactly this shape (leave out diagram fields that do not belong to the chosen kind):
${SHAPE_SPEC}
`.trim();

const stripForAi = (a) => ({
  modelAnswer: a.modelAnswer,
  diagram: a.diagram,
  answerImprovements: a.answerImprovements,
  learnings: a.learnings,
  keywords: a.keywords,
});

const buildFixPrompt = ({ question, analysis, problems }) => `
Below is a UPSC Mains answer analysis in JSON that will be shown on a website. Fix ONLY these problems and leave everything else exactly as it is:
${problems.map((p) => `- ${p}`).join('\n')}

How to fix:
- Too long: bring the model answer to 170-190 words (never above ${MAX_ANSWER_WORDS}) by merging or dropping the weakest bullets and cutting filler. Keep the strongest facts / reports / cases. Do NOT add new facts.
- Missing bullet headings: give each such bullet a 2-4 word heading taken from its own text.
- Body not in 2 parts: regroup the existing points into exactly 2 labelled parts.
- Missing introduction / conclusion: write it (20-30 / 15-25 words) using ONLY material already in the answer.
- Missing diagram: build ONE small diagram (flow, table or pyramid — not chart) using ONLY terms already in the answer.
- Missing answerImprovements or learnings: leave them as [] — they must come from the topper copies, which you do not have.
Never change a fact, figure, name, report or quote.

QUESTION: ${question || '(not given)'}

CURRENT JSON:
${JSON.stringify(stripForAi(analysis))}

Return ONE JSON object, no markdown fences, in exactly this shape:
${SHAPE_SPEC}
`.trim();

const aiLabel = (label) => `${asStr(label) || CHAT_IMPORT_LABEL} · arranged by ${getActiveModelLabel()}`;

/** Free-form chat text → our analysis shape (one text-only AI call). */
export const formatWithAi = async (rawText, { question, label } = {}) => {
  const text = asStr(rawText);
  if (!text) throw Object.assign(new Error('Nothing to format.'), { code: 'EMPTY' });
  if (text.length > MAX_FORMAT_CHARS) {
    throw Object.assign(new Error(`Too long to format (${text.length} characters, limit ${MAX_FORMAT_CHARS}). Paste only this question's reply.`), { code: 'TOO_LONG' });
  }
  const parsed = await runJsonExtraction({ prompt: buildFormatPrompt({ question, text }), maxOutputTokens: 8000 });
  return parseChatAnalysis(parsed || {}, { label: aiLabel(label) });
};

/** Fix only the listed problems of an already-shaped analysis (one text-only AI call). */
export const fixWithAi = async (analysisObj, { question, label } = {}) => {
  const { analysis, warnings } = parseChatAnalysis(analysisObj, { label });
  const problems = warnings.filter((w) => !/answerImprovements|learnings/.test(w));
  if (!problems.length) return { analysis, warnings, nothingToFix: true };
  const parsed = await runJsonExtraction({ prompt: buildFixPrompt({ question, analysis, problems }), maxOutputTokens: 8000 });
  const fixed = parseChatAnalysis(parsed || {}, { label: /arranged by/.test(asStr(label)) ? label : aiLabel(label) });
  // The model was told to keep these; restore them if it dropped them anyway.
  if (!fixed.analysis.answerImprovements.length) fixed.analysis.answerImprovements = analysis.answerImprovements;
  if (!fixed.analysis.learnings.length) fixed.analysis.learnings = analysis.learnings;
  if (!fixed.analysis.keywords.length) fixed.analysis.keywords = analysis.keywords;
  fixed.warnings = fixed.warnings.filter((w) =>
    !(/answerImprovements/.test(w) && fixed.analysis.answerImprovements.length) &&
    !(/learnings/.test(w) && fixed.analysis.learnings.length));
  return fixed;
};
