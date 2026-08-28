// Imports a cleaned MCQ dump (default: scratch/cleaned_geography_questions.json) into the Quiz
// feature as a flat, topic-tagged pool of QuizQuestions for one subject (default "Geography").
// Transforms each row, drops unusable rows (no answer key / not exactly 4 options), de-dupes.
// No "sets" — the student picks a topic / random test / the whole pool at runtime.
// Run scripts/generate_quiz_ai.mjs afterwards to fill in whyCorrect + hint (optional; questions
// are usable without it).
//
// Usage:
//   node scripts/import_quiz_questions.mjs --dry-run
//   node scripts/import_quiz_questions.mjs
//   node scripts/import_quiz_questions.mjs --file scratch/foo.json --subject Geography --replace

import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QuizQuestion from '../models/QuizQuestion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const MISC_TOPIC = 'Miscellaneous';

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const REPLACE = args.includes('--replace');
const DRY_RUN = args.includes('--dry-run');
const FILE = path.resolve(ROOT, getArg('--file', 'scratch/cleaned_geography_questions.json'));
const SUBJECT = getArg('--subject', 'Geography');

// --- topic normalization ---------------------------------------------------
const TOPIC_FIXES = {
  ANTARTICA: 'Antarctica',
  'ATMOSPHERIC PRESSURE LAYERS OF ATMOSPHERE': 'Layers Of The Atmosphere',
  'AGRICULTURAL PRACTICES': 'Agriculture',
  'NATIONAL PARK - BIOSPHERE RESERVE WILDLIFE SANCTUARY':
    'National Parks, Biosphere Reserves & Wildlife Sanctuaries'
};
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());

// "Null", "", "Only_pyqs", "NDA (I) 2015 Only_pyqs" etc. are not real topics -> Miscellaneous.
const normalizeTopic = (raw) => {
  const trimmed = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
  if (!trimmed) return MISC_TOPIC;
  const upper = trimmed.toUpperCase();
  if (upper === 'NULL' || /ONLY_?PYQS?/.test(upper)) return MISC_TOPIC;
  if (TOPIC_FIXES[upper]) return TOPIC_FIXES[upper];
  return titleCase(trimmed);
};

// --- option / question text cleanup --------------------------------------
const stripOptionPrefix = (key, text) => {
  const k = key.toLowerCase();
  return String(text)
    .replace(new RegExp(`^\\s*\\(?${k}\\)[.:]?\\s+`, 'i'), '')
    .replace(new RegExp(`^\\s*${k}[.)]\\s+`, 'i'), '')
    .trim();
};
const isInlineOptionLine = (line) => /^\s*\(?[a-eA-E]\)[.)]?\s+/.test(line);
// Leftover scaffolding that shouldn't show in the stem: "Code :", "Codes :", a bare "A B C D"
// row, or a stray answer-code like "2 5 4 1".
const isCodeScaffoldLine = (line) => {
  const l = line.trim();
  return /^codes?\s*:?\s*$/i.test(l)
    || /^[A-E]([\s]+[A-E]){1,}$/.test(l)
    || /^\d([\s]+\d){1,}$/.test(l);
};
const isNoiseLine = (line) => isInlineOptionLine(line) || isCodeScaffoldLine(line);

const stripTrailingNoise = (text) => {
  const lines = text.split('\n');
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l === '') { cut = i; continue; }
    if (isNoiseLine(l)) { cut = i; continue; }
    break;
  }
  return lines.slice(0, cut).join('\n').trim();
};

// --- "Match List I with List II" parsing --------------------------------
const LIST_I_RE = /^list\s*[-–]?\s*i\b/i;
const LIST_II_RE = /^list\s*[-–]?\s*ii\b/i;
const LEFT_ITEM_RE = /^([A-Fa-f])[.)]\s*(.+)$/;
const RIGHT_ITEM_RE = /^(\d+)[.)]\s*(.+)$/;
const DEFAULT_MATCH_STEM = 'Match List I with List II and select the correct answer using the code given below.';

// Returns { stem, left:{header,items}, right:{header,items} } or null. Handles the many
// shapes this dump uses: structure in question_text, in statements[], split across both, with
// <br> separators, headers on their own line, and an implicit List II (items just switch from
// A./B. to 1./2.).
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
    if (isNoiseLine(l) || /^code\b|^codes\b/i.test(l)) break; // reached the answer-code block

    const rm = l.match(RIGHT_ITEM_RE);
    const lm = l.match(LEFT_ITEM_RE);
    if (rm && (seenListII || left.length >= 2)) right.push({ key: rm[1], text: rm[2].trim() });
    else if (lm) left.push({ key: lm[1].toUpperCase(), text: lm[2].trim() });
    else if (rm) right.push({ key: rm[1], text: rm[2].trim() });
  }

  if (left.length < 3 || left.length > 6 || right.length < left.length) return null;

  return {
    stem: DEFAULT_MATCH_STEM,
    left: { header: leftHeader, items: left },
    right: { header: rightHeader, items: right.slice(0, Math.max(left.length, right.length)) }
  };
};

