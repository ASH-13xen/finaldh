// ============================================================================
// toppersEnhancement.js — generate the margin "enhancement layer" for ONE
// topper's answer copy
// ----------------------------------------------------------------------------
// Shared by:
//   • controllers/toppersEnhancementController.js (POST …/answers/:aidx/enhance)
//   • scripts/generate_toppers_enhancements.mjs   (bulk run)
//
// These are toppers' copies, so the layer NEVER points out mistakes, grades, or
// says what is "missing". It only adds value:
//   • works — why a stretch of lines earns marks (the technique to copy)
//   • addon — extra material that builds on the topper's point
// plus a Takeaways card. Each note is anchored to a vertical span of a page
// (fractions of page height) so the viewer can draw a bracket + arrow to it.
//
// Does NOT persist — the caller upserts the ToppersEnhancement doc.
// ============================================================================

import { PDFDocument } from 'pdf-lib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import { makeChunkPdfBase64 } from './pdfChunk.js';
import { runJsonExtraction, getActiveModelLabel } from './aiProvider.js';

const MAX_OUTPUT_TOKENS = 8000;
const MAX_NOTES_PER_PAGE = 6;

const asStr = (v) => String(v ?? '').trim();
const asArr = (v) => (Array.isArray(v) ? v : []);
const asStrArr = (v) => asArr(v).map(asStr).filter(Boolean);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Words that turn an enhancement into a critique. The prompt forbids them; this
// catches any that slip through so the admin sees them before publishing.
const CRITIQUE_RE = /\b(mistake|mistakes|missing|missed|misses|lacks?|lacking|weak|weakness|vague|should have|could have|failed|fails|error|errors|wrong|incorrect|poor|only mentions|did not|didn't|doesn't|does not|forgot|ignores?|ignored|shallow|generic|superficial)\b/i;

/** Every note / takeaway line that reads like a critique, for the admin to fix. */
export const findToneIssues = (enh) => {
  const issues = [];
  for (const n of asArr(enh?.notes)) {
    for (const s of [n.title, n.text, ...asArr(n.points)]) {
      const m = asStr(s).match(CRITIQUE_RE);
      if (m) issues.push({ noteId: n._id ? String(n._id) : null, page: n.page, word: m[0], text: asStr(s) });
    }
  }
  const t = enh?.takeaways || {};
  for (const s of [...asArr(t.techniques), ...asArr(t.enrichment)]) {
    const m = asStr(s).match(CRITIQUE_RE);
    if (m) issues.push({ noteId: null, page: null, word: m[0], text: asStr(s) });
  }
  return issues;
};

