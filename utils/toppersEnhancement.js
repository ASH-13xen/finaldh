// ============================================================================
// toppersEnhancement.js — generate the margin "enhancement layer" for ONE
// topper's answer copy
// ----------------------------------------------------------------------------
// Shared by:
//   • controllers/toppersEnhancementController.js (POST …/answers/:aidx/enhance)
//   • scripts/generate_toppers_enhancements.mjs   (bulk run)
//
// These are toppers' copies: improvements are allowed but always worded as an
// upgrade ("Can be made stronger by…"), never as a fault — no grading, no
// "mistake / wrong / missed". Two kinds of note:
//   • works — what the topper did well (incl. diagrams, spacing) + how to reuse it
//   • addon — how to make the point stronger + examples / cases / data + a diagram idea
// plus a Takeaways card (techniques, alternate intro / conclusion with keywords). Each note is anchored to a vertical span of a page
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

// Harsh words that turn a constructive suggestion into a critique of the topper.
// "Can be made stronger by / could add" is fine; these are not. The prompt forbids
// them; this catches any that slip through so the admin sees them before publishing.
// Mirrored in finaldh-frontend/src/sections/AdminToppersEnhancements.jsx.
const CRITIQUE_RE = /\b(mistake|mistakes|missing|missed|misses|lacks?|lacking|weak|weakness|failed|fails|error|errors|wrong|incorrect|poor|poorly|forgot|ignored|shallow|superficial|careless|sloppy|should have)\b/i;

/** Every note / takeaway line that reads like a critique, for the admin to fix. */
export const findToneIssues = (enh) => {
  const issues = [];
  for (const n of asArr(enh?.notes)) {
    for (const s of [n.title, n.text, n.use, n.diagram, ...asArr(n.points)]) {
      const m = asStr(s).match(CRITIQUE_RE);
      if (m) issues.push({ noteId: n._id ? String(n._id) : null, page: n.page, word: m[0], text: asStr(s) });
    }
  }
  const t = enh?.takeaways || {};
  for (const s of [...asArr(t.techniques), ...asArr(t.enrichment), ...asArr(t.presentation), t.altIntro?.text, t.altConclusion?.text]) {
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
  const use = kind === 'works' ? asStr(n?.use).slice(0, 300) : '';
  const points = kind === 'addon' ? asStrArr(n?.points).slice(0, 3).map((p) => p.slice(0, 200)) : [];
  const diagram = kind === 'addon' ? asStr(n?.diagram).slice(0, 300) : '';
  if (!title && !text && !points.length && !diagram) return null;

  return { page, kind, yFrom, yTo, title, text, use, points, diagram, ...(n?._id ? { _id: n._id } : {}) };
};

const shapeAlt = (a) => ({
  text: asStr(a?.text).slice(0, 1200),
  keywords: asStrArr(a?.keywords).slice(0, 10).map((k) => k.slice(0, 60)),
});

export const shapeTakeaways = (t = {}) => ({
  techniques: asStrArr(t.techniques).slice(0, 8),
  enrichment: asStrArr(t.enrichment).slice(0, 8),
  keywords: asStrArr(t.keywords).slice(0, 15),
  presentation: asStrArr(t.presentation).slice(0, 6),
  altIntro: shapeAlt(t.altIntro),
  altConclusion: shapeAlt(t.altConclusion),
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

This is a topper's copy and students study it to learn. You may suggest how it can be made even stronger, but always as an upgrade, never as a fault: no grading, no "mistake", "wrong", "missed", "missing", "weak" or "should have". Write "Can be made stronger by…", "Could add…", "Go further with…".

1. "works" notes (shown in GREEN in the LEFT margin) — what the topper has done well:
   - title = the technique (<= 8 words), e.g. "Opens with a thinker's definition", "Heading mirrors the question's demand", "Every point carries an example", "Diagram compresses 5 points", "Conclusion ties back to the Constitution".
   - text = one line on why it earns marks.
   - use = one line on how a student can replicate it in their own answer ("Use this when…", "In your answer, …").
   - Also look at PRESENTATION: if there is a diagram / map / flowchart / table, put a works note on it (what it shows, why it helps, where in an answer to place such a diagram). Notice spacing, headings, underlining and use of the page, and note it where it stands out.
2. "addon" notes (shown in BLUE in the RIGHT margin) — what can be done better on top of this:
   - title = a short heading, e.g. "Make it stronger", "Enrich with", "Add a diagram".
   - text = one line on how this part can be made stronger (sharper heading, quantify the claim, add a counter-view, link to the question's keyword…), worded as an upgrade.
   - points = 1-3 concrete additions: an example, a Supreme Court case / case law, a datum, a fact, a report or committee, a scheme, a quote. Every add-on must be real and verifiable; if unsure of a figure, name the source without a number.
   - diagram = optional: a diagram the student could draw here, described in words (e.g. "Flowchart: Monsoon failure → crop loss → rural distress → migration"). Leave "" if none fits.

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
    { "page": 1, "kind": "works", "box_2d": [120, 60, 210, 940], "title": "technique", "text": "why it works", "use": "how to reuse it", "points": [], "diagram": "" },
    { "page": 1, "kind": "addon", "box_2d": [300, 60, 380, 940], "title": "Make it stronger", "text": "Can be made stronger by quantifying the impact", "use": "", "points": ["2nd ARC 4th Report on Ethics", "E. Sreedharan's punctuality"], "diagram": "Flowchart: A → B → C" }
  ],
  "takeaways": {
    "techniques": ["3-6 techniques from THIS copy a student should copy, each <= 12 words"],
    "enrichment": ["3-6 reports / cases / data / quotes that enrich this answer further"],
    "altIntro": { "text": "an alternate introduction, 40-70 words, in exam-ready language", "keywords": ["3-6 keywords / jargon used in it"] },
    "altConclusion": { "text": "an alternate conclusion, 30-60 words, forward-looking, in exam-ready language", "keywords": ["3-6 keywords / jargon used in it"] },
    "keywords": ["6-12 high-value terms the topper used or that fit the theme"]
  }
}

Rules:
- Per page: 2-5 notes, a mix of "works" and "addon". Spread them down the page; avoid overlapping boxes.
- The alternate intro / conclusion must offer a DIFFERENT approach from the topper's own (e.g. data-led, constitutional, thinker's quote, recent-event hook), answer this exact question, and use the listed keywords verbatim.
- Respectful, encouraging tone. Forbidden words: mistake, missing, missed, lacks, weak, should have, failed, wrong, incorrect, poor, forgot, careless.
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