const buildQuestionText = (row, options, matchLists) => {
  let stem = (row.question_text || '').trim();

  if (matchLists) {
    // The lists are rendered separately — the stem is just the instruction line.
    return matchLists.stem;
  }

  const statements = Array.isArray(row.statements) ? row.statements : [];
  const keepable = statements.map((s) => String(s).trim()).filter((s) => s && !isNoiseLine(s));
  const missing = keepable.filter((s) => !stem.includes(s));
  if (missing.length) stem = [stem, ...missing].join('\n');
  if (options.length === 4) stem = stripTrailingNoise(stem);
  return stem.replace(/\n{3,}/g, '\n\n').trim();
};

// --- per-row transform ----------------------------------------------------
const transformRow = (row, idx) => {
  const rawOpts = row.options;
  if (!rawOpts || typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
    return { skip: { idx, reason: 'options is not an object' } };
  }
  const entries = Object.entries(rawOpts);
  if (entries.length !== 4) {
    return { skip: { idx, reason: `expected 4 options, found ${entries.length}` } };
  }
  const options = entries
    .map(([k, v]) => ({ key: k.toUpperCase(), text: stripOptionPrefix(k, v) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (options.map((o) => o.key).join('') !== 'ABCD') {
    return { skip: { idx, reason: `option keys are [${options.map((o) => o.key).join(',')}], expected A,B,C,D` } };
  }
  if (options.some((o) => !o.text)) return { skip: { idx, reason: 'an option has empty text' } };

  const correctKey = (row.tick_answer || '').toString().trim().toUpperCase();
  if (!OPTION_KEYS.includes(correctKey)) {
    return { skip: { idx, reason: `tick_answer is "${row.tick_answer}" (no valid answer key)` } };
  }
  const matchLists = parseMatchLists(row);
  const questionText = buildQuestionText(row, options, matchLists);
  if (!questionText) return { skip: { idx, reason: 'empty question text' } };

  return {
    doc: {
      questionText,
      matchLists: matchLists ? { left: matchLists.left, right: matchLists.right } : null,
      options,
      correctKey,
      topic: normalizeTopic(row.topic),
      examSource: (row.exam_source || '').toString().replace(/\s+/g, ' ').trim()
    }
  };
};

const dedupeKey = (doc) => {
  let s = doc.questionText;
  if (doc.matchLists) {
    // The stem is identical for every match question — key on the list contents instead.
    s += ' ' + [...doc.matchLists.left.items, ...doc.matchLists.right.items].map((i) => i.text).join(' ');
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

// --- main ---------------------------------------------------------------
async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(rows)) {
    console.error('Expected the JSON file to be an array of question objects.');
    process.exit(1);
  }
  console.log(`Read ${rows.length} rows from ${path.relative(ROOT, FILE)}`);

  const skipped = [];
  const seen = new Set();
  const docs = [];
  let dupes = 0;

  rows.forEach((row, idx) => {
    const r = transformRow(row, idx);
    if (r.skip) { skipped.push(r.skip); return; }
    const key = dedupeKey(r.doc);
    if (seen.has(key)) { dupes += 1; return; }
    seen.add(key);
    docs.push(r.doc);
  });

  const byTopic = {};
  for (const d of docs) byTopic[d.topic] = (byTopic[d.topic] || 0) + 1;
  const topicList = Object.entries(byTopic).sort((a, b) => b[1] - a[1]);
  const withMatchLists = docs.filter((d) => d.matchLists).length;

  console.log(`\nUsable: ${docs.length}   Skipped: ${skipped.length}   Duplicates dropped: ${dupes}   Match-list questions: ${withMatchLists}`);
  console.log(`Topics: ${topicList.length} (top 5: ${topicList.slice(0, 5).map(([t, n]) => `${t}=${n}`).join(', ')}; ${MISC_TOPIC}=${byTopic[MISC_TOPIC] || 0})`);
  if (skipped.length) {
    console.log('\n--- skipped rows ---');
    for (const s of skipped) console.log(`  row ${s.idx}: ${s.reason}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no database changes. Sample transformed question:\n');
    console.log(JSON.stringify({ subject: SUBJECT, seq: 0, ...docs[0] }, null, 2));
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await QuizQuestion.countDocuments({ subject: SUBJECT });
  if (existing > 0) {
    if (!REPLACE) {
      console.error(`\n${existing} "${SUBJECT}" quiz question(s) already exist. Re-run with --replace to rebuild.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    await QuizQuestion.deleteMany({ subject: SUBJECT });
    console.log(`\n--replace: removed ${existing} existing "${SUBJECT}" question(s).`);
    console.log('  (existing in-progress QuizAttempts for this subject may now reference deleted questions)');
  }

  const BATCH = 500;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH).map((d, j) => ({
      ...d,
      subject: SUBJECT,
      seq: i + j,
      aiStatus: 'pending'
    }));
    await QuizQuestion.insertMany(batch);
    process.stdout.write(`  inserted ${Math.min(i + BATCH, docs.length)}/${docs.length}\r`);
  }

  console.log(`\n\nDone. ${docs.length} "${SUBJECT}" question(s) in ${topicList.length} topics.`);
  console.log('Next (optional): node scripts/generate_quiz_ai.mjs   (fills whyCorrect + hint)');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
