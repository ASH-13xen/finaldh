// Shared mapper for importing a PYQ dump (JSON) into a Question Bank (QuizQuestion pool).
// Used by the admin import endpoint (questionBankAdminController.js) and the CLI importer
// (scripts/import_bank_questions.mjs) so the two paths never drift.
//
// Expected row shape (matches the annotated PYQ dumps out of the Colab pipeline):
//   {
//     "exam_source":   "CDS (I) 2015",
//     "question_text": "Consider the following statements ...",
//     "statements":    ["1. ...", "2. ..."],                 // optional
//     "options":       { "a": "1 only", "b": "2 only", "c": "Both", "d": "Neither" },
//     "tick_answer":   "c",
//     "topic":         "DRAINAGE SYSTEM",                    // optional
//     "type":          "Factual",                            // optional -> conceptual|factual
//     "correct_why":   "Both statements are correct because ..."  // optional
//   }

const MISC_TOPIC = 'Miscellaneous';
const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const VALID_TYPES = ['conceptual', 'factual'];

// --- topic normalization ---------------------------------------------------
const TOPIC_FIXES = {
  ANTARTICA: 'Antarctica',
  'ATMOSPHERIC PRESSURE LAYERS OF ATMOSPHERE': 'Layers Of The Atmosphere',
  'AGRICULTURAL PRACTICES': 'Agriculture',
  'NATIONAL PARK - BIOSPHERE RESERVE WILDLIFE SANCTUARY':
    'National Parks, Biosphere Reserves & Wildlife Sanctuaries'
};
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());

export const normalizeTopic = (raw) => {
  const trimmed = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
  if (!trimmed) return MISC_TOPIC;
  const upper = trimmed.toUpperCase();
  if (upper === 'NULL' || /ONLY_?PYQS?/.test(upper)) return MISC_TOPIC;
  if (TOPIC_FIXES[upper]) return TOPIC_FIXES[upper];
  return titleCase(trimmed);
};

// --- option / statement cleanup ------------------------------------------
const stripOptionPrefix = (key, text) => {
  const k = String(key).toLowerCase();
  return String(text ?? '')
    .replace(new RegExp(`^\\s*\\(?${k}\\)[.:]?\\s+`, 'i'), '')
    .replace(new RegExp(`^\\s*${k}[.)]\\s+`, 'i'), '')
    .trim();
};

const isInlineOptionLine = (line) => /^\s*\(?[a-eA-E]\)[.)]?\s+/.test(line);
const isCodeScaffoldLine = (line) => {
  const l = String(line).trim();
  return /^codes?\s*:?\s*$/i.test(l)
    || /^[A-E]([\s]+[A-E]){1,}$/.test(l)        // "A B C D"
    || /^\d([\s]+\d){1,}$/.test(l)              // "2 1 3 4"
    || /^\s*\(?[a-eA-E]\)[.)]?\s+\d/.test(l);   // "(a) 2 1 3 4"
};
const isNoiseLine = (line) => {
  const l = String(line).trim();
  return !l || isInlineOptionLine(l) || isCodeScaffoldLine(l);
};

// --- "Match List I with List II" parsing --------------------------------
const LIST_I_RE = /^list\s*[-–]?\s*i\b/i;
const LIST_II_RE = /^list\s*[-–]?\s*ii\b/i;
const LEFT_ITEM_RE = /^([A-Fa-f])[.)]\s*(.+)$/;
const RIGHT_ITEM_RE = /^(\d+)[.)]\s*(.+)$/;
const DEFAULT_MATCH_STEM = 'Match List I with List II and select the correct answer using the code given below.';

