// Groups near-identical questions from different transcripts into "families", so the app can say
// "asked 23 times, 2020-2024, across 6 boards". Leader clustering over an inverted index of each
// family's rarest words; when Gemini embeddings exist they let paraphrases with fewer shared words join.
import { tokenize, normalizeText } from './text.js';

// Weighted Jaccard needed to join on words alone. 0.7 keeps "What is the meaning of net neutrality?"
// with "What is net neutrality?" but not "Can we play cricket with Pakistan?" with "Do you play cricket?".
const JOIN_LEXICAL = 0.7;
// Joining on embeddings. Measured on the 2020-2025 Gemini parse (256-dim gemini-embedding-001): pairs at
// 0.96+ are almost always the same question reworded, about half at 0.94-0.96, and below 0.92 mostly
// related-but-different questions ("Why so many nurses from Kerala?" / "Why so many doctors but not
// enough nurses?"). 0.95 with some shared words, between questions of similar length, keeps "asked N
// times" to real repeats; the old 0.87 / 0.25 turned families into whole topics.
const JOIN_SEMANTIC = 0.95;
const SEMANTIC_MIN_LEXICAL = 0.4;
const MAX_LENGTH_RATIO = 1.8; // content words, longer / shorter
// A two-word leader ("Why civil services?") would otherwise take in any longer question with those words.
const MAX_LEXICAL_LENGTH_RATIO = 2;
const CANDIDATE_TOKENS = 3;

export const cosine = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalised before they get here
};

const weightedJaccard = (a, b, idf) => {
  let inter = 0;
  let union = 0;
  for (const t of a) { const w = idf.get(t) || 1; union += w; if (b.has(t)) inter += w; }
  for (const t of b) if (!a.has(t)) union += idf.get(t) || 1;
  return union ? inter / union : 0;
};

// Two questions anchored to different DAF items of the same kind ("Why Hindi literature as your
// optional?" / "Why Gujarati literature...?") are different questions however alike they read.
const hooksConflict = (a, b) => {
  if (!a?.length || !b?.length) return false;
  for (const h of a) {
    if (!h.value) continue;
    const other = b.filter((x) => x.type === h.type && x.value);
    if (other.length && !other.some((x) => x.value === h.value)) return true;
  }
  return false;
};

// questions: [{ key, text, trivial, embedding?, hooks? }] in a stable order.
// Returns { families: [{ key, leaderKey, memberKeys }], familyOf: Map(questionKey -> familyKey) }
export const clusterQuestions = (questions, opts = {}) => {
  const { joinLexical = JOIN_LEXICAL, joinSemantic = JOIN_SEMANTIC, semanticMinLexical = SEMANTIC_MIN_LEXICAL, maxLengthRatio = MAX_LENGTH_RATIO, maxLexicalLengthRatio = MAX_LEXICAL_LENGTH_RATIO } = opts;
  const toks = new Map();
  const df = new Map();
  for (const q of questions) {
    if (q.trivial) continue;
    const set = new Set(tokenize(q.text));
    if (set.size < 2) continue;
    toks.set(q.key, set);
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = toks.size || 1;
  const idf = new Map([...df].map(([t, c]) => [t, Math.log(1 + n / c)]));

  const families = [];
  const familyOf = new Map();
  const index = new Map(); // token -> [family index]
  const byKey = new Map(questions.map((q) => [q.key, q]));

  // Shorter questions first: "What is net neutrality?" leads, longer phrasings of it join.
  const order = [...toks.keys()].sort((a, b) => toks.get(a).size - toks.get(b).size || a.localeCompare(b));
  for (const key of order) {
    const set = toks.get(key);
    const q = byKey.get(key);
    const rare = [...set].sort((a, b) => (idf.get(b) || 0) - (idf.get(a) || 0)).slice(0, CANDIDATE_TOKENS);
    const seen = new Set();
    let best = null;
    for (const t of rare) {
      for (const fi of index.get(t) || []) {
        if (seen.has(fi)) continue;
        seen.add(fi);
        const fam = families[fi];
        if (hooksConflict(q.hooks, fam.hooks)) continue;
        const lex = weightedJaccard(set, fam.tokens, idf);
        const ratio = Math.max(set.size, fam.tokens.size) / Math.min(set.size, fam.tokens.size);
        let score = lex >= joinLexical && ratio <= maxLexicalLengthRatio ? lex : 0;
        if (!score && lex >= semanticMinLexical && q.embedding && fam.embedding && ratio <= maxLengthRatio) {
          const cos = cosine(q.embedding, fam.embedding);
          if (cos >= joinSemantic) score = cos * 0.7;
        }
        if (score && (!best || score > best.score)) best = { fi, score };
      }
    }
    if (best) {
      families[best.fi].memberKeys.push(key);
      familyOf.set(key, families[best.fi].key);
    } else {
      const fi = families.length;
      const fam = { key: `f${fi + 1}`, leaderKey: key, memberKeys: [key], tokens: set, embedding: q.embedding || null, hooks: q.hooks || null };
      families.push(fam);
      familyOf.set(key, fam.key);
      for (const t of rare) {
        if (!index.has(t)) index.set(t, []);
        index.get(t).push(fi);
      }
    }
  }
  return { families: families.map(({ key, leaderKey, memberKeys }) => ({ key, leaderKey, memberKeys })), familyOf };
};

// The wording shown for a family: the most common phrasing among its members, preferring one that reads
// as a proper question (ends in "?", not too short or long).
export const representativeText = (texts) => {
  const counts = new Map();
  for (const t of texts) {
    const k = normalizeText(t);
    if (!counts.has(k)) counts.set(k, { n: 0, text: t });
    counts.get(k).n += 1;
  }
  const scored = [...counts.values()].map(({ n, text }) => {
    let s = n * 3;
    if (/\?\s*$/.test(text)) s += 2;
    if (text.length >= 15 && text.length <= 160) s += 2;
    if (/^[A-Z]/.test(text)) s += 1;
    if (/[ऀ-ॿ]/.test(text)) s -= 2; // the bank is searched mostly in English
    return { s, text };
  });
  scored.sort((a, b) => b.s - a.s || a.text.length - b.text.length);
  const best = scored[0]?.text || '';
  return /^[a-z]/.test(best) ? best[0].toUpperCase() + best.slice(1) : best;
};
