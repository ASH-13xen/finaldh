// Turns parsed transcripts (from either parser) into the three collections the app reads: transcripts,
// tagged questions, and question families with their "asked N times" statistics.
import { tagQuestion, isTrivialQuestion, TOPIC_LABELS, HOOK_TYPES, QTYPES } from './taxonomy.js';
import { clusterQuestions, representativeText } from './families.js';
import { normalizeText, tokenize, canonicalBoard, canonicalOptional, canonicalState, uniq } from './text.js';

export const ASKERS = ['chairman', 'm1', 'm2', 'm3', 'm4', 'm5', 'member', 'unknown'];
const HOOK_PLACEHOLDER = 'xhookx';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "History of kabaddi and its link to the Mahabharata?" hooked on hobby:kabaddi ->
// { pattern: 'history xhookx link mahabharata', patternText: 'History of {X} and its link to the Mahabharata?' }
export const maskHook = (text, value, type = '') => {
  if (!value) return null;
  const re = new RegExp(`\\b${value.split(/\s+/).map(escapeRe).join('[\\s\\-]+')}\\b`, 'i');
  if (!re.test(text)) return null;
  const patternText = text.replace(re, '{X}');
  const pattern = tokenize(patternText.replace('{X}', ` ${HOOK_PLACEHOLDER} `)).join(' ');
  if (!pattern.includes(HOOK_PLACEHOLDER) || pattern.split(' ').length < 2) return null;
  return { pattern, patternText, type };
};

const cleanList = (arr, max = 20) => uniq((arr || []).map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2 && s.length <= 100)).slice(0, max);

const sanitizeProfile = (p = {}, engine) => ({
  board: canonicalBoard(p.board || p.boardRaw || '', { allowUnknown: engine === 'gemini' }) || '',
  boardRaw: String(p.boardRaw || p.board || '').slice(0, 120),
  date: String(p.date || '').slice(0, 80),
  session: ['FN', 'AN'].includes(p.session) ? p.session : '',
  optional: canonicalOptional(p.optional || '') || '',
  homeState: canonicalState(p.homeState || '') || '',
  home: String(p.home || p.homeDistrict || '').slice(0, 120),
  keywords: cleanList(p.keywords, 30),
  hobbies: cleanList(p.hobbies, 15),
  education: cleanList(p.education, 10),
  work: cleanList(p.work, 10),
  achievements: cleanList(p.achievements, 15),
  servicePreference: String(p.servicePreference || '').slice(0, 120),
  duration: String(p.duration || '').slice(0, 40)
});

const pickTags = (q, profile) => {
  const auto = tagQuestion(q.text, profile);
  const hooks = Array.isArray(q.hooks) && q.hooks.length
    ? q.hooks.filter((h) => h && HOOK_TYPES[h.type]).map((h) => ({ type: h.type, value: normalizeText(h.value || '').slice(0, 60) }))
    : auto.hooks;
  const topics = Array.isArray(q.topics) && q.topics.length ? q.topics.filter((t) => TOPIC_LABELS[t]).slice(0, 2) : auto.topics;
  return {
    hooks,
    topics: topics.length ? topics : auto.topics,
    qtype: QTYPES[q.qtype] ? q.qtype : auto.qtype,
    shelfLife: q.shelfLife === 'event' || q.shelfLife === 'evergreen' ? q.shelfLife : auto.shelfLife
  };
};

const countBy = (arr) => {
  const m = {};
  for (const x of arr) if (x !== undefined && x !== null && x !== '') m[x] = (m[x] || 0) + 1;
  return m;
};
const topKeys = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const majority = (arr, fallback) => topKeys(countBy(arr), 1)[0] || fallback;

// The compilations sometimes contain the same transcript twice (a post shared again). A transcript whose
// questions are mostly the same as an earlier one's in the same year is left out, so it isn't counted
// as a second interview.
const dropReposts = (list) => {
  const seenBy = new Map(); // normalised question -> indexes of kept transcripts
  const kept = [];
  let dropped = 0;
  for (const t of list) {
    const qs = [...new Set((t.questions || []).map((q) => normalizeText(q.text)).filter((k) => k.length > 8))];
    const overlap = new Map();
    for (const k of qs) for (const i of seenBy.get(k) || []) overlap.set(i, (overlap.get(i) || 0) + 1);
    const repost = [...overlap].some(([i, n]) => n >= Math.max(3, 0.7 * Math.min(qs.length, kept[i].size)));
    if (repost) { dropped++; continue; }
    const idx = kept.length;
    kept.push({ t, size: qs.length });
    for (const k of qs) {
      if (!seenBy.has(k)) seenBy.set(k, []);
      seenBy.get(k).push(idx);
    }
  }
  return { list: kept.map((k) => k.t), dropped };
};