const parseMatchLists = (row) => {
  const raw = [
    String(row.question_text || ''),
    ...(Array.isArray(row.statements) ? row.statements.map(String) : [])
  ].join('\n').replace(/<br\s*\/?>/gi, '\n');

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.some((l) => /match\s+list/i.test(l))) return null;

  let leftHeader = 'List I';
  let rightHeader = 'List II';
  const left = [];
  const right = [];
  let seenListII = false;

  for (const l of lines) {
    if (LIST_II_RE.test(l)) {
      seenListII = true;
      const h = l.match(/\(([^)]+)\)/);
      if (h) rightHeader = `List II (${h[1].trim()})`;
      continue;
    }
    if (LIST_I_RE.test(l)) {
      const h = l.match(/\(([^)]+)\)/);
      if (h) leftHeader = `List I (${h[1].trim()})`;
      continue;
    }
    if (isNoiseLine(l) || /^code\b|^codes\b/i.test(l)) break;

    const rm = l.match(RIGHT_ITEM_RE);
    const lm = l.match(LEFT_ITEM_RE);
    if (rm && (seenListII || left.length >= 2)) right.push({ key: rm[1], text: rm[2].trim() });
    else if (lm) left.push({ key: lm[1].toUpperCase(), text: lm[2].trim() });
    else if (rm) right.push({ key: rm[1], text: rm[2].trim() });
  }

  if (left.length < 3 || left.length > 6 || right.length < left.length) return null;

  return {
    left: { header: leftHeader, items: left },
    right: { header: rightHeader, items: right.slice(0, Math.max(left.length, right.length)) }
  };
};

const cleanText = (v) => String(v ?? '').replace(/\r/g, '').trim();
const collapseWs = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Map one raw row to a partial QuizQuestion doc (no `subject`, `seq`, `aiStatus`).
 * Returns { doc } or { skip: { reason } }.
 */
export function mapBankRow(row) {
  if (!row || typeof row !== 'object') return { skip: { reason: 'row is not an object' } };

  const rawOpts = row.options;
  if (!rawOpts || typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
    return { skip: { reason: 'options is missing or not an object' } };
  }
  const entries = Object.entries(rawOpts);
  if (entries.length !== 4) return { skip: { reason: `expected 4 options, found ${entries.length}` } };

  const options = entries
    .map(([k, v]) => ({ key: String(k).toUpperCase().trim(), text: stripOptionPrefix(k, v) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (options.map((o) => o.key).join('') !== 'ABCD') {
    return { skip: { reason: `option keys are [${options.map((o) => o.key).join(',')}], expected A,B,C,D` } };
  }
  if (options.some((o) => !o.text)) return { skip: { reason: 'an option has empty text' } };

  const correctKey = cleanText(row.tick_answer).toUpperCase();
  if (!OPTION_KEYS.includes(correctKey)) {
    return { skip: { reason: `tick_answer is "${row.tick_answer}" (not A/B/C/D)` } };
  }

  const matchLists = parseMatchLists(row);
  const stem = cleanText(row.question_text);

  let questionText = stem;
  let statements = [];
  if (matchLists) {
    questionText = stem || DEFAULT_MATCH_STEM;
  } else {
    statements = Array.isArray(row.statements)
      ? row.statements.map(cleanText).filter((s) => s && !isNoiseLine(s))
      : [];
  }
  if (!questionText) return { skip: { reason: 'empty question_text' } };

  const typeRaw = cleanText(row.type).toLowerCase();
  const questionType = VALID_TYPES.includes(typeRaw) ? typeRaw : 'conceptual';
  const whyCorrect = cleanText(row.correct_why || row.whyCorrect);

  return {
    doc: {
      topic: normalizeTopic(row.topic),
      questionText,
      statements,
      matchLists,
      options,
      correctKey,
      questionType,
      whyCorrect,
      aiStatus: whyCorrect ? 'done' : 'pending',
      examSource: collapseWs(row.exam_source || row.examSource)
    }
  };
}

const dedupeKey = (doc) => {
  let s = doc.questionText + ' ' + doc.options.map((o) => o.text).join(' ');
  if (doc.matchLists) {
    s += ' ' + [...doc.matchLists.left.items, ...doc.matchLists.right.items].map((i) => i.text).join(' ');
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

/**
 * Map an array of rows. Returns { docs, skipped, duplicates }.
 * `docs` are de-duplicated within the file; no `subject`/`seq` yet.
 */
export function mapBank(rows) {
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array of question objects');
  const docs = [];
  const skipped = [];
  const seen = new Set();
  let duplicates = 0;

  rows.forEach((row, i) => {
    const r = mapBankRow(row);
    if (r.skip) {
      skipped.push({ row: i + 1, reason: r.skip.reason });
      return;
    }
    const key = dedupeKey(r.doc);
    if (seen.has(key)) { duplicates += 1; return; }
    seen.add(key);
    docs.push(r.doc);
  });

  return { docs, skipped, duplicates };
}
