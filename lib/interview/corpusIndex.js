// In-memory search over the question families (a few tens of thousands of short texts - small enough to
// hold in the process, and it keeps the bank working without an Atlas Search index). BM25 on words, plus
// cosine similarity on Gemini embeddings when the corpus has them.
//
// Sized for a 512 MB server (Render free/starter): families are read from the database one at a time,
// the small lists most families share ([2023], ["Manoj Soni"], {chairman: 1}) are stored once and shared,
// word postings and vectors are typed arrays. ~65k families take ~45 MB here instead of ~160 MB.
//
// Rebuilt after a seed or an admin edit in this process (invalidateCorpusIndex), when the collections'
// sizes change (checked cheaply every CHECK_MS, for seeds run from elsewhere), or every REFRESH_MS. While
// a refresh builds, requests keep getting the previous index.
import InterviewFamily from '../../models/InterviewFamily.js';
import InterviewQuestion from '../../models/InterviewQuestion.js';
import InterviewTranscript from '../../models/InterviewTranscript.js';
import { tokenize, normalizeText, uniq } from './text.js';
import { TOPIC_LABELS, HOOK_TYPES } from './taxonomy.js';

const REFRESH_MS = 6 * 60 * 60 * 1000;
const CHECK_MS = 15 * 60 * 1000;
const CONTEXT_WORDS = /\b(she|he|her|him|his|they|them|it|this|that|these|those|other|again|also|then|so)\b/i;
const K1 = 1.2;
const B = 0.75;

let current = null;
let building = null;
let generation = 0;

export const invalidateCorpusIndex = () => {
  generation += 1;
  current = null;
};

const mapToObj = (m) => (m instanceof Map ? Object.fromEntries(m) : m || {});

// One shared, frozen copy of each distinct small list/object. Frozen so a caller that tried to modify a
// family's list in place (which would change every family sharing it) fails loudly instead.
const makeInterner = () => {
  const seen = new Map();
  return (value) => {
    const key = JSON.stringify(value);
    let v = seen.get(key);
    if (!v) { v = Object.freeze(value); seen.set(key, v); }
    return v;
  };
};

// A stored family vector (int8 bytes, as written by seed) as an Int8Array view, without copying.
const int8Of = (v) => {
  if (v && !(v instanceof Uint8Array) && v.buffer instanceof Uint8Array) v = v.buffer; // bson Binary
  return v instanceof Uint8Array ? new Int8Array(v.buffer, v.byteOffset, v.byteLength) : null;
};

const sizes = () => Promise.all([InterviewFamily, InterviewQuestion, InterviewTranscript].map((M) => M.estimatedDocumentCount())).then((a) => a.join('/'));

const FAMILY_FIELDS = 'text size transcriptCount years yearCounts firstYear lastYear boards boardCounts topics hookTypes hookValues askers qtype shelfLife +vec';

