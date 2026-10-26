#!/usr/bin/env node
// Parse the Economy Master File PDF into structured themes → topics → bullets.
//
//   node scripts/parse_economy_master.mjs --file "<pdf>" --out economy_master.json [--pages 1-20]
//
// The PDF is a two-column, hand-formatted document (Forum part p1-51, Part B p52-108, Vision
// p109-144). Formatting carries meaning, so we keep it:
//   - text on a blue bar           -> topic heading ("7. Collateral-Free Liquidity Tool")
//   - "THEME - X" on a purple bar  -> theme heading
//   - bold runs                    -> key terms               span.b = 1
//   - cyan / green fills behind text -> highlights           span.hl = 'c' | 'g'
//   - ✅ / ❌ emoji (drawn as images) -> right / wrong marks   span.m = 'ok' | 'no'
// The emoji aren't in the text layer, so each page is rasterised with poppler's `pdftoppm`
// (must be on PATH) and the line strips are scanned for the emoji's green / red pixels.
//
// Output is reviewed, then loaded with scripts/import_economy_master.mjs.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { canonicalTheme, ECONOMY_THEMES } from '../utils/economyThemes.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), [])
);
if (!args.file) {
  console.error('usage: parse_economy_master.mjs --file <pdf> --out <json> [--pages 1-20]');
  process.exit(1);
}
const OUT = args.out || 'economy_master.json';
const DPI = 144;
const PX = DPI / 72;

