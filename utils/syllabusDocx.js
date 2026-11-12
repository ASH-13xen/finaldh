import zlib from 'zlib';

// Reads a subject's syllabus out of a Word file. No AI — it uses the document's own structure:
//
//   Heading  "5. Money and Banking"            → a chapter (numbered headings of any level)
//   Bullets / paragraphs under it              → its sub-topics
//   Heading  "Suggested Study Order" + a line  → kept as a note, not a chapter
//
// A file with no numbered headings uses its top heading level as the chapters instead.

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

const paragraphs = (xml) => {
  const body = xml.slice(xml.indexOf('<w:body'));
  const out = [];
  for (const m of body.matchAll(/<w:p(?:\s[^>]*[^/])?>[\s\S]*?<\/w:p>/g)) {
    const text = decode([...m[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const style = m[0].match(/<w:pStyle w:val="([^"]+)"/)?.[1] || '';
    out.push({ text, style, level: Number(style.match(/^Heading\s*(\d)$/i)?.[1]) || 0 });
  }
  return out;
};

const NUMBERED = /^\d{1,3}\s*[.)]\s+/;
export const chapterKey = (title) => title.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Parse a .docx buffer into { chapters: [{ key, number, title, subtopics }], studyOrder }. */
export const parseSyllabusDocx = (buffer) => {
  const paras = paragraphs(readZipEntry(buffer, 'word/document.xml'));
  const numbered = paras.some((p) => p.level && NUMBERED.test(p.text));
  const topLevel = numbered ? 0 : Math.min(...paras.filter((p) => p.level).map((p) => p.level), 99);

  const chapters = [];
  const seen = new Set();
  let current = null;
  let studyOrder = '';
  let inStudyOrder = false;

  for (const p of paras) {
    const isChapter = numbered ? (p.level && NUMBERED.test(p.text)) : p.level === topLevel;
    if (isChapter) {
      const title = p.text.replace(NUMBERED, '').trim();
      inStudyOrder = false;
      if (/study order/i.test(title)) { current = null; inStudyOrder = true; continue; }
      let key = chapterKey(title);
      for (let n = 2; seen.has(key); n += 1) key = `${chapterKey(title)}-${n}`;
      seen.add(key);
      current = { key, number: chapters.length + 1, title, subtopics: [] };
      chapters.push(current);
    } else if (numbered && p.level) {
      // An unnumbered heading ends the chapter list ("Suggested Study Order", appendices).
      current = null;
      inStudyOrder = /study order/i.test(p.text);
    } else if (inStudyOrder) {
      studyOrder = studyOrder ? `${studyOrder} ${p.text}` : p.text;
    } else if (current) {
      current.subtopics.push(p.text.replace(/^[-•]\s*/, ''));
    }
  }
  return { chapters, studyOrder };
};
