// ============================================================================
// pyqAnswerFormat.js — reshape a verbatim book answer (pyqAnswer.rawText) into
// the same { openingLine, sections[{heading,points[{claim,example}]}],
// closingLine, quote } shape the AI-generated answers use, so a book answer
// renders with the same headings/bullets UI instead of a flat text wall.
//
// This is REFORMATTING, not authoring: no fact, claim, example, or number may
// be added, removed, or reworded — only reorganized. The source text has the
// original PDF's line-wraps preserved as raw newlines (a sentence can span
// several lines) and inconsistent heading/bullet conventions across different
// parts of the book, which is why this needs a model rather than a regex (see
// the Toppers Copy PYQ conversation — a plain parser mis-split real answers).
//
// Cheap: text-only, no PDF, output is close in size to input. ~$0.005-0.006
// per answer on Claude Haiku-tier pricing; the app's own default (Gemini
// Flash) via utils/aiProvider.js is typically cheaper still.
// ============================================================================

import { runJsonExtraction } from './aiProvider.js';
import { shapePyqAnswer } from './pyqAnswer.js';

const MAX_OUTPUT_TOKENS = 4000;

const buildPrompt = (rawText) => `
You are reformatting the text of an already-written UPSC answer for display. The text below was extracted from a printed book; the ORIGINAL page's line-wraps were preserved as plain newlines, so a single sentence is often split across several lines, and heading/bullet style varies across different parts of the book (numbered headings with bullet sub-points in one place, bare numbered points with no bullets in another, occasional unnumbered sub-headings).

Your ONLY job is to reorganize this exact text into the JSON shape below. This is REFORMATTING, not writing:
- Do NOT add, remove, invent, or rephrase any fact, claim, statistic, name, date, or example.
- DO merge a sentence that was split across multiple lines back into one continuous sentence.
- DO identify the natural section headings and turn each subsequent point into one bullet.
- If a bullet already contains an inline example (introduced by "Eg-", "Eg.", "e.g.", "For example", or similar), split it: "claim" = the point up to that marker, "example" = the text after it. If a bullet has no such marker, put its full text in "claim" and leave "example" as "".
- "openingLine": the first framing/context sentence if the text clearly opens with one before any heading, else "".
- "closingLine": the final concluding sentence if the text clearly ends with one, else "".
- "quote": a quotation that is ALREADY present verbatim in the text, else "". Never invent one.
- Every word in your output must be traceable to the source text below.

SOURCE TEXT:
"""
${rawText}
"""

Return ONE JSON object, no markdown fences, EXACTLY this shape:
{
  "openingLine": "...",
  "sections": [
    { "heading": "short heading exactly as it appears (or a faithful trim of it)", "points": [ { "claim": "...", "example": "..." } ] }
  ],
  "closingLine": "...",
  "quote": ""
}
`.trim();

/**
 * @param {string} rawText  the verbatim answer text (pyqAnswer.rawText)
 * @returns {Promise<object>} shaped { openingLine, sections, closingLine, quote }
 *   — caller merges this into the existing pyqAnswer subdoc (keeps rawText,
 *   images, diagram, published, pendingDiagramPages as-is).
 */
export const formatPyqAnswerText = async (rawText) => {
  const text = String(rawText || '').trim();
  if (!text) {
    const e = new Error('No answer text to format');
    e.code = 'NO_TEXT';
    throw e;
  }
  const parsed = await runJsonExtraction({ prompt: buildPrompt(text), maxOutputTokens: MAX_OUTPUT_TOKENS });
  const shaped = shapePyqAnswer(parsed || {});
  return {
    openingLine: shaped.openingLine,
    sections: shaped.sections,
    closingLine: shaped.closingLine,
    quote: shaped.quote,
  };
};
