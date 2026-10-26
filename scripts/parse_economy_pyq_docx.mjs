#!/usr/bin/env node
// Parse the Economy PYQ compilation (Word file, "Section N | Title" + numbered MCQs) into the
// Question Bank import shape (utils/bankImport.js).
//
//   node scripts/parse_economy_pyq_docx.mjs --file "ss/Economy_PYQ_Questions_1995-2026 (1).docx" --out data/economy_pyq.json
//
// Each question in the docx looks like:
//   1.1    (2024)     [Conceptual]
//   With reference to ... consider the following pairs:
//   1. Storage of agricultural produce - Secondary
//   How many of the pairs given above are correctly matched?
//   (a) Only one
//   (b) Only two  ✓
//   Answer: (b) Only two
//
// `source_ref` ("econ-pyq:1.1") is the question's stable key: the topic placements
// (scripts/economy_pyq_placements.mjs) are exported and re-applied by it, so a re-import or a
// fresh database keeps them.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = val('file');
const out = val('out');
if (!file || !out) {
  console.error('usage: parse_economy_pyq_docx.mjs --file <compilation.docx> --out <rows.json>');
  process.exit(1);
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
const lines = (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
  .map((p) => decode((p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')))
  .map((l) => l.replace(/ /g, ' ').trim())
  .filter(Boolean);

const SECTION_RE = /^Section\s+(\d+)\s*\|\s*(.+)$/;
const HEAD_RE = /^(\d+)\.(\d+)\s+\((\d{4})\)\s*(?:\[(\w+)\])?/;
const OPTION_RE = /^\(([a-d])\)\s*(.*)$/;
const ANSWER_RE = /^Answer:\s*\(([a-d])\)/i;
const TICK_RE = /\s*✓\s*$/;

const rows = [];
const warnings = [];
let section = null;
let q = null;

const finish = () => {
  if (!q) return;
  const ref = `${q.sec}.${q.n}`;
  const opts = Object.keys(q.options);
  if (opts.join('') !== 'abcd') warnings.push(`${ref}: options [${opts.join(',')}]`);
  if (q.tick && q.answer && q.tick !== q.answer) warnings.push(`${ref}: ✓ on (${q.tick}) but Answer: (${q.answer})`);
  const tick = q.answer || q.tick;
  if (!tick) warnings.push(`${ref}: no answer`);
  const [stem, ...rest] = q.body;
  rows.push({
    source_ref: `econ-pyq:${ref}`,
    exam_source: `UPSC CSE ${q.year}`,
    topic: q.topic,
    type: q.type,
    question_text: stem || '',
    statements: rest,
    options: q.options,
    tick_answer: tick,
  });
  q = null;
};

for (const line of lines) {
  const s = line.match(SECTION_RE);
  if (s) { finish(); section = s[2].trim(); continue; }
  const h = line.match(HEAD_RE);
  if (h && section) {
    finish();
    q = { sec: h[1], n: h[2], year: h[3], type: h[4] || '', topic: section, body: [], options: {}, tick: null, answer: null };
    continue;
  }
  if (!q) continue;
  const a = line.match(ANSWER_RE);
  if (a) { q.answer = a[1].toLowerCase(); continue; }
  const o = line.match(OPTION_RE);
  if (o) {
    const k = o[1].toLowerCase();
    if (TICK_RE.test(o[2])) q.tick = k;
    q.options[k] = o[2].replace(TICK_RE, '').trim();
    continue;
  }
  // Stem, numbered statements and the closing "Which of the above…" line, in order.
  if (!Object.keys(q.options).length) q.body.push(line);
}
finish();

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 1));

const byTopic = {};
for (const r of rows) byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;
console.log(`${rows.length} questions → ${out}`);
for (const [t, n] of Object.entries(byTopic)) console.log(`  ${String(n).padStart(3)}  ${t}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