const BULLET_RE = /^[●•➢❖➔→▪○◦■□►▶\uE000-\uF8FF]$/u;
const BULLET_START_RE = /^\s*([●•➢❖➔→▪○◦■□►▶\uE000-\uF8FF])\s*/u;
const NOISE_RE = /Disclaimer|prelims exclusive|t\.me\/|^\d+\s*\|\s*P\s*a\s*g\s*e|^\s*P\s*a\s*g\s*e\s*$|MASTER\s*FILE|^Contents$|\.{6,}/i;
const TEST_REF_RE = /^(?:[A-Z]{1,2}\s*[-‐–]\s*\d{1,3}|TEST\s*[-‐–]?\s*\d{1,2})$/;   // "F-12", "V- 21", "TEST-1"
const THEME_WRAP_RE = /^[A-Z&][A-Za-z &.,-]{2,40}$/;
const cleanTheme = (t) => t.replace(/\bTEST\s*[-‐–]?\s*\d+\b/gi, '').replace(/\s+/g, ' ').trim();
const THEME_RE = /^THEME\s*[-‐–:]?\s*(.*)$/i;
const TOPIC_RE = /^(\d{1,3})\s*(?:[.)]|\s[-‐–]\s?)\s*([A-Za-z0-9(“"'‘].*)$/;
const PYQ_RE = /\(\s*((?:CSE|CDS|CAPF|UPSC|NDA|EPFO|Prelims|IES|ESE)[^()]*?(?:19|20)\d{2}[^()]*?(?:\([^()]*\))?[^()]*)\)/gi;
const HIGHLIGHT = { '#00ff00': 'g', '#00ffff': 'c', '#ffff00': 'y' };

const hex = (c) => (typeof c === 'string' ? c.toLowerCase() : null);
const isBlueBar = (c) => {
  if (!c || c.length !== 7) return false;
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  return b > 150 && r < 120 && g < 170 && !HIGHLIGHT[c];
};

const sourceForPage = (p, header) => {
  if (/VISION/i.test(header)) return 'vision';
  if (/Forum/i.test(header)) return 'forum';
  if (/MASTER\s*FILE/i.test(header)) return 'partB';
  return null;
};

// ---------- raster: find ✅ / ❌ marks ----------
const readPpm = (file) => {
  const buf = fs.readFileSync(file);
  let off = 0;
  const parts = [];
  while (parts.length < 4) {
    let s = '';
    while (buf[off] === 0x23) while (buf[off++] !== 0x0a);   // comment line
    while (!/\s/.test(String.fromCharCode(buf[off]))) s += String.fromCharCode(buf[off++]);
    off++;
    if (s) parts.push(s);
  }
  const W = +parts[1], H = +parts[2];
  return { W, H, px: (x, y) => { const i = off + (y * W + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; } };
};
const isTickPx = ([r, g, b]) => r < 70 && g >= 140 && g <= 220 && b >= 50 && b <= 160 && g - b > 40;
const isCrossPx = ([r, g, b]) => r > 190 && g < 90 && b >= 30 && b <= 130;

// Returns [{ x (pt), kind }] for one text line strip.
const scanMarks = (img, pageH, x0, x1, baseline, size) => {
  const yTop = Math.max(0, Math.floor((pageH - baseline - size) * PX));
  const yBot = Math.min(img.H - 1, Math.ceil((pageH - baseline + size * 0.3) * PX));
  const out = [];
  let run = null;
  const flush = () => {
    if (run && run.end - run.start >= 6 && run.hits >= 18) out.push({ x: (run.start + run.end) / 2 / PX, kind: run.kind });
    run = null;
  };
  for (let x = Math.max(0, Math.floor(x0 * PX)); x <= Math.min(img.W - 1, Math.ceil(x1 * PX)); x++) {
    let t = 0, c = 0;
    for (let y = yTop; y <= yBot; y++) {
      const p = img.px(x, y);
      if (isTickPx(p)) t++; else if (isCrossPx(p)) c++;
    }
    const kind = t >= 3 ? 'ok' : c >= 3 ? 'no' : null;
    if (kind && run && run.kind === kind && x - run.end <= 4) { run.end = x; run.hits += t + c; }
    else if (kind) { flush(); run = { kind, start: x, end: x, hits: t + c }; }
    else if (run && x - run.end > 4) flush();
  }
  flush();
  return out;
};

const rasterise = (file, pageNo, dir) => {
  const prefix = path.join(dir, `p${pageNo}`);
  const r = spawnSync('pdftoppm', ['-f', String(pageNo), '-l', String(pageNo), '-r', String(DPI), '-singlefile', file, prefix]);
  if (r.status !== 0) throw new Error(`pdftoppm failed on page ${pageNo}: ${r.stderr}`);
  const img = readPpm(`${prefix}.ppm`);
  fs.unlinkSync(`${prefix}.ppm`);
  return img;
};

// ---------- vector: filled rectangles + their colour ----------
const OPS_NAME = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
const filledRects = (opList, pageW) => {
  const rects = [];
  let fill = null;
  const stack = [];   // q/Q restore the fill colour
  opList.fnArray.forEach((fn, i) => {
    const name = OPS_NAME[fn];
    const a = opList.argsArray[i];
    if (name === 'save') stack.push(fill);
    else if (name === 'restore') fill = stack.length ? stack.pop() : fill;
    else if (name === 'setFillRGBColor') fill = hex(a[0]);
    else if (name === 'constructPath') {
      const mm = a[2];
      if (!mm) return;
      const [x0, y0, x1, y1] = [mm[0], mm[1], mm[2], mm[3]];
      if (x1 - x0 < 2 || y1 - y0 < 4 || x1 - x0 > pageW - 20) return;
      if (!fill || fill === '#000000' || fill === '#ffffff') return;
      rects.push({ x0, y0, x1, y1, color: fill });
    }
  });
  return rects;
};
const rectAt = (rects, x, y, pred = () => true) =>
  rects.find((r) => pred(r.color) && x >= r.x0 - 1 && x <= r.x1 + 1 && y >= r.y0 - 1 && y <= r.y1 + 1);

// ---------- text ----------
const fontInfo = (page, fontName, cache) => {
  if (cache.has(fontName)) return cache.get(fontName);
  let bold = false;
  try {
    const f = page.commonObjs.get(fontName);
    bold = /bold|black|heavy|semibold/i.test(f?.name || '') || f?.bold === true;
  } catch { /* font not resolved */ }
  cache.set(fontName, bold);
  return bold;
};

const groupLines = (items) => {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2.5, it.size * 0.3));
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.x = l.items[0].x;
    l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
    l.size = Math.max(...l.items.map((i) => i.size));
    l.text = l.items.map((i) => i.str).join('').replace(/\s+/g, ' ').trim();
  }
  return lines.sort((a, b) => b.y - a.y);
};

const pushSpan = (spans, s) => {
  if (s.t === '' && !s.m) return;
  const last = spans[spans.length - 1];
  if (last && !s.m && !last.m && !!last.b === !!s.b && last.hl === s.hl) { last.t += s.t; return; }
  spans.push(s);
};

// Turn a line's items (+ marks found in the raster) into styled spans.
const lineSpans = (line, rects, marks) => {
  const spans = [];
  const pending = [...marks].sort((a, b) => a.x - b.x);
  let prevEnd = null;
  for (const it of line.items) {
    while (pending.length && pending[0].x < it.x + Math.min(it.w, 4)) {
      pushSpan(spans, { t: '', m: pending.shift().kind });
    }
    let t = it.str;
    // a visible gap between runs is a space the PDF didn't encode
    if (prevEnd != null && it.x - prevEnd > it.size * 0.2 && !/^\s/.test(t) && spans.length && !/\s$/.test(spans[spans.length - 1].t || ' ')) t = ' ' + t;
    prevEnd = it.x + it.w;
    // emoji that ARE in the text layer (Vision part uses them inline)
    const parts = t.split(/([✅❌✔✘✗✓])/u);
    for (const part of parts) {
      if (!part) continue;
      if (/^[✅✔✓]$/u.test(part)) { pushSpan(spans, { t: '', m: 'ok' }); continue; }
      if (/^[❌✘✗]$/u.test(part)) { pushSpan(spans, { t: '', m: 'no' }); continue; }
      const cx = it.x + it.w / 2;
      const r = rectAt(rects, cx, it.y + it.size * 0.35, (c) => !!HIGHLIGHT[c]);
      const s = { t: part };
      if (it.bold) s.b = 1;
      if (r) s.hl = HIGHLIGHT[r.color];
      pushSpan(spans, s);
    }
  }
  while (pending.length) pushSpan(spans, { t: '', m: pending.shift().kind });
  return spans;
};

const trimSpans = (spans) => {
  while (spans.length && !spans[0].m && !spans[0].t.trim()) spans.shift();
  while (spans.length && !spans[spans.length - 1].m && !spans[spans.length - 1].t.trim()) spans.pop();
  if (spans[0] && !spans[0].m) spans[0].t = spans[0].t.replace(/^\s+/, '');
  const last = spans[spans.length - 1];
  if (last && !last.m) last.t = last.t.replace(/\s+$/, '');
  const out = spans.map((s) => (s.m ? s : { ...s, t: s.t.replace(/\s+/g, ' ') }));
  // keep spaces outside styled runs: "**Definition: **x" -> "**Definition:** x"
  for (let i = 0; i < out.length - 1; i++) {
    const s = out[i];
    if (!s.m && (s.b || s.hl) && / $/.test(s.t) && !out[i + 1].m) {
      s.t = s.t.slice(0, -1);
      out[i + 1].t = ' ' + out[i + 1].t.replace(/^ /, '');
    }
  }
  for (let i = 1; i < out.length; i++) {
    const s = out[i], prev = out[i - 1];
    if (!s.m && (s.b || s.hl) && /^ /.test(s.t) && !prev.m) {
      s.t = s.t.slice(1);
      prev.t = prev.t.replace(/ $/, '') + ' ';
    }
  }
  return out.filter((s) => s.m || s.t);
};

// Drop the leading bullet glyph from spans; returns the glyph.
const stripBullet = (spans) => {
  const first = spans.find((s) => !s.m);
  if (!first) return null;
  const m = first.t.match(BULLET_START_RE);
  if (!m) return null;
  first.t = first.t.slice(m[0].length);
  return m[1];
};

// Calibri ligatures that pdf.js maps to odd code points ("inflaƟon"), and Wingdings bullets.
const LIGATURES = { 'Ɵ': 'ti', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '‐': '-' };
const fixText = (t) => t.replace(/[Ɵﬁﬂﬀﬃﬄ‐]/g, (c) => LIGATURES[c]);
const fixGlyph = (g) => (g && /[\uE000-\uF8FF]/u.test(g) ? '•' : g);

const spansText = (spans) => spans.map((s) => (s.m === 'ok' ? '✅' : s.m === 'no' ? '❌' : s.t)).join('');

// ---------- main ----------
const main = async () => {
  const file = path.resolve(args.file);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, useSystemFonts: false }).promise;
  let [from, to] = [1, doc.numPages];
  if (typeof args.pages === 'string') [from, to] = args.pages.split('-').map(Number);
  to = to || from;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'econ-'));
  const topics = [];
  const warnings = [];
  let source = 'forum';
  let sourceTheme = null;
  let topic = null;
  let themeSeq = 0;
  let awaitingThemeWrap = false;

  const startTopic = (number, title, pageNo, rect) => {
    topic = {
      source, sourceTheme, themeKey: canonicalTheme(sourceTheme, source),
      number, title, pages: [pageNo], blocks: [], headRect: rect, themeSeq,
    };
    if (!sourceTheme) warnings.push(`p${pageNo}: topic "${number}. ${title}" before any THEME heading`);
    topics.push(topic);
  };

  for (let pageNo = from; pageNo <= to; pageNo++) {
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale: 1 });
    const pageW = vp.width, pageH = vp.height, mid = pageW / 2;
    const opList = await page.getOperatorList();
    const rects = filledRects(opList, pageW);
    const tc = await page.getTextContent();
    const fontCache = new Map();
    const items = tc.items
      .filter((it) => it.str !== '')
      .map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5], w: it.width,
        size: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10,
        bold: fontInfo(page, it.fontName, fontCache),
      }));

    // source detection from the page header
    const header = items.filter((i) => i.y > pageH - 80).map((i) => i.str).join(' ');
    source = sourceForPage(pageNo, header) || source;

    // contents / index pages
    if (items.some((i) => /^\s*(INDEX|Contents)\s*$/.test(i.str))) { page.cleanup(); continue; }

    const img = rasterise(file, pageNo, tmp);

    for (const col of [0, 1]) {
      const colItems = items.filter((i) => (col === 0 ? i.x < mid - 8 : i.x >= mid - 8));
      const lines = groupLines(colItems);
      const colLeft = col === 0 ? 0 : mid - 8;
      const colRight = col === 0 ? mid - 8 : pageW;
      // indent is measured from this column's outermost bullet, since the margins differ per column
      const bulletXs = lines.filter((l) => BULLET_START_RE.test(l.text)).map((l) => l.x);
      const indentBase = bulletXs.length ? Math.min(...bulletXs) : colLeft;
      for (const line of lines) {
        if (!line.text || NOISE_RE.test(line.text) || TEST_REF_RE.test(line.text)) continue;
        if (line.y < 38) continue;                       // footer band
        const probeX = line.x + 1, probeY = line.y + line.size * 0.35;
        if (process.env.DEBUG_RE && new RegExp(process.env.DEBUG_RE).test(line.text)) {
          const near = rects.filter((r) => r.y0 - 3 < line.y + line.size && r.y1 + 3 > line.y).map((r) => `${r.color}@${Math.round(r.x0)}-${Math.round(r.x1)},${Math.round(r.y0)}-${Math.round(r.y1)}`);
          console.error(`\n[dbg p${pageNo}] "${line.text}" x=${Math.round(line.x)} y=${Math.round(line.y)} size=${line.size} bold=${line.items.map((i) => +i.bold).join('')} rects=${near.join(' ')}`);
        }

        // THEME heading. Part B / Vision wrap long names onto a second line ("… & INFRASTRUCTURE").
        const themeM = line.text.match(THEME_RE);
        if (themeM && line.text.length < 90) {
          sourceTheme = cleanTheme(themeM[1]);
          themeSeq++;
          awaitingThemeWrap = true;
          topic = null;
          continue;
        }
        if (awaitingThemeWrap && !topic && THEME_WRAP_RE.test(line.text)) {
          sourceTheme = cleanTheme(`${sourceTheme} ${line.text}`);
          continue;
        }
        awaitingThemeWrap = false;
        if (/^Theme\s*:/i.test(line.text)) continue;          // "Theme: A matter of choice…" sub-banner

        // Topic heading: "12. Credit Rationing" on a blue bar. The bar can start after the number
        // ("11.     Lender of Last Resort") or be missing, so we also trust the running number.
        const blue = rects.find((r) => isBlueBar(r.color) && r.x0 < line.x1 && r.x1 > line.x
          && probeY >= r.y0 - 1 && probeY <= r.y1 + 1);
        const topicM = line.text.match(TOPIC_RE);
        const inTheme = topic && topic.themeSeq === themeSeq;
        const expected = inTheme && topic.number != null ? topic.number + 1 : 1;
        const nearLeft = line.x - indentBase < 14 && !BULLET_START_RE.test(line.text);
        if (topicM) {
          const n = Number(topicM[1]);
          if ((blue && (!inTheme || (n >= expected && n <= expected + 4))) || (n === expected && nearLeft)) {
            startTopic(n, topicM[2].trim(), pageNo, blue || null);
            continue;
          }
        }
        if (blue && topic && topic.headRect === blue) {        // wrapped heading
          topic.title = `${topic.title} ${line.text}`.trim();
          continue;
        }
        if (!inTheme && nearLeft && (blue || /^Q\s*\d+\.\s*\S/.test(line.text))) {   // un-numbered heading ("Q 21. A inflation")
          startTopic(null, line.text.replace(/^Q\s*\d+\.\s*/, ''), pageNo, blue);
          continue;
        }
        if (blue && topic) {                                     // sub-heading inside a topic ("1. Organisation")
          const spans = trimSpans(lineSpans(line, rects, []));
          topic.blocks.push({ x: 0, glyph: null, heading: true, spans: spans.map(({ hl, ...s }) => s) });
          if (!topic.pages.includes(pageNo)) topic.pages.push(pageNo);
          continue;
        }
        if (!topic) {
          warnings.push(`p${pageNo}: orphan line "${line.text.slice(0, 70)}"`);
          continue;
        }
        if (!topic.pages.includes(pageNo)) topic.pages.push(pageNo);

        const marks = scanMarks(img, pageH, colLeft, colRight, line.y, line.size);
        const spans = trimSpans(lineSpans(line, rects, marks));
        if (!spans.length) continue;
        const glyph = stripBullet(spans);
        const cleaned = trimSpans(spans);
        if (glyph) {
          const glyphItem = line.items.find((i) => BULLET_RE.test(i.str.trim()) || BULLET_START_RE.test(i.str));
          topic.blocks.push({ x: (glyphItem ? glyphItem.x : line.x) - indentBase, glyph, spans: cleaned });
        } else {
          const last = topic.blocks[topic.blocks.length - 1];
          // continuation of the previous bullet if it's indented at or past its text
          if (last && line.x - indentBase > last.x + 4) {
            const tail = last.spans[last.spans.length - 1];
            if (tail && !tail.m && !/[-‐]$/.test(tail.t)) tail.t += ' ';
            for (const s of cleaned) pushSpan(last.spans, { ...s });
          } else {
            topic.blocks.push({ x: line.x - indentBase, glyph: null, spans: cleaned });
          }
        }
      }
    }
    page.cleanup();
    process.stderr.write(`\rparsed page ${pageNo}/${to}`);
  }
  process.stderr.write('\n');
  fs.rmSync(tmp, { recursive: true, force: true });

  // Indent levels: rank of the bullet's x among distinct bullet x positions in that topic.
  for (const t of topics) {
    const xs = [...new Set(t.blocks.filter((b) => b.glyph).map((b) => Math.round(b.x)))].sort((a, b) => a - b);
    const clusters = [];
    for (const x of xs) if (!clusters.length || x - clusters[clusters.length - 1] > 6) clusters.push(x);
    t.blocks = t.blocks.map((b) => {
      let level = 0;
      if (b.glyph) clusters.forEach((cx, i) => { if (Math.round(b.x) >= cx - 1) level = i; });
      for (const sp of b.spans) if (sp.t) sp.t = fixText(sp.t);
      return { level: Math.min(level, 3), glyph: fixGlyph(b.glyph), ...(b.heading ? { heading: true } : {}), spans: b.spans };
    }).filter((b) => b.spans.length);
    const text = t.blocks.map((b) => spansText(b.spans)).join('\n');
    t.pyqTags = [...new Set([...`${t.title}\n${text}`.matchAll(PYQ_RE)].map((m) => m[1].replace(/\s+/g, ' ').trim()))];
    t.title = fixText(t.title);
    t.sourceTheme = fixText(t.sourceTheme || '');
    delete t.headRect;
    delete t.themeSeq;
    if (!t.blocks.length) warnings.push(`p${t.pages[0]}: topic "${t.number}. ${t.title}" has no content`);
    if (!t.themeKey) warnings.push(`p${t.pages[0]}: unmapped theme "${t.sourceTheme}"`);
  }

  const out = {
    file: path.basename(file),
    parsedAt: new Date().toISOString(),
    pages: [from, to],
    themes: ECONOMY_THEMES,
    stats: {
      topics: topics.length,
      bySource: topics.reduce((a, t) => ({ ...a, [t.source]: (a[t.source] || 0) + 1 }), {}),
      byTheme: topics.reduce((a, t) => ({ ...a, [t.themeKey]: (a[t.themeKey] || 0) + 1 }), {}),
      marks: topics.reduce((n, t) => n + t.blocks.reduce((m, b) => m + b.spans.filter((s) => s.m).length, 0), 0),
      pyqTagged: topics.filter((t) => t.pyqTags.length).length,
    },
    warnings: [...new Set(warnings)],
    topics,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.stats, null, 1));
  console.log(`${out.warnings.length} warnings -> ${OUT}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
