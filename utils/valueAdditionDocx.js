import zlib from 'zlib';

// Turns a value-addition Word file into a searchable "notes bank" for the student
// Value addition tab. No AI — it reads the document's own structure:
//
//   Chapter mode (e.g. Art_Culture_Value_Addition_Complete.docx)
//     Heading 1  "1. Pallava, Chola & Gupta Architecture"   → a section
//     Heading 2  "1.2 Data" / "1.3 Facts" / …                → the note type
//     Heading 3  sub-heading ("PYQs covered" / "Quotes to open with" switch the type)
//   Single-topic mode (e.g. Temple_Architecture_Value_Addition.docx)
//     Heading 1  "2. Data" / "3. Facts" / …                  → the note type
//     Heading 2  sub-heading (or Quotes / PYQ mapping / Diagrams)
//
// Every paragraph, bullet or table row under a type becomes one note. "Label: text"
// paragraphs keep the label as the note's title; a table row's first cell is the title
// and the other cells become label/value pairs from the header row. Table rows also carry
// `tbl` (an id into `tables`, which keeps each table's header) so the page can redraw
// them as the original table. "Year | Question"
// tables and "PYQ mapping" bullets become the section's PYQs; "Keywords" become chips.

export const NOTE_TYPES = ['intro', 'quote', 'data', 'fact', 'example', 'case', 'now', 'conclusion', 'diagram'];

const TYPE_WORDS = [
  ['quote', 'quote'], ['pyq', 'pyq'], ['introduction', 'intro'], ['data', 'data'], ['myth', 'fact'],
  ['fact', 'fact'], ['example', 'example'], ['case', 'case'], ['contemporary', 'now'], ['current', 'now'],
  ['conclusion', 'conclusion'], ['keyword', 'keyword'], ['diagram', 'diagram'],
];
const typeOf = (heading) => {
  const h = heading.toLowerCase();
  return TYPE_WORDS.find(([w]) => h.includes(w))?.[1] || null;
};

// --- minimal .docx (zip) reader: central directory → one entry, stored or deflated ---
const readZipEntry = (buf, name) => {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a Word (.docx) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error('Unsupported compression in the Word file');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('Not a Word (.docx) file');
};

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const textOf = (xml) => decode(
  [...xml.replace(/<w:(?:tab|br)\/>/g, '<w:t> </w:t>').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((m) => m[1]).join(''),
).replace(/\s+/g, ' ').trim();

const styleOf = (pXml) => pXml.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || '';

/** Document body as an ordered list of { kind: 'p', style, text } | { kind: 'table', rows }. */
const blocksOf = (xml) => {
  const body = xml.slice(xml.indexOf('<w:body'));
  const out = [];
  // <w:p …/> (an empty, self-closing paragraph) is skipped so it can't swallow the next one.
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*[^/])?>[\s\S]*?<\/w:p>/g)) {
    const x = m[0];
    if (x.startsWith('<w:tbl>')) {
      const rows = [...x.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) =>
        [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => textOf(tc[0])));
      if (rows.length) out.push({ kind: 'table', rows });
    } else {
      const text = textOf(x);
      if (text) out.push({ kind: 'p', style: styleOf(x), text });
    }
  }
  return out;
};

const splitLabel = (t) => {
  const m = t.match(/^([^:]{2,60}):\s+([\s\S]+)$/);
  return m && m[1].trim().split(/\s+/).length <= 8 ? [m[1].trim(), m[2].trim()] : ['', t];
};
const stripNum = (s) => s.replace(/^[\d.]+\s*/, '').trim();
const level = (style) => Number(style.match(/^Heading(\d)$/i)?.[1]) || 0;

/** Parse a .docx buffer into { sections, notes, tables, stats }. `fallbackName` names a single-topic file. */
export const parseValueAdditionDocx = (buffer, fallbackName = 'Notes') => {
  const blocks = blocksOf(readZipEntry(buffer, 'word/document.xml'));
  const h1 = blocks.filter((b) => b.kind === 'p' && level(b.style) === 1);
  const singleTopic = h1.length > 0 && h1.filter((b) => typeOf(b.text)).length * 2 >= h1.length;

  const sections = [];
  const notes = [];
  const tables = [];
  let section = null;
  let type = null;      // current note type
  let baseType = null;  // type set by the section heading, restored after a Quotes / PYQs sub-heading
  let sub = '';

  const newSection = (name) => {
    section = { id: `s${sections.length + 1}`, name, pyqs: [], keywords: [] };
    sections.push(section);
  };
  if (singleTopic) newSection(fallbackName);

  const add = (note) => notes.push({ id: notes.length, section: section.id, type, sub, ...note });

  for (const b of blocks) {
    if (b.kind === 'table') {
      if (!section || !b.rows.length) continue;
      const [head, ...rest] = b.rows;
      if (type === 'pyq' || head.map((h) => h.toLowerCase()).join('|') === 'year|question') {
        rest.forEach((r) => section.pyqs.push({ year: r[0] || '', question: r[1] || '' }));
        continue;
      }
      if (!type || type === 'keyword') continue;
      const tbl = `t${tables.length + 1}`;
      tables.push({ id: tbl, head });
      rest.forEach((r) => {
        if (!r.some(Boolean)) return;
        add({ title: r[0], text: '', tbl, cols: r.slice(1).map((v, i) => [head[i + 1] || '', v]).filter(([, v]) => v) });
      });
      continue;
    }

    const lvl = level(b.style);
    if (lvl === 1) {
      if (singleTopic) { type = baseType = typeOf(b.text); sub = ''; }
      else { newSection(stripNum(b.text)); type = baseType = null; sub = ''; }
    } else if (lvl === 2 && section) {
      const name = stripNum(b.text);
      const t = typeOf(name);
      if (singleTopic) {
        if (['quote', 'pyq', 'diagram'].includes(t)) { type = t; sub = ''; } else { type = baseType; sub = name; }
      } else { type = baseType = t; sub = ''; }
    } else if (lvl >= 3 && section) {
      const t = typeOf(b.text);
      if (t === 'quote' || t === 'pyq') { type = t; sub = ''; } else { type = baseType; sub = b.text; }
    } else if (section && type) {
      if (type === 'keyword') {
        section.keywords.push(...b.text.split(/[,;]/).map((k) => k.trim()).filter(Boolean));
      } else if (type === 'pyq') {
        const m = b.text.match(/^"?(.+?)"?\s*\((GS\s?\d|Essay|Prelims)?\s*(\d{4})\):?\s*(.*)$/i);
        section.pyqs.push(m ? { year: m[3], question: m[1], map: m[4] } : { year: '', question: b.text });
      } else {
        const [title, text] = splitLabel(b.text);
        add({ title, text });
      }
    }
  }

  const kept = sections.filter((s) => s.pyqs.length || s.keywords.length || notes.some((n) => n.section === s.id));
  return {
    sections: kept,
    notes,
    tables: tables.filter((t) => notes.some((n) => n.tbl === t.id)),
    stats: { notes: notes.length, pyqs: kept.reduce((n, s) => n + s.pyqs.length, 0), sections: kept.length },
  };
};
