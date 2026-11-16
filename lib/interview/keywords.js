// Clean DAF keywords. `pipeline.mjs normalize` (Gemini, once) maps every raw hobby / education / work /
// home string in the transcripts - candidates' DAFs and the DAF items questions were about - to a canonical
// keyword, so "playing cricket" and "Cricket" are one hobby and "Computer Engg., NIT Surat" is
// B.Tech · Computer Science · NIT Surat. The table rides along in the corpus meta; the build groups
// candidates and questions with it, and a student's own DAF is matched the same way at runtime.
//
// Table rows (compact): hobby [label, group] · education [degree, discipline, college, collegeGroup] ·
// work [job, sector] · home [district, state].
import { uniq, canonicalOptional, canonicalState } from './text.js';

export const keyOf = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);

export const KEYWORD_TYPES = ['hobby', 'education', 'work', 'home'];

// What a hook (a DAF item a question was about) is called once cleaned up.
export const hookLabel = (K, type, value) => {
  const v = keyOf(value);
  if (!v) return '';
  if (type === 'hobby' || type === 'eca') return K?.hobby?.[v]?.[0] || '';
  if (type === 'education') {
    const r = K?.education?.[v];
    return r ? r[2] || r[1] || r[0] || '' : '';
  }
  if (type === 'work') return K?.work?.[v]?.[0] || '';
  if (type === 'home') {
    const r = K?.home?.[v];
    return r ? r[1] || '' : canonicalState(value) || '';
  }
  if (type === 'optional') return canonicalOptional(value) || '';
  return '';
};

// A transcript's DAF in clean keywords.
export const normProfile = (K, p = {}) => {
  const hob = (p.hobbies || []).map((h) => K?.hobby?.[keyOf(h)]).filter((r) => r && r[0]);
  const edu = (p.education || []).map((e) => K?.education?.[keyOf(e)]).filter(Boolean);
  const work = (p.work || []).map((w) => K?.work?.[keyOf(w)]).filter((r) => r && r[0]);
  const homeKey = keyOf([p.home, p.homeState].filter(Boolean).join(', '));
  const home = (homeKey && K?.home?.[homeKey]) || null;
  return {
    hobbies: uniq(hob.map((r) => r[0])),
    hobbyGroups: uniq(hob.map((r) => r[1]).filter(Boolean)),
    degrees: uniq(edu.map((r) => r[0]).filter(Boolean)),
    disciplines: uniq(edu.map((r) => r[1]).filter(Boolean)),
    colleges: uniq(edu.map((r) => r[2]).filter(Boolean)),
    collegeGroups: uniq(edu.map((r) => r[3]).filter(Boolean)),
    jobs: uniq(work.map((r) => r[0])),
    sectors: uniq(work.map((r) => r[1]).filter(Boolean)),
    district: home?.[0] || '',
    state: canonicalState(home?.[1] || p.homeState || '') || ''
  };
};

const words = (s) => new Set(keyOf(s).replace(/[^a-z0-9& ]+/g, ' ').split(' ').filter((w) => w.length > 1));
const jaccard = (a, b) => {
  let i = 0;
  for (const w of a) if (b.has(w)) i++;
  return i ? i / (a.size + b.size - i) : 0;
};

// The canonical keywords of one kind, for matching a student's free text against.
export const labelsOf = (K, type, col = 0) => uniq(Object.values(K?.[type] || {}).map((r) => r[col]).filter(Boolean));

// A student's free text -> the canonical keyword: an exact table hit, else the closest label by words.
export const matchKeyword = (K, type, raw, { col = 0, labels = null, min = 0.5 } = {}) => {
  const hit = K?.[type]?.[keyOf(raw)];
  if (hit && hit[col]) return hit[col];
  const w = words(raw);
  if (!w.size) return '';
  let best = { s: 0, label: '' };
  for (const label of labels || labelsOf(K, type, col)) {
    const s = jaccard(w, words(label));
    if (s > best.s) best = { s, label };
  }
  return best.s >= min ? best.label : '';
};
