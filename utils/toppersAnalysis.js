// ============================================================================
// toppersAnalysis.js — generate the per-question AI analysis for a Toppers Copy
// ----------------------------------------------------------------------------
// Shared by:
//   • controllers/toppersCopyController.js  (POST /admin/:id/questions/:qid/analyze)
//   • scripts/generate_toppers_analysis.mjs (bulk "analyze everything" run)
//
// Given one ToppersCopy doc and one of its questions, it slices that question's
// answer pages out of the compendium PDF on R2 and asks the active AI provider
// (Gemini or Claude, see aiProvider.js) for a three-block study breakdown:
//   1. a fresh ~250-word MODEL ANSWER (may use outside data / reports / news)
//   2. concrete IMPROVEMENTS to what the toppers actually wrote (copy-grounded)
//   3. transferable LEARNINGS
//
// It does NOT persist anything — the caller assigns the result to
// question.aiAnalysis and saves.
// ============================================================================

import { PDFDocument } from 'pdf-lib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import { makeChunkPdfBase64 } from './pdfChunk.js';
import { runJsonExtraction, getActiveModelLabel } from './aiProvider.js';

// Bigger than the old annotation prompt — three blocks of structured output.
const MAX_OUTPUT_TOKENS = 12000;

// ---------------------------------------------------------------------------
// Coercion helpers — tolerate missing / malformed fields from the model.
// ---------------------------------------------------------------------------
const asStr = (v) => String(v ?? '').trim();
const asArr = (v) => (Array.isArray(v) ? v : []);
const asStrArr = (v) => asArr(v).map(asStr).filter(Boolean);
const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const oneOf = (v, allowed, fallback) => (allowed.includes(asStr(v).toLowerCase()) ? asStr(v).toLowerCase() : fallback);
const clamp1 = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

// Coerce the model's `diagram` object down to just the fields its `kind` uses.
export const shapeDiagram = (dia = {}) => {
  const kind = oneOf(dia.kind, ['flow', 'table', 'chart', 'quadrant', 'pyramid', 'timeline'], 'flow');
  const base = {
    kind,
    title: asStr(dia.title),
    howToDraw: asStr(dia.howToDraw || dia.how_to_draw || dia.description),
    keywords: asStrArr(dia.keywords),
  };

  if (kind === 'table') {
    return {
      ...base,
      columns: asStrArr(dia.columns),
      rows: asArr(dia.rows)
        .map((r) => ({ cells: asStrArr(r?.cells || r) }))
        .filter((r) => r.cells.length),
    };
  }
  if (kind === 'chart') {
    return {
      ...base,
      chartType: oneOf(dia.chartType, ['bar', 'pie', 'line'], 'bar'),
      unit: asStr(dia.unit),
      source: asStr(dia.source),
      series: asArr(dia.series)
        .map((s) => ({
          label: asStr(s?.label),
          points: asArr(s?.points)
            .map((p) => ({ label: asStr(p?.label), value: Number(p?.value) || 0 }))
            .filter((p) => p.label),
        }))
        .filter((s) => s.points.length),
    };
  }
  if (kind === 'quadrant') {
    return {
      ...base,
      xAxis: { low: asStr(dia.xAxis?.low), high: asStr(dia.xAxis?.high) },
      yAxis: { low: asStr(dia.yAxis?.low), high: asStr(dia.yAxis?.high) },
      quadrantItems: asArr(dia.quadrantItems)
        .map((it) => ({ label: asStr(it?.label), x: clamp1(it?.x), y: clamp1(it?.y) }))
        .filter((it) => it.label),
    };
  }
  if (kind === 'pyramid') {
    return { ...base, levels: asStrArr(dia.levels) };
  }
  if (kind === 'timeline') {
    return {
      ...base,
      events: asArr(dia.events)
        .map((e) => ({ when: asStr(e?.when), label: asStr(e?.label) }))
        .filter((e) => e.when || e.label),
    };
  }
  // flow (default)
  return {
    ...base,
    layout: oneOf(dia.layout, ['flow-vertical', 'flow-horizontal', 'cycle', 'hub-spoke'], 'flow-vertical'),
    nodes: asArr(dia.nodes)
      .map((n) => ({
        id: asStr(n.id),
        label: asStr(n.label),
        shape: oneOf(n.shape, ['box', 'circle', 'pill', 'diamond'], 'box'),
      }))
      .filter((n) => n.id && n.label),
    edges: asArr(dia.edges)
      .map((e) => ({ from: asStr(e.from), to: asStr(e.to), label: asStr(e.label) }))
      .filter((e) => e.from && e.to),
    mermaid: asStr(dia.mermaid),
  };
};

