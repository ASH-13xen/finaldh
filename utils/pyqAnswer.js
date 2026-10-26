// ============================================================================
// pyqAnswer.js — generate the house-style model answer for one ToppersPyq.
// ----------------------------------------------------------------------------
// Text-only (question in, structured answer out) — no PDF, so this is cheap.
// The ONLY input is the exam question itself; we never feed or copy an existing
// published answer. Output structure mirrors the common UPSC answer format
// (opening line -> 3-6 headed sections of claim+example bullets -> closing line
// -> optional quote -> one small diagram). Structure is a format, not content.
//
// Used by:
//   • controllers/toppersCopyController.js  (POST /admin/pyqs/:id/answer)
//   • scripts/generate_pyq_answers.mjs      (bulk run)
// It does NOT persist — the caller assigns the result to pyq.pyqAnswer and saves.
// ============================================================================

import { runJsonExtraction, getActiveModelLabel } from './aiProvider.js';
import { shapeDiagram } from './toppersAnalysis.js';

const MAX_OUTPUT_TOKENS = 6000;

const asStr = (v) => String(v ?? '').trim();
const asArr = (v) => (Array.isArray(v) ? v : []);

export const shapePyqAnswer = (parsed = {}) => ({
  openingLine: asStr(parsed.openingLine || parsed.opening),
  sections: asArr(parsed.sections)
    .map((s) => ({
      heading: asStr(s.heading || s.title),
      points: asArr(s.points)
        .map((p) => ({
          claim: asStr(p.claim || p.text || p.point),
          example: asStr(p.example || p.eg || p.evidence),
        }))
        .filter((p) => p.claim),
    }))
    .filter((s) => s.heading && s.points.length),
  closingLine: asStr(parsed.closingLine || parsed.closing || parsed.conclusion),
  quote: asStr(parsed.quote),
  diagram: shapeDiagram(parsed.diagram || {}),
  aiModel: getActiveModelLabel(),
  generatedAt: new Date(),
});

const buildPrompt = ({ subject, topic, questionText, marks, year }) => `
You are a UPSC Mains answer coach. Write ONE model answer to the question below, in the standard exam structure. Work only from the question — bring in your own reports, data, schemes, judgments, committee names, thinkers and examples. Prefer specific, verifiable references over vague claims, and avoid the obvious textbook points every aspirant writes.

QUESTION
Subject: ${subject || '(unspecified)'}
Topic: ${topic || '(unspecified)'}
${year ? `Year asked: ${year}` : ''}
${marks ? `Marks: ${marks}` : ''}
Question: ${questionText}

STRUCTURE (total ~${marks && Number(marks) >= 15 ? '250' : '150'} words):
- openingLine: ONE sentence. A data point, report finding, definition or recent development that frames the answer. No throat-clearing.
- sections: ${marks && Number(marks) >= 15 ? '3 to 5' : '2 to 3'} thematic sections. Each has a short "heading" reflecting a demand of the question (dimensions / challenges, causes / effects, for / against, etc.) and 2 to 4 "points". Every point is a "claim" fused with a concrete "example" (a report, datum, case study, scheme, judgment, or thinker). Points must be non-obvious.
- closingLine: ONE forward-looking sentence — a specific recommendation from a report/committee, or a vision phrase.
- quote: a short, genuinely relevant quotation if one fits naturally, else "".

Also give ONE small, hand-drawable diagram. Pick the form that best fits this question — vary it, do not default to a flowchart:
  • "flow" (process / causal chain / cycle / hub of relationships)
  • "table" (comparison across shared parameters — best for "compare / distinguish / both sides")
  • "chart" (ONLY with real, citable numbers — give "source"; never invent data)
  • "quadrant" (items placed on two named axes)
  • "pyramid" (a hierarchy or staged structure)
  • "timeline" (evolution across years / phases)
Every label is a theme keyword; keep it reproducible in ~20 seconds.

Return ONE JSON object, no markdown fences, EXACTLY this shape:
{
  "openingLine": "...",
  "sections": [
    { "heading": "short label", "points": [ { "claim": "the claim", "example": "the concrete example / evidence" } ] }
  ],
  "closingLine": "...",
  "quote": "the quote, else \\"\\"",
  "diagram": {
    "kind": "flow | table | chart | quadrant | pyramid | timeline",
    "title": "short caption",
    "howToDraw": "2-3 sentences to reproduce it",
    "keywords": ["labels used, in draw order"],
    "layout": "(flow) flow-vertical | flow-horizontal | cycle | hub-spoke",
    "nodes": [ { "id": "n1", "label": "keyword", "shape": "box | circle | pill | diamond" } ],
    "edges": [ { "from": "n1", "to": "n2", "label": "" } ],
    "columns": ["(table) headers; first col is the row label"],
    "rows": [ { "cells": ["row label", "cell", "cell"] } ],
    "chartType": "(chart) bar | pie | line",
    "unit": "(chart) % | crore | ...",
    "source": "(chart, REQUIRED) dataset the numbers are from",
    "series": [ { "label": "", "points": [ { "label": "category/year", "value": 0 } ] } ],
    "xAxis": { "low": "(quadrant) left", "high": "right" },
    "yAxis": { "low": "(quadrant) bottom", "high": "top" },
    "quadrantItems": [ { "label": "keyword", "x": -1, "y": 1 } ],
    "levels": ["(pyramid) top level first"],
    "events": [ { "when": "(timeline) year/phase", "label": "what changed" } ],
    "mermaid": "(flow) same graph as Mermaid, else \\"\\""
  }
}

Rules:
- Every point pairs a claim with an example. No fabricated report names, data or quotes — if unsure of a figure, describe it qualitatively.
- diagram: fill ONLY the chosen kind's fields. "keywords" lists exactly the labels shown.
`.trim();

/**
 * Generate (but do NOT save) the house-style model answer for one PYQ.
 * @param {object} pyq  a ToppersPyq document (or plain object) with questionText etc.
 * @returns {Promise<object>}  shaped pyqAnswer subdoc (published:false, no images)
 */
export const generatePyqAnswer = async (pyq) => {
  const questionText = asStr(pyq.questionText);
  if (!questionText) {
    const e = new Error('This PYQ has no question text to answer');
    e.code = 'NO_QUESTION';
    throw e;
  }
  const prompt = buildPrompt({
    subject: pyq.subject,
    topic: pyq.topic || pyq.microtheme || pyq.section,
    questionText,
    marks: pyq.marks,
    year: pyq.year,
  });
  const parsed = await runJsonExtraction({ prompt, maxOutputTokens: MAX_OUTPUT_TOKENS });
  return shapePyqAnswer(parsed || {});
};