const build = async () => {
  const gen = generation;
  const [familyCount, transcriptCount, questionCount, yearsAgg, fingerprint] = await Promise.all([
    InterviewFamily.countDocuments({ hidden: { $ne: true } }),
    InterviewTranscript.countDocuments({ hidden: { $ne: true } }),
    InterviewQuestion.countDocuments({ hidden: { $ne: true } }),
    InterviewTranscript.aggregate([{ $match: { hidden: { $ne: true } } }, { $group: { _id: '$year', n: { $sum: 1 } } }]),
    sizes()
  ]);

  const intern = makeInterner();
  const internStr = makeInterner();
  const families = [];
  const byId = new Map();
  const postingLists = new Map(); // term -> [i, tf, i, tf, ...] while building
  let lensArr = [];
  let dims = 0;
  let vectors = null;
  let withVec = 0;

  for await (const f of InterviewFamily.find({ hidden: { $ne: true } }).select(FAMILY_FIELDS).lean().cursor({ batchSize: 2000 })) {
    const i = families.length;
    const fam = {
      id: String(f._id),
      text: f.text,
      size: f.size,
      transcriptCount: f.transcriptCount,
      years: intern(f.years || []),
      yearCounts: intern(mapToObj(f.yearCounts)),
      firstYear: f.firstYear,
      lastYear: f.lastYear,
      boards: intern(f.boards || []),
      boardCounts: intern(Object.fromEntries((f.boardCounts || []).map((b) => [b.board, b.n]))),
      topics: intern(f.topics || []),
      hookTypes: intern(f.hookTypes || []),
      hookValues: intern(f.hookValues || []),
      askers: intern(mapToObj(f.askers)),
      qtype: internStr(f.qtype),
      shelfLife: internStr(f.shelfLife)
    };
    families.push(fam);
    byId.set(fam.id, i);

    // BM25 postings over the family wording plus the DAF items it was asked about.
    const toks = tokenize(`${fam.text} ${fam.hookValues.join(' ')}`);
    lensArr.push(toks.length || 1);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      let list = postingLists.get(t);
      if (!list) { list = []; postingLists.set(t, list); }
      list.push(i, n);
    }

    // Family vectors stay int8 (1 byte per dimension): ~16 MB for 64k families at 256 dims.
    const v = int8Of(f.vec);
    if (v && v.length) {
      if (!dims) dims = v.length;
      if (v.length === dims) {
        if (!vectors) vectors = new Int8Array(Math.max(familyCount, 1) * dims);
        if ((i + 1) * dims > vectors.length) { const grown = new Int8Array(Math.ceil((i + 1) * 1.25) * dims); grown.set(vectors); vectors = grown; }
        vectors.set(v, i * dims);
        withVec++;
      }
    }
  }
  if (vectors && withVec <= families.length * 0.5) { vectors = null; dims = 0; }
  if (vectors && vectors.length !== families.length * dims) vectors = vectors.slice(0, families.length * dims);
  // 1 / length of each int8 vector, so scores are exact cosines (as if each were dequantized + normalised).
  let invNorms = null;
  if (vectors) {
    invNorms = new Float32Array(families.length);
    for (let i = 0; i < families.length; i++) {
      let s = 0;
      for (let d = i * dims, end = d + dims; d < end; d++) s += vectors[d] * vectors[d];
      invNorms[i] = s ? 1 / Math.sqrt(s) : 0;
    }
  }

  const lens = Float32Array.from(lensArr);
  lensArr = null;
  const avgLen = lens.reduce((a, b) => a + b, 0) / (families.length || 1);
  // term -> { ids: Int32Array, tfs: Uint8Array }: a few MB instead of ~30 MB of [i, tf] pairs.
  const postings = new Map();
  for (const [t, list] of postingLists) {
    const n = list.length / 2;
    const ids = new Int32Array(n);
    const tfs = new Uint8Array(n);
    for (let k = 0; k < n; k++) { ids[k] = list[2 * k]; tfs[k] = Math.min(255, list[2 * k + 1]); }
    postings.set(t, { ids, tfs });
  }
  postingLists.clear();

  // "{X}" templates asked for at least two different DAF items: "History of {X}?" (cricket, chess, kho kho)
  const groups = new Map();
  for await (const q of InterviewQuestion.find({ pattern: { $gt: '' }, hidden: { $ne: true } }).select('pattern patternText patternType hooks year transcript family').lean().cursor({ batchSize: 2000 })) {
    const k = `${q.patternType}|${q.pattern}`;
    if (!groups.has(k)) groups.set(k, { type: q.patternType, pattern: q.pattern, texts: [], values: new Set(), transcripts: new Set(), years: new Set(), families: new Set() });
    const g = groups.get(k);
    g.texts.push(q.patternText);
    const v = (q.hooks || []).find((h) => h.type === q.patternType && h.value)?.value;
    if (v) g.values.add(v);
    g.transcripts.add(String(q.transcript));
    g.years.add(q.year);
    if (q.family) g.families.add(String(q.family));
  }
  const templates = [];
  for (const g of groups.values()) {
    if (g.values.size < 2 || g.transcripts.size < 2 || !HOOK_TYPES[g.type]) continue;
    // "Gaming (hobby)?" says too little to reuse; "Is she famous in {X}?" depends on its original context.
    if (g.pattern.split(' ').filter((w) => w !== 'xhookx').length < 2) continue;
    if (g.texts.every((t) => CONTEXT_WORDS.test(t.replace('{X}', '')))) continue;
    const counts = new Map();
    for (const t of g.texts) if (!CONTEXT_WORDS.test(t.replace('{X}', ''))) counts.set(t, (counts.get(t) || 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const text = best.charAt(0).toUpperCase() + best.slice(1);
    templates.push({
      type: g.type,
      pattern: g.pattern,
      text,
      values: [...g.values].slice(0, 8),
      valueCount: g.values.size,
      timesAsked: g.texts.length,
      transcriptCount: g.transcripts.size,
      years: [...g.years].sort(),
      familyIds: [...g.families].slice(0, 20)
    });
  }
  templates.sort((a, b) => b.transcriptCount - a.transcriptCount);

  // Facets and trends for the bank's filters and charts.
  const facet = { years: {}, boards: {}, topics: {}, hookTypes: {}, qtypes: {} };
  const topicByYear = {};
  for (const f of families) {
    for (const y of f.years) facet.years[y] = (facet.years[y] || 0) + 1;
    for (const [b, n] of Object.entries(f.boardCounts)) if (b) facet.boards[b] = (facet.boards[b] || 0) + n;
    for (const t of f.topics) facet.topics[t] = (facet.topics[t] || 0) + 1;
    for (const h of f.hookTypes) facet.hookTypes[h] = (facet.hookTypes[h] || 0) + 1;
    facet.qtypes[f.qtype] = (facet.qtypes[f.qtype] || 0) + 1;
    const topic = f.topics[0] || 'general';
    for (const [y, n] of Object.entries(f.yearCounts)) {
      topicByYear[topic] = topicByYear[topic] || {};
      topicByYear[topic][y] = (topicByYear[topic][y] || 0) + n;
    }
  }

  const index = {
    gen,
    builtAt: Date.now(),
    checkedAt: Date.now(),
    fingerprint,
    families,
    byId,
    postings,
    lens,
    avgLen,
    dims,
    vectors,
    invNorms,
    templates,
    facet,
    topicByYear,
    stats: {
      transcripts: transcriptCount,
      questions: questionCount,
      families: families.length,
      repeatedFamilies: families.filter((f) => f.transcriptCount >= 2).length,
      years: yearsAgg.map((y) => y._id).sort(),
      transcriptsByYear: Object.fromEntries(yearsAgg.map((y) => [y._id, y.n])),
      boards: Object.keys(facet.boards).length,
      semantic: !!vectors
    }
  };
  return index;
};

const startBuild = () => {
  if (!building) {
    building = build()
      .then((idx) => { if (idx.gen === generation) current = idx; return idx; })
      .finally(() => { building = null; });
  }
  return building;
};

// Every CHECK_MS, compare the collections' sizes (a metadata read, no scan) with the ones the index was
// built from; a seed run from another process changes them. Runs in the background.
const checkForChanges = (idx) => {
  idx.checkedAt = Date.now();
  sizes()
    .then((fp) => { if (fp !== idx.fingerprint && current === idx && !building) startBuild().catch((err) => console.error('[interview] index rebuild failed:', err)); })
    .catch(() => {});
};

export const getCorpusIndex = async () => {
  const idx = current && current.gen === generation ? current : null;
  if (!idx) return startBuild();
  // Stale: keep answering from this index while the new one builds.
  if (Date.now() - idx.builtAt >= REFRESH_MS) startBuild().catch((err) => console.error('[interview] index refresh failed:', err));
  else if (Date.now() - idx.checkedAt >= CHECK_MS) checkForChanges(idx);
  return idx;
};

// ------------------------------------------------------------------ querying

const bm25 = (idx, query) => {
  const scores = new Map();
  const toks = uniq(tokenize(query));
  const n = idx.families.length || 1;
  for (const t of toks) {
    const list = idx.postings.get(t);
    if (!list) continue;
    const { ids, tfs } = list;
    const idf = Math.log(1 + (n - ids.length + 0.5) / (ids.length + 0.5));
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k];
      const tf = tfs[k];
      const s = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * idx.lens[i]) / idx.avgLen)));
      scores.set(i, (scores.get(i) || 0) + s);
    }
  }
  return scores;
};

