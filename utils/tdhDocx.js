import { readZipEntry, decode } from './docxZip.js';

// Reads the two Word files of PYQ & TDH Research. No AI.
//
// Questions file ("…_Questions.docx")              Solutions file ("…_Solutions.docx")
//   Section 1 | Economic Growth                      Section 1 | Economic Growth
//   1.1    (2024)    [Conceptual]                    1.1  Sectors of the Economy - …   (2024)
//   With reference to … consider the pairs:            How economic activities …      ← list level 0 = heading
//   1. Storage of agricultural produce - Secondary       An economic activity is …    ← list level 1 = point
//   How many of the pairs …                          TDH Research   1.1
//   (a) Only one                                       Sectoral shares in India
//   (b) Only two  ✓                                      Services contribute …
//   Answer: (b) Only two                               Additional note                ← becomes `note`
//
// The [Type] tag, the ✓ and the "Answer:" line are optional — a file without them still imports
// and the admin fills the gaps. Questions can also come as the Question Bank JSON
// (data/economy_pyq.json: source_ref "econ-pyq:1.1", topic, type, statements, options, tick_answer).

const SECTION_RE = /^Section\s+(\d+)\s*\|\s*(.+)$/;
const QHEAD_RE = /^(\d+)\.(\d+)\s+\((\d{4})\)\s*(?:\[(\w+)\])?/;
const SHEAD_RE = /^(\d+)\.(\d+)\s+(.+?)\s*\((\d{4})\)\s*$/;
const TDH_RE = /^TDH Research\s+(\d+\.\d+)\s*$/i;
const NOTE_RE = /^additional notes?:?$/i;
const OPTION_RE = /^\(([a-d])\)\s*(.*)$/i;
const ANSWER_RE = /^Answer:\s*\(([a-d])\)/i;
const TICK_RE = /\s*✓\s*$/;

const TYPES = { factual: 'Factual', conceptual: 'Conceptual' };
export const normType = (v) => TYPES[String(v || '').trim().toLowerCase()] || '';

const BOLD_RE = /<w:b\/>|<w:b w:val="(?:1|true|on)"\/>/;