// parsedYears: [{ year, engine, transcripts }]. embeddings (optional): Map(normalizedText -> Float32Array).
export const buildCorpus = (parsedYears, { embeddings = null } = {}) => {
  const transcripts = [];
  const questions = [];
  let reposts = 0;
  for (const { year, engine, transcripts: all } of parsedYears) {
    const { list, dropped } = dropReposts(all);
    reposts += dropped;
    for (const t of list) {
      const key = `${year}-${t.seq}`;
      const profile = sanitizeProfile(t.profile, engine);
      const qs = (t.questions || []).filter((q) => q && q.text && String(q.text).trim().length >= 4);
      transcripts.push({
        key, year, seq: t.seq, engine,
        pageStart: t.pageStart || null, pageEnd: t.pageEnd || null,
        profile,
        experience: String(t.experience || '').slice(0, 1500),
        rawText: String(t.rawText || ''),
        questionCount: qs.length
      });
      qs.forEach((q, i) => {
        const text = String(q.text).replace(/\s+/g, ' ').trim().slice(0, 600);
        const tags = pickTags({ ...q, text }, profile);
        const masked = tags.hooks.map((h) => maskHook(text, h.value, h.type)).find(Boolean) || null;
        questions.push({
          key: `${key}-${i + 1}`,
          transcriptKey: key,
          year,
          board: profile.board,
          order: i + 1,
          asker: ASKERS.includes(q.asker) ? q.asker : 'unknown',
          text,
          originalText: q.originalText && q.originalText !== text ? String(q.originalText).slice(0, 600) : '',
          followUp: !!q.followUp,
          note: String(q.note || '').slice(0, 600),
          ...tags,
          trivial: isTrivialQuestion(text),
          pattern: masked?.pattern || '',
          patternText: masked?.patternText || '',
          patternType: masked?.type || '',
          familyKey: null
        });
      });
    }
  }

  const byKey = new Map(questions.map((q) => [q.key, q]));
  const { families: groups, familyOf } = clusterQuestions(
    questions.map((q) => ({ key: q.key, text: q.text, trivial: q.trivial, embedding: embeddings?.get(normalizeText(q.text)) || null }))
  );
  for (const [qk, fk] of familyOf) byKey.get(qk).familyKey = fk;

  const families = groups.map((g) => {
    const members = g.memberKeys.map((k) => byKey.get(k));
    const years = members.map((m) => m.year);
    return {
      key: g.key,
      text: representativeText(members.map((m) => m.text)),
      size: members.length,
      transcriptCount: new Set(members.map((m) => m.transcriptKey)).size,
      years: uniq(years).sort(),
      yearCounts: countBy(years),
      firstYear: Math.min(...years),
      lastYear: Math.max(...years),
      boards: topKeys(countBy(members.map((m) => m.board)), 12),
      boardCounts: Object.entries(countBy(members.map((m) => m.board))).map(([board, n]) => ({ board, n })),
      topics: topKeys(countBy(members.flatMap((m) => m.topics)), 2),
      hookTypes: topKeys(countBy(members.flatMap((m) => m.hooks.map((h) => h.type))), 4),
      hookValues: topKeys(countBy(members.flatMap((m) => m.hooks.map((h) => h.value))), 12),
      askers: countBy(members.map((m) => m.asker)),
      qtype: majority(members.map((m) => m.qtype), 'other'),
      shelfLife: majority(members.map((m) => m.shelfLife), 'evergreen')
    };
  });

  return { transcripts, questions, families, reposts };
};

// Corpus-wide numbers for the landing page.
export const corpusStats = ({ transcripts, questions, families }) => ({
  transcripts: transcripts.length,
  questions: questions.length,
  families: families.length,
  repeatedFamilies: families.filter((f) => f.transcriptCount >= 2).length,
  years: uniq(transcripts.map((t) => t.year)).sort(),
  boards: uniq(transcripts.map((t) => t.profile.board)).length
});