const vectorScores = (idx, queryVec, topK = 300) => {
  if (!idx.vectors || !queryVec || queryVec.length !== idx.dims) return new Map();
  const { dims, vectors, families } = idx;
  const n = families.length;
  // Cosine against int8 vectors: divide by both lengths (the query may be a float embedding or, from
  // relatedFamilies, another int8 family vector).
  let qn = 0;
  for (let d = 0; d < dims; d++) qn += queryVec[d] * queryVec[d];
  const qInv = qn ? 1 / Math.sqrt(qn) : 0;
  const { invNorms } = idx;
  const dots = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const o = i * dims;
    for (let d = 0; d < dims; d++) dot += vectors[o + d] * queryVec[d];
    dots[i] = dot * qInv * (invNorms ? invNorms[i] : 1);
  }
  // Top K without sorting all n scores: keep a small sorted list.
  const top = [];
  let floor = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = dots[i];
    if (top.length >= topK && s <= floor) continue;
    let j = top.length;
    while (j > 0 && dots[top[j - 1]] < s) j--;
    top.splice(j, 0, i);
    if (top.length > topK) top.pop();
    if (top.length >= topK) floor = dots[top[top.length - 1]];
  }
  return new Map(top.map((i) => [i, dots[i]]));
};

const passes = (f, flt) => {
  if (flt.year && !f.years.includes(Number(flt.year))) return false;
  if (flt.board && !f.boardCounts[flt.board]) return false;
  if (flt.topic && !f.topics.includes(flt.topic)) return false;
  if (flt.hookType && !f.hookTypes.includes(flt.hookType)) return false;
  if (flt.asker && !f.askers[flt.asker]) return false;
  if (flt.qtype && f.qtype !== flt.qtype) return false;
  if (flt.shelfLife && f.shelfLife !== flt.shelfLife) return false;
  if (flt.minAsked && f.transcriptCount < Number(flt.minAsked)) return false;
  return true;
};