// Runs → text, bold runs wrapped in **…** (spaces kept outside the markers).
const runText = (p) => {
  const parts = [];
  for (const r of p.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const t = decode([...r[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
    if (!t) continue;
    const rPr = r[1].match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '';
    const bold = BOLD_RE.test(rPr);
    const last = parts[parts.length - 1];
    if (last && last.bold === bold) last.t += t; else parts.push({ t, bold });
  }
  const plain = parts.map((x) => x.t).join('').replace(/\s+/g, ' ').trim();
  const allBold = parts.length > 0 && parts.every((x) => x.bold || !x.t.trim());
  const marked = parts.map(({ t, bold }) => {
    if (!bold || allBold || !t.trim()) return t;
    const [, lead, core, tail] = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return `${lead}**${core}**${tail}`;
  }).join('').replace(/\s+/g, ' ').replace(/\*\*\*\*/g, '').trim();
  return { plain, marked };
};

const readParagraphs = (buffer) => {
  const xml = readZipEntry(buffer, 'word/document.xml');
  const body = xml.slice(xml.indexOf('<w:body'));
  const out = [];
  for (const m of body.matchAll(/<w:p(?:\s[^>]*[^/])?>[\s\S]*?<\/w:p>/g)) {
    const { plain, marked } = runText(m[0]);
    if (!plain) continue;
    const ilvl = m[0].match(/<w:numPr>[\s\S]*?<w:ilvl w:val="(\d)"/)?.[1];
    out.push({ text: plain.replace(/ /g, ' '), marked, level: ilvl == null ? null : Number(ilvl) });
  }
  return out;
};

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Questions file (.docx) → { sections, questions, warnings }. */
export const parseQuestionsDocx = (buffer) => {
  const paras = readParagraphs(buffer);
  const sections = [];
  const questions = [];
  const warnings = [];
  let section = null;
  let q = null;

  const finish = () => {
    if (!q) return;
    const keys = q.options.map((o) => o.key).join('');
    if (keys !== 'abcd') warnings.push(`${q.ref}: options [${keys.split('').join(',')}]`);
    if (q.tick && q.answerLine && q.tick !== q.answerLine) warnings.push(`${q.ref}: ✓ on (${q.tick}) but Answer: (${q.answerLine})`);
    const [stem = '', ...lines] = q.body;
    questions.push({
      ref: q.ref, section: q.section, n: q.n, year: q.year, examSource: `UPSC CSE ${q.year}`,
      type: q.type, questionText: stem, lines, options: q.options, answer: q.answerLine || q.tick || '',
    });
    q = null;
  };

  for (const { text } of paras) {
    const s = text.match(SECTION_RE);
    if (s) {
      finish();
      section = { number: Number(s[1]), title: s[2].trim() };
      if (!sections.some((x) => x.number === section.number)) sections.push(section);
      continue;
    }
    const h = text.match(QHEAD_RE);
    if (h && section) {
      finish();
      q = {
        ref: `${Number(h[1])}.${Number(h[2])}`, section: Number(h[1]), n: Number(h[2]), year: h[3],
        type: normType(h[4]), body: [], options: [], tick: '', answerLine: '',
      };
      continue;
    }
    if (!q) continue;
    const a = text.match(ANSWER_RE);
    if (a) { q.answerLine = a[1].toLowerCase(); continue; }
    const o = text.match(OPTION_RE);
    if (o) {
      const key = o[1].toLowerCase();
      if (TICK_RE.test(o[2])) q.tick = key;
      if (!q.options.some((x) => x.key === key)) q.options.push({ key, text: o[2].replace(TICK_RE, '').trim() });
      continue;
    }
    if (!q.options.length) q.body.push(text);
  }
  finish();
  if (!questions.length) throw bad('No questions found. Expected "Section 1 | Title" then numbered questions like "1.1   (2024)".');
  return { sections, questions, warnings };
};

/** Question Bank JSON rows → same shape as parseQuestionsDocx. */
export const parseQuestionsJson = (buffer) => {
  let rows;
  try { rows = JSON.parse(buffer.toString('utf8')); } catch { throw bad('The JSON file could not be read'); }
  if (!Array.isArray(rows)) rows = rows?.questions;
  if (!Array.isArray(rows) || !rows.length) throw bad('The JSON file has no questions');
  const sections = [];
  const questions = [];
  const warnings = [];
  for (const r of rows) {
    const ref = String(r.source_ref || r.ref || '').split(':').pop().trim();
    const m = ref.match(/^(\d+)\.(\d+)$/);
    if (!m) { warnings.push(`skipped a row without a "1.1"-style source_ref`); continue; }
    const section = Number(m[1]);
    if (!sections.some((x) => x.number === section)) sections.push({ number: section, title: String(r.topic || `Section ${section}`).trim() });
    const opts = r.options && !Array.isArray(r.options)
      ? Object.entries(r.options).map(([key, text]) => ({ key: key.toLowerCase(), text: String(text || '').trim() }))
      : (r.options || []).map((o) => ({ key: String(o.key).toLowerCase(), text: String(o.text || '').trim() }));
    const year = String(r.exam_source || '').match(/(\d{4})/)?.[1] || '';
    questions.push({
      ref: `${section}.${Number(m[2])}`, section, n: Number(m[2]), year,
      examSource: String(r.exam_source || (year ? `UPSC CSE ${year}` : '')).trim(),
      type: normType(r.type), questionText: String(r.question_text || '').trim(),
      lines: (r.statements || []).map((x) => String(x).trim()).filter(Boolean),
      options: opts.filter((o) => /^[a-d]$/.test(o.key)),
      answer: /^[a-d]$/i.test(r.tick_answer || '') ? r.tick_answer.toLowerCase() : '',
    });
  }
  if (!questions.length) throw bad('No questions with a "1.1"-style source_ref found in the JSON');
  return { sections, questions, warnings };
};

/** Solutions file (.docx) → { sections, solutions: { [ref]: { title, year, explanation, research, note } } }. */
export const parseSolutionsDocx = (buffer) => {
  const paras = readParagraphs(buffer);
  const sections = [];
  const solutions = {};
  let section = null;
  let cur = null;       // the solution being read
  let part = null;      // 'explanation' | 'research' | 'note'
  let block = null;

  const push = (text) => {
    if (!cur) return;
    if (part === 'note') { cur.note.push(text); return; }
    if (!block) { block = { heading: '', points: [] }; cur[part].push(block); }
    block.points.push(text);
  };

  for (const p of paras) {
    const s = p.text.match(SECTION_RE);
    if (s) {
      section = { number: Number(s[1]), title: s[2].trim() };
      if (!sections.some((x) => x.number === section.number)) sections.push(section);
      cur = null;
      continue;
    }
    if (!section) continue;
    const h = p.level == null && p.text.match(SHEAD_RE);
    if (h) {
      const ref = `${Number(h[1])}.${Number(h[2])}`;
      cur = { title: h[3].trim(), year: h[4], explanation: [], research: [], note: [] };
      solutions[ref] = cur;
      part = 'explanation';
      block = null;
      continue;
    }
    if (!cur) continue;
    if (TDH_RE.test(p.text)) { part = 'research'; block = null; continue; }
    if (p.level === 0) {
      if (part !== 'explanation' && NOTE_RE.test(p.text)) { part = 'note'; block = null; continue; }
      if (part === 'note') part = 'research';
      block = { heading: p.text, points: [] };
      cur[part].push(block);
      continue;
    }
    push(p.marked);
  }
  if (!Object.keys(solutions).length) throw bad('No solutions found. Expected "Section 1 | Title" then headings like "1.1  Title   (2024)".');
  return { sections, solutions };
};
