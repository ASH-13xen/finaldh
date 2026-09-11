// Shared cleanup for a "PYQ + printed model answer" JSON ingest — a source book
// that already prints a model answer per question, hand-extracted into JSON
// (as opposed to the PDF chunk-vision pipeline in toppersCopyController.js).
// Used by both the admin "PYQ Ingest > JSON" upload (startPyqJsonJob) and the
// standalone scripts/import_pdf_pyq_answers.mjs one-off importer, so the two
// paths can never drift.
//
// Input shape (one object per question):
//   { subject, topic, subtopic, year, question, model_answer, source_pages, ... }
// "topic" (broad, e.g. "Geography") maps to section; "subtopic" (fine, e.g.
// "Consolidation of British power") maps to topic — matching the granularity
// ToppersCopy topics already use.
//
// Cleanup applied (verified by hand against the first GS-1 book this shipped
// for — see the Toppers Copy PYQ conversation history for the specifics):
// 1. Marks live as a trailing "(N)" inside the question text; split it out.
// 2. A chunk-boundary bug in some source extractions bleeds the start of the
//    answer into the question line ("...(10) Sea Surface Temperature (SST)
//    rise refers to..."). Fix: split at the first "(N)" match, prepend the
//    remainder to that row's own answer text.
// 3. Orphan continuation fragments — no marks pattern AND a short, non-question
//    "question" (e.g. "2030.") — are the true tail of the PREVIOUS row's
//    cut-off answer, misfiled as a new entry. Heuristic: no marks match AND
//    question shorter than ORPHAN_MAX_LEN chars => merge into the previous
//    row's answer, drop the row. A genuine question with no printed marks
//    survives this untouched (marks stays null) because it's long enough.
// 4. "[IMAGE/DIAGRAM at page N — ...]" placeholders mark a diagram the source
//    extraction correctly declined to describe. Stripped from the answer text;
//    the page number is kept in `diagramPages` for the admin to attach a real
//    screenshot via the per-PYQ image upload.
// 5. Bare 1-3 digit lines mid-paragraph are PDF page-footer numbers that bled
//    into the text. Stripped as noise — a real UPSC-range year is always 4
//    digits, so this can't eat a genuine one.

const ORPHAN_MAX_LEN = 50;
const MARKS_RE = /\((\d{1,2})\)/;
const DIAGRAM_RE = /\[IMAGE\/DIAGRAM at page (\d+)[^\]]*\]/g;
const PAGE_FOOTER_RE = /^[ \t]*\d{1,3}[ \t]*$/gm;

const stripDiagramsAndFooters = (text) => {
  const pages = [];
  let cleaned = text.replace(DIAGRAM_RE, (_, page) => { pages.push(Number(page)); return ''; });
  cleaned = cleaned.replace(PAGE_FOOTER_RE, '');
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim(), pages };
};

/**
 * @param {object[]} raw  parsed JSON array (question/model_answer/topic/subtopic/year/...)
 * @returns {{ rows: object[], diagramReport: {questionText:string,pages:number[]}[], mergedFragments: number }}
 *   rows are shaped for extractedPyqSchema: { subject, section, topic, microtheme,
 *   questionText, year, marks, answerText, diagramPages }
 */
export function cleanPyqJsonRows(raw, { defaultSubject = '' } = {}) {
  if (!Array.isArray(raw)) throw new Error('Expected a JSON array of questions');

  const rows = raw.map((r) => ({ ...r, question: String(r.question || '').trim(), model_answer: String(r.model_answer || '') }));
  const dropIndexes = new Set();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (/\(\d{1,2}\)\s*$/.test(r.question)) continue; // clean already

    const m = MARKS_RE.exec(r.question);
    if (m) {
      const splitAt = m.index + m[0].length;
      const bleed = r.question.slice(splitAt).trim();
      r.question = r.question.slice(0, splitAt).trim();
      if (bleed) r.model_answer = `${bleed}\n${r.model_answer}`;
      continue;
    }

    if (r.question.length < ORPHAN_MAX_LEN && i > 0) {
      rows[i - 1].model_answer = `${rows[i - 1].model_answer}\n${r.question} ${r.model_answer}`.trim();
      dropIndexes.add(i);
    }
    // else: a real question the source printed with no marks — leave marks null.
  }

  const cleaned = rows.filter((_, i) => !dropIndexes.has(i));
  const out = [];
  const diagramReport = [];

  for (const r of cleaned) {
    const marksMatch = MARKS_RE.exec(r.question);
    const marks = marksMatch ? Number(marksMatch[1]) : null;
    const questionText = r.question.replace(/\(\d{1,2}\)\s*$/, '').trim();
    const year = Number(r.year);
    if (!questionText || !Number.isFinite(year)) continue;

    const { text: answerText, pages } = stripDiagramsAndFooters(r.model_answer.trim());
    if (pages.length) diagramReport.push({ questionText, pages });

    out.push({
      subject: String(defaultSubject || r.subject || '').trim(),
      section: String(r.topic || '').trim(),
      topic: String(r.subtopic || '').trim(),
      microtheme: '',
      questionText,
      year,
      marks,
      answerText,
      diagramPages: pages,
    });
  }

  return { rows: out, diagramReport, mergedFragments: dropIndexes.size };
}
