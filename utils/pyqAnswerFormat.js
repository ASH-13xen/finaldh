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

// ---------------------------------------------------------------------------
// Reword pass — same shape as above, but the wording is OURS. The book's facts
// stay (every figure, name, date, case, scheme and example), its sentences do
// not: nothing the student reads should be a line lifted from the source book.
// rawText keeps the original, so this can always be re-run or undone.
// ---------------------------------------------------------------------------
const buildRewordPrompt = (rawText, questionText) => `
You are an editor at a UPSC coaching institute. Below is a model answer taken from a printed book. Rewrite it IN FRESH WORDING so that no sentence, heading or phrase is copied from the source, while every fact stays exactly the same.

${questionText ? `QUESTION THE ANSWER ADDRESSES:\n${questionText}\n` : ''}
RULES
- Keep EVERY fact: each claim, statistic, number, year, name, place, report, committee, scheme, article, case, judgment and example in the source must appear in your version, unchanged in meaning. Copy numbers, proper nouns and official titles exactly.
- Do NOT add any fact, example, opinion or number that is not in the source. Do NOT drop any.
- Change the wording thoroughly: new sentence structure, different verbs and connectors, a different order of ideas inside a sentence. Do not reuse a run of more than four consecutive words from the source, except proper nouns, official titles, legal/technical terms and direct quotations.
- Write new section headings in your own words (same meaning, different phrasing). Keep the same sections in the same order; you may reorder the points inside a section.
- Keep it as tight as the source — about the same number of points and the same length. Plain, exam-ready English.
- The source keeps the printed page's line-wraps, so one sentence may be split over several lines; read across them.
- If a point carries an inline example (after "Eg-", "Eg.", "e.g.", "For example" or similar), put the point in "claim" and the example in "example". Otherwise the whole point goes in "claim" and "example" is "".
- "openingLine": the reworded framing sentence if the source opens with one before any heading, else "".
- "closingLine": the reworded concluding sentence if the source ends with one, else "".
- "quote": a quotation ALREADY present in the source, word for word with its speaker, else "". Never invent one.

SOURCE TEXT:
"""
${rawText}
"""

Return ONE JSON object, no markdown fences, EXACTLY this shape:
{
  "openingLine": "...",
  "sections": [
    { "heading": "...", "points": [ { "claim": "...", "example": "..." } ] }
  ],
  "closingLine": "...",
  "quote": ""
}
`.trim();

const words = (s) => String(s || '').toLowerCase().replace(/(\d),(?=\d)/g, '$1').replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Everything a student reads from a shaped answer, as one string. */
export const answerDisplayText = (a = {}) =>
  [
    a.openingLine,
    ...(a.sections || []).flatMap((s) => [s.heading, ...(s.points || []).flatMap((p) => [p.claim, p.example])]),
    a.closingLine,
  ].filter(Boolean).join(' ');

/**
 * How close a reworded answer still is to the book, and whether it kept the figures.
 * @returns {{ copiedShare:number, missingNumbers:string[], lengthRatio:number }}
 *   copiedShare    — share of the new text's 6-word runs that also occur in the source (0 = none)
 *   missingNumbers — figures present in the source but absent from the new text
 *   lengthRatio    — new word count / source word count
 */
export const rewordReport = (rawText, shaped) => {
  const src = words(rawText);
  // List numbering ("1.", "10)") is layout, not a fact — the display renumbers.
  const srcFacts = words(String(rawText || '').replace(/^\s*(?:\d+|[a-z])[.)]\s/gim, ''));
  const out = words(answerDisplayText(shaped));
  const N = 6;
  const grams = new Set();
  for (let i = 0; i + N <= src.length; i++) grams.add(src.slice(i, i + N).join(' '));
  let hit = 0, total = 0;
  for (let i = 0; i + N <= out.length; i++) { total += 1; if (grams.has(out.slice(i, i + N).join(' '))) hit += 1; }
  const nums = (arr) => new Set(arr.map((w) => w.replace(/[.%]+$/, '')).filter((w) => /^\d[\d.]*$/.test(w)));
  const outNums = nums(out);
  const missingNumbers = [...nums(srcFacts)].filter((n) => !outNums.has(n));
  return {
    copiedShare: total ? hit / total : 0,
    missingNumbers,
    lengthRatio: src.length ? out.length / src.length : 0,
  };
};

/**
 * Rewrite a book answer in our own words (facts unchanged).
 * @param {string} rawText        the original answer text (pyqAnswer.rawText)
 * @param {object} [opts]
 * @param {string} [opts.questionText]  the PYQ it answers — context only
 * @returns {Promise<object>} { openingLine, sections, closingLine, quote, report }
 */
export const rewordPyqAnswerText = async (rawText, { questionText = '' } = {}) => {
  const text = String(rawText || '').trim();
  if (!text) {
    const e = new Error('No answer text to reword');
    e.code = 'NO_TEXT';
    throw e;
  }
  const parsed = await runJsonExtraction({
    prompt: buildRewordPrompt(text, String(questionText || '').trim()),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const shaped = shapePyqAnswer(parsed || {});
  if (!shaped.sections.length) throw new Error('Reworded answer came back empty');
  const out = {
    openingLine: shaped.openingLine,
    sections: shaped.sections,
    closingLine: shaped.closingLine,
    quote: shaped.quote,
  };
  return { ...out, report: rewordReport(text, out) };
};