/** Coerce one note from the model (or the admin editor) into the stored shape. */
export const shapeNote = (n, { pageOffset = 0, lo = 1, hi = Infinity } = {}) => {
  const kind = asStr(n?.kind).toLowerCase() === 'addon' ? 'addon' : 'works';
  const page = Math.round(Number(n?.page)) + pageOffset;
  if (!Number.isFinite(page) || page < lo || page > hi) return null;

  // Accept the model's box_2d ([ymin, xmin, ymax, xmax] on 0-1000), a {yFrom,yTo}
  // pair on 0-1 (admin edits), or a [yMin, yMax] pair on 0-1000.
  let a; let b;
  if (Array.isArray(n?.box_2d) && n.box_2d.length === 4) {
    a = Number(n.box_2d[0]) / 1000; b = Number(n.box_2d[2]) / 1000;
  } else if (Array.isArray(n?.span) && n.span.length === 2) {
    a = Number(n.span[0]) / 1000; b = Number(n.span[1]) / 1000;
  } else {
    a = Number(n?.yFrom); b = Number(n?.yTo);
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let yFrom = clamp01(Math.min(a, b));
  let yTo = clamp01(Math.max(a, b));
  if (yTo - yFrom < 0.02) { yTo = clamp01(yFrom + 0.03); } // a bracket needs some height

  const title = asStr(n?.title).slice(0, 120);
  const text = asStr(n?.text).slice(0, 400);
  const points = kind === 'addon' ? asStrArr(n?.points).slice(0, 3).map((p) => p.slice(0, 200)) : [];
  if (!title && !text && !points.length) return null;

  return { page, kind, yFrom, yTo, title, text, points, ...(n?._id ? { _id: n._id } : {}) };
};

export const shapeTakeaways = (t = {}) => ({
  techniques: asStrArr(t.techniques).slice(0, 8),
  enrichment: asStrArr(t.enrichment).slice(0, 8),
  keywords: asStrArr(t.keywords).slice(0, 15),
});

const capPerPage = (notes) => {
  const byPage = new Map();
  for (const n of notes) {
    const list = byPage.get(n.page) || [];
    if (list.length < MAX_NOTES_PER_PAGE) list.push(n);
    byPage.set(n.page, list);
  }
  return [...byPage.values()].flat().sort((x, y) => x.page - y.page || x.yFrom - y.yFrom);
};

const buildPrompt = ({ subject, topic, questionText, marks, topper, pageCount }) => `
You are annotating a UPSC Mains TOPPER's handwritten answer copy for students to learn from. The attached PDF is that ONE answer (${pageCount} page${pageCount === 1 ? '' : 's'}).

This is a topper's copy. You are NOT an examiner. NEVER point out mistakes, gaps or weaknesses; never grade it; never say what the topper "missed", "should have" or "could have" done. Your only job is to ENHANCE it:

1. "works" notes (shown in green in the LEFT margin): point at a stretch of lines and name the TECHNIQUE that makes it score — e.g. "Opens with a thinker's definition", "Heading mirrors the question's demand", "Every point carries an example", "Diagram compresses 5 points", "Conclusion ties back to the Constitution". Title = the technique (<= 8 words). Text = one line on why it works / how to reuse it.
2. "addon" notes (shown in blue in the RIGHT margin): point at a stretch of lines and offer 1-3 concrete things a student could ADD ON TOP to take that point further — a report or committee, a datum, a Supreme Court case, a scheme, a real example, a quote. Frame it as going further ("Enrich with", "Go further with", "Pair it with"), never as a gap. Every add-on must be real and verifiable; if unsure of a figure, name the source without a number.

QUESTION
Subject: ${subject}
Topic: ${topic}
Question: ${questionText || '(read it from the page)'}${marks ? `\nMarks: ${marks}` : ''}
Topper: ${topper}

POSITIONS
For every note give "page" (1-based within THIS PDF) and "box_2d" = [ymin, xmin, ymax, xmax] on a 0-1000 scale of that page, tightly around the handwritten lines the note is about (a line, a numbered point, a heading, a diagram). Several consecutive lines are fine — the viewer draws a bracket over that vertical span. Do not cover the whole page with one note.

Return ONE JSON object, no markdown fences, exactly:
{
  "notes": [
    { "page": 1, "kind": "works", "box_2d": [120, 60, 210, 940], "title": "technique", "text": "one line", "points": [] },
    { "page": 1, "kind": "addon", "box_2d": [300, 60, 380, 940], "title": "Enrich with", "text": "optional one line", "points": ["2nd ARC 4th Report on Ethics", "E. Sreedharan's punctuality"] }
  ],
  "takeaways": {
    "techniques": ["3-6 techniques from THIS copy a student should copy, each <= 12 words"],
    "enrichment": ["3-6 reports / cases / data / quotes that enrich this answer further"],
    "keywords": ["6-12 high-value terms the topper used or that fit the theme"]
  }
}

Rules:
- Per page: 2-5 notes, a mix of "works" and "addon". Spread them down the page; avoid overlapping boxes.
- Respectful, encouraging tone. Forbidden words: mistake, missing, missed, lacks, weak, vague, should have, could have, failed, wrong, incorrect, poor, forgot, generic.
- Read handwriting carefully; never invent what the topper wrote.
`.trim();

/** Fetch + parse a topic's compendium PDF from R2 (pdf-lib document). */
export const loadTopicPdf = async (doc) => {
  const obj = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: doc.pdfKey.replace('r2://', '') })
  );
  return PDFDocument.load(Buffer.from(await obj.Body.transformToByteArray()));
};

const topperLabel = (a) =>
  `${a.name}${a.rank ? ` (AIR ${a.rank}${a.year ? `, ${a.year}` : ''})` : ''}${a.marks ? `, ${a.marks} marks` : ''}`;

/**
 * Generate (but do NOT save) the enhancement layer for one answer.
 * @returns {Promise<{ notes, takeaways, aiModel, generatedAt }>} notes use ABSOLUTE page numbers
 * @param  {object} [opts.srcDoc] the topic PDF from loadTopicPdf(doc) — pass it when doing
 *                                 several answers of one topic so R2 is hit once
 * @throws  {Error} with .code 'NO_PDF' | 'NO_ANSWER'
 */
export const generateAnswerEnhancement = async (doc, question, answer, { srcDoc: preloaded } = {}) => {
  if (!doc.pdfKey?.startsWith('r2://')) {
    const e = new Error('This topic has no source PDF');
    e.code = 'NO_PDF';
    throw e;
  }
  if (!answer || !(answer.startPage >= 1) || !(answer.endPage >= answer.startPage)) {
    const e = new Error('This answer has no valid page range');
    e.code = 'NO_ANSWER';
    throw e;
  }

  const srcDoc = preloaded || (await loadTopicPdf(doc));
  const lo = Math.max(1, answer.startPage);
  const hi = Math.min(srcDoc.getPageCount(), answer.endPage);
  const pdfBase64 = await makeChunkPdfBase64(srcDoc, lo - 1, hi - 1);

  const prompt = buildPrompt({
    subject: doc.subject,
    topic: doc.topic,
    questionText: question.questionText,
    marks: question.marks,
    topper: topperLabel(answer),
    pageCount: hi - lo + 1,
  });

  const parsed = (await runJsonExtraction({ prompt, pdfBase64, maxOutputTokens: MAX_OUTPUT_TOKENS })) || {};
  // Model pages are 1-based within the slice → shift to absolute topic-PDF pages.
  const notes = capPerPage(
    asArr(parsed.notes).map((n) => shapeNote(n, { pageOffset: lo - 1, lo, hi })).filter(Boolean)
  );

  return {
    notes,
    takeaways: shapeTakeaways(parsed.takeaways),
    aiModel: getActiveModelLabel(),
    generatedAt: new Date(),
  };
};