const popularity = (f) => 1 + Math.log(1 + f.transcriptCount) * 0.35 + (f.lastYear >= 2023 ? 0.08 : 0);

export const summarizeFamily = (f) => ({
  id: f.id,
  text: f.text,
  timesAsked: f.transcriptCount,
  size: f.size,
  years: f.years,
  yearCounts: f.yearCounts,
  lastYear: f.lastYear,
  boards: f.boards.slice(0, 4),
  topics: f.topics,
  topicLabels: f.topics.map((t) => TOPIC_LABELS[t] || t),
  hookTypes: f.hookTypes,
  hookValues: f.hookValues.slice(0, 6),
  qtype: f.qtype,
  shelfLife: f.shelfLife,
  askers: f.askers
});

// Families matching a text query and filters. sort: relevance | asked | recent.
export const searchFamilies = (idx, { q = '', filters = {}, sort = 'relevance', offset = 0, limit = 20, queryVec = null } = {}) => {
  let scored;
  if (q && q.trim()) {
    const lex = bm25(idx, q);
    const vec = vectorScores(idx, queryVec);
    const maxLex = Math.max(1e-9, ...lex.values());
    const all = new Set([...lex.keys(), ...vec.keys()]);
    scored = [];
    for (const i of all) {
      const f = idx.families[i];
      if (!passes(f, filters)) continue;
      const l = (lex.get(i) || 0) / maxLex;
      const v = vec.has(i) ? Math.max(0, (vec.get(i) - 0.45) / 0.55) : 0;
      const s = (vec.size ? l * 0.55 + v * 0.45 : l) * popularity(f);
      if (s > 0.02) scored.push([i, s]);
    }
  } else {
    scored = [];
    idx.families.forEach((f, i) => { if (passes(f, filters)) scored.push([i, popularity(f)]); });
  }
  const fam = (i) => idx.families[i];
  if (sort === 'asked' || (!q && sort === 'relevance')) scored.sort((a, b) => fam(b[0]).transcriptCount - fam(a[0]).transcriptCount || b[1] - a[1]);
  else if (sort === 'recent') scored.sort((a, b) => fam(b[0]).lastYear - fam(a[0]).lastYear || fam(b[0]).transcriptCount - fam(a[0]).transcriptCount);
  else scored.sort((a, b) => b[1] - a[1]);
  return {
    total: scored.length,
    items: scored.slice(offset, offset + limit).map(([i, s]) => ({ ...summarizeFamily(fam(i)), score: Math.round(s * 1000) / 1000 }))
  };
};

// Families whose DAF hook matched a term exactly (asked to candidates who had "cricket" in their DAF).
export const familiesByHookValue = (idx, value, type) => {
  const v = normalizeText(value);
  if (!v) return [];
  const out = [];
  idx.families.forEach((f, i) => {
    if (f.hookValues.includes(v) && (!type || f.hookTypes.includes(type))) out.push(i);
  });
  return out.map((i) => idx.families[i]).sort((a, b) => b.transcriptCount - a.transcriptCount);
};

export const familyById = (idx, id) => {
  const i = idx.byId.get(String(id));
  return i === undefined ? null : idx.families[i];
};

// Families similar to one family (by embedding when available, otherwise by its wording).
export const relatedFamilies = (idx, id, limit = 6) => {
  const i = idx.byId.get(String(id));
  if (i === undefined) return [];
  const f = idx.families[i];
  const queryVec = idx.vectors ? idx.vectors.subarray(i * idx.dims, (i + 1) * idx.dims) : null;
  return searchFamilies(idx, { q: f.text, queryVec, limit: limit + 1 }).items.filter((x) => x.id !== f.id).slice(0, limit);
};

export const templatesFor = (idx, type, limit = 8) => idx.templates.filter((t) => t.type === type).slice(0, limit);

export const topFamilies = (idx, filters = {}, limit = 10) => searchFamilies(idx, { filters, sort: 'asked', limit }).items;