/** Coerce the model's JSON into the aiAnalysis subdoc shape. */
export const shapeAnalysis = (parsed) => {
  const ma = parsed.modelAnswer || {};
  const intro = ma.introduction || {};
  const wf = ma.wayForward || ma.wayforward || {};
  const concl = ma.conclusion || {};

  return {
    modelAnswer: {
      introduction: {
        text: asStr(intro.text),
        wordCount: asNum(intro.wordCount),
        keywords: asStrArr(intro.keywords),
      },
      body: asArr(ma.body).map((part) => ({
        part: asStr(part.part || part.title),
        points: asArr(part.points).map((p) => ({
          text: asStr(p.text),
          tag: asStr(p.tag),
          unconventionalBecause: asStr(p.unconventionalBecause || p.unconventional_because),
        })).filter((p) => p.text),
      })).filter((part) => part.points.length),
      wayForward: {
        text: asStr(wf.text),
        wordCount: asNum(wf.wordCount),
        sources: asStrArr(wf.sources),
      },
      conclusion: {
        text: asStr(concl.text),
        wordCount: asNum(concl.wordCount),
        quote: asStr(concl.quote),
      },
      totalWordCount: asNum(ma.totalWordCount),
    },
    diagram: shapeDiagram(parsed.diagram || {}),
    answerImprovements: asArr(parsed.answerImprovements).map((x) => ({
      area: asStr(x.area),
      observation: asStr(x.observation),
      fix: asStr(x.fix || x.suggestion),
      priority: asStr(x.priority).toLowerCase(),
    })).filter((x) => x.observation || x.fix),
    learnings: asArr(parsed.learnings).map((x) => ({
      lesson: asStr(x.lesson),
      seenIn: asStr(x.seenIn || x.seen_in),
      applyElsewhere: asStr(x.applyElsewhere || x.apply_elsewhere),
    })).filter((x) => x.lesson),
    keywords: asStrArr(parsed.keywords),
    aiModel: getActiveModelLabel(),
    generatedAt: new Date(),
  };
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const buildPrompt = ({ subject, topic, question, answerLines }) => `
You are a UPSC Mains answer coach. You are given ONE question and a SMALL SET (usually 2-3) of hand-picked topper copies answering it, attached as PDF pages. Produce THREE things:

A. A fresh ~250-word MODEL ANSWER that is sharper, more current and more original than the copies.
B. Concrete IMPROVEMENTS to what the toppers actually wrote.
C. LEARNINGS a student can carry to OTHER questions.

For A (the model answer) you MAY bring in outside material — reports, committee recommendations, data, recent news, schemes, case studies, Supreme Court judgments, thinkers. Prefer fresh, specific, verifiable references over vague claims. Deliberately AVOID the common textbook points every aspirant writes; every body point must be one most candidates would miss.

For B and C, work ONLY from what is actually on the topper pages — do not critique things they were not asked to do, and do not invent what they wrote. If handwriting is unclear, transcribe your best reading; never fabricate a name or figure.

QUESTION
Subject: ${subject}
Topic: ${topic}
Question: ${question.questionText || '(read it from the first page of the PDF)'}
${question.marks ? `Marks: ${question.marks}` : ''}

TOPPER ANSWERS IN THE ATTACHED PDF (page numbers are within THIS PDF, which starts at page 1):
${answerLines}

MODEL ANSWER STRUCTURE (total ~250 words — respect each budget, approximate counts are fine):
- introduction: 30-40 words. Open with a data point, report finding or recent development on the question's theme. Load it with the subject's terminology / jargon. No throat-clearing.
- body: ~150 words, as bullet points, in EXACTLY 2 parts. Give each part a short label reflecting the question's demand (e.g. dimensions / challenges, for / against, causes / consequences). Each bullet = a claim fused with its evidence (report, datum, case study, example, scheme, judgment). Points must be unique and unconventional.
- wayForward: 15-20 words. Name specific recommendations from reports / committees, using the question's theme keywords.
- conclusion: ~30 words. Optimistic, future-facing. Use a short quote or a vision-phrase / piece of jargon if it fits naturally.

Also give ONE diagram for the answer sheet. FIRST decide which FORM best compresses THIS question's content — do NOT default to a flowchart, and across a set of questions the forms should VARY. Choose exactly one "kind":
  • "flow"     — a process, causal chain, cycle, or hub of relationships (boxes/circles + arrows)
  • "table"    — a comparison of 2+ things across shared parameters (the sharpest tool for "compare / distinguish / examine both sides")
  • "chart"    — ONLY when you have REAL, citable numbers (bar / pie / line). Put the dataset in "source". If you are not sure of the figures, DO NOT pick this — never invent data.
  • "quadrant" — placing items against two axes (e.g. high/low impact × short/long term)
  • "pyramid"  — a hierarchy or staged structure (levels of governance, a priority order)
  • "timeline" — how something evolved across years / phases
Keep it small enough to reproduce by hand in ~20 seconds. Every label is a theme keyword.

Return ONE JSON object, no markdown fences, EXACTLY this shape:

{
  "modelAnswer": {
    "introduction": { "text": "...", "wordCount": 0, "keywords": ["3-6 theme terms used in the intro"] },
    "body": [
      { "part": "short label for part 1", "points": [
        { "text": "claim fused with its evidence", "tag": "report | data | case-study | scheme | judgment | example | thinker", "unconventionalBecause": "one line: why most aspirants miss this" }
      ] },
      { "part": "short label for part 2", "points": [ { "text": "...", "tag": "...", "unconventionalBecause": "..." } ] }
    ],
    "wayForward": { "text": "...", "wordCount": 0, "sources": ["committee / report names cited"] },
    "conclusion": { "text": "...", "wordCount": 0, "quote": "the quote used, else \\"\\"" },
    "totalWordCount": 0
  },
  "diagram": {
    "kind": "flow | table | chart | quadrant | pyramid | timeline",
    "title": "short caption for the diagram",
    "howToDraw": "2-3 sentences to reproduce it under exam pressure",
    "keywords": ["every label used, in draw order"],

    "layout": "(flow only) flow-vertical | flow-horizontal | cycle | hub-spoke",
    "nodes": [ { "id": "n1", "label": "keyword, <= 4 words", "shape": "box | circle | pill | diamond" } ],
    "edges": [ { "from": "n1", "to": "n2", "label": "1-2 word link, else \\"\\"" } ],
    "mermaid": "(flow only) the SAME graph as valid Mermaid, else \\"\\"",

    "columns": ["(table only) header row; the FIRST column is the row label, e.g. \\"Aspect\\""],
    "rows": [ { "cells": ["row label", "value in col 2", "value in col 3"] } ],

    "chartType": "(chart only) bar | pie | line",
    "unit": "(chart only) % | ₹ crore | GW | ...",
    "source": "(chart only, REQUIRED) the report / dataset the numbers come from",
    "series": [ { "label": "series name (\\"\\" if single)", "points": [ { "label": "category / year", "value": 0 } ] } ],

    "xAxis": { "low": "(quadrant only) left-end label", "high": "right-end label" },
    "yAxis": { "low": "(quadrant only) bottom-end label", "high": "top-end label" },
    "quadrantItems": [ { "label": "keyword", "x": -1, "y": 1 } ],

    "levels": ["(pyramid only) top level first, then each level downward"],

    "events": [ { "when": "(timeline only) year / phase", "label": "what changed" } ]
  },
  "answerImprovements": [
    { "area": "intro | structure | content | evidence | diagram | conclusion | presentation",
      "observation": "what the copies did or missed (name the topper if it is specific to one)",
      "fix": "the specific, actionable change",
      "priority": "high | medium | low" }
  ],
  "learnings": [
    { "lesson": "transferable technique or insight",
      "seenIn": "what in the copy demonstrates it",
      "applyElsewhere": "another question type where this helps" }
  ],
  "keywords": ["8-15 high-value terms / names / reports / data points for this question"]
}

Rules:
- Model answer body: EXACTLY 2 parts. Every point unconventional. Every point carries evidence.
- diagram: fill ONLY the fields for the chosen "kind"; leave the others out. "keywords" lists exactly the labels shown. Sizes: flow 4-7 nodes ("edges" reference node ids only; "hub-spoke" lists the centre node FIRST; "cycle" lists nodes in loop order with NO closing edge); table 2-4 columns and 2-5 rows (every row has the same cell count as "columns"); chart 2-6 points per series and a real "source"; quadrant 3-6 items with x and y each between -1 and 1; pyramid 3-5 levels; timeline 3-6 events.
- Prefer "table" for any "compare / distinguish / both sides" question. Only use "chart" with figures you are confident are real.
- answerImprovements: 4-7 items, ordered by priority (high first).
- learnings: 3-6 items.
- No fabricated report names, data or quotes. If unsure of an exact figure, describe it qualitatively rather than inventing a number.
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate (but do NOT save) the AI analysis for one question of a ToppersCopy.
 * @param {import('mongoose').Document} doc       a ToppersCopy document
 * @param {object} question                        one entry of doc.questions
 * @returns {Promise<object>}                       shaped aiAnalysis subdoc
 * @throws  {Error}                                 with .code 'NO_PDF' | 'NO_ANSWERS' for caller-friendly 400s
 */
export const generateQuestionAnalysis = async (doc, question) => {
  if (!doc.pdfKey?.startsWith('r2://')) {
    const e = new Error('This topic has no source PDF to analyze');
    e.code = 'NO_PDF';
    throw e;
  }
  if (!question.answers?.length) {
    const e = new Error('This question has no answer page ranges to analyze');
    e.code = 'NO_ANSWERS';
    throw e;
  }

  const r2Key = doc.pdfKey.replace('r2://', '');
  const obj = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key })
  );
  const pdfBuf = Buffer.from(await obj.Body.transformToByteArray());
  const srcDoc = await PDFDocument.load(pdfBuf);
  const pageCount = srcDoc.getPageCount();

  const spanStart = Math.max(1, Math.min(...question.answers.map((a) => a.startPage)));
  const spanEnd = Math.min(pageCount, Math.max(...question.answers.map((a) => a.endPage)));
  const pdfBase64 = await makeChunkPdfBase64(srcDoc, spanStart - 1, spanEnd - 1);

  // Answer page ranges re-based to the sliced PDF (page 1 == spanStart).
  const answerLines = question.answers
    .map((a) => {
      const s = a.startPage - spanStart + 1;
      const e = a.endPage - spanStart + 1;
      const who = `${a.name}${a.rank ? ` (AIR ${a.rank}${a.year ? `, ${a.year}` : ''})` : ''}${a.marks ? `, ${a.marks} marks` : ''}`;
      const note = a.curatorNote ? `\n   Curator note: ${a.curatorNote}` : '';
      return `- ${who} — pages ${s}-${e}.${note}`;
    })
    .join('\n');

  const prompt = buildPrompt({
    subject: doc.subject,
    topic: doc.topic,
    question,
    answerLines,
  });

  const parsed = await runJsonExtraction({ prompt, pdfBase64, maxOutputTokens: MAX_OUTPUT_TOKENS });
  return shapeAnalysis(parsed || {});
};
