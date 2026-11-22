import mongoose from 'mongoose';
import InterviewProfile from '../models/InterviewProfile.js';
import InterviewSession from '../models/InterviewSession.js';
import InterviewQuestion from '../models/InterviewQuestion.js';
import InterviewTranscript from '../models/InterviewTranscript.js';
import { getCorpusIndex, searchFamilies, familyById, relatedFamilies, summarizeFamily, familiesByKeys, OFTEN } from '../lib/interview/corpusIndex.js';
import { buildPredictions, profileHash, profileItems, keywordFor } from '../lib/interview/predict.js';
import { planSession, openSession, answerCurrent, buildReport, sessionPayload, closingLine, pauseSession, resumeSession, PANEL, TRAITS } from '../lib/interview/interviewer.js';
import { FORMATS, DEFAULT_FORMAT, formatOf, formatFromMinutes, TEMPERAMENTS, DEFAULT_TEMPERAMENT } from '../lib/interview/board.js';
import { cleanProfileInput, transcribeAnswer, isProfileEmpty, extractDaf, SERVICES } from '../lib/interview/daf.js';
import { geminiStatus, checkGemini, embedTexts, generateJson } from '../lib/interview/gemini.js';
import { streamSpeech, SAMPLE_LINES } from '../lib/interview/voice.js';
import { TOPIC_LABELS, HOOK_TYPES, QTYPES } from '../lib/interview/taxonomy.js';
import User from '../models/User.js';
import InterviewPrep from '../models/InterviewPrep.js';
import PracticeAttempt from '../models/PracticeAttempt.js';
import { analyzeAnswer } from '../lib/interview/practice.js';
import InterviewAiCache from '../models/InterviewAiCache.js';
import { textHash } from '../lib/interview/translate.js';
import { PREP_KEY_RE, prepKey } from '../lib/interview/prepKey.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { mockInterviewEnabled } from '../lib/interview/features.js';
import { CREDIT_PACKS, FREE_AI_USES, AI_USES_PER_DAY, FEEDBACK_CREDITS_SHORT, FEEDBACK_CREDITS_LONG, FEEDBACK_SHORT_SECONDS, FEEDBACK_MAX_SECONDS, feedbackCreditsFor, getBalance, spendCredit, spendCredits, refundCredit, refundCredits } from '../lib/interview/credits.js';
import { draftAnswer } from '../lib/interview/answers.js';
import { getDafCheck, dafGateMessage } from '../lib/interview/dafCheck.js';

// Free for now; the caps only stop one account from running up the Gemini bill.
const LIMITS = { sessionsPerDay: 10, predictionRunsPerDay: 15, transcribesPerDay: 400, extractsPerDay: 5, approachesPerDay: 40 };

// The compilations the corpus is built from. Shown on every page that shows transcript data.
const SOURCES = [
  { name: 'Team PTT', detail: 'Interview transcript compilations, CSE 2020–2023 (Telegram: PTT2019 / PTT2023)' },
  { name: '@csetranscripts', detail: 'Interview transcript compilation, CSE 2024 (Telegram)' }
];

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const today = () => new Date().toISOString().slice(0, 10);
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

const ensureProfile = (userId) => InterviewProfile.findOneAndUpdate(
  { user: userId },
  { $setOnInsert: { user: userId } },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);

// Counts one Gemini-backed action against today's allowance. false = limit reached.
const useAllowance = async (userId, field, limit) => {
  const day = today();
  await ensureProfile(userId);
  await InterviewProfile.updateOne(
    { user: userId, 'usage.day': { $ne: day } },
    { $set: { 'usage.day': day, 'usage.predictionRuns': 0, 'usage.transcribes': 0, 'usage.extracts': 0, 'usage.approaches': 0, 'usage.practiceAI': 0, 'usage.aiUses': 0 } }
  );
  const r = await InterviewProfile.updateOne(
    { user: userId, 'usage.day': day, [`usage.${field}`]: { $lt: limit } },
    { $inc: { [`usage.${field}`]: 1 } }
  );
  return r.modifiedCount === 1;
};

const publicProfile = (p) => {
  if (!p) return null;
  const { _id, user, predictionCache, usage, __v, ...rest } = p.toObject ? p.toObject() : p;
  return { ...rest, id: String(_id) };
};

const aiPayload = () => {
  const s = geminiStatus();
  return { available: s.available, configured: s.configured };
};

// ------------------------------------------------------------------ status & profile

export const getStatus = async (req, res) => {
  try {
    const [idx] = await Promise.all([getCorpusIndex(), checkGemini()]);
    res.json({
      ai: aiPayload(),
      corpus: idx.stats,
      sources: SOURCES,
      panel: PANEL.map(({ id, label, focus }) => ({ id, label, focus })),
      traits: TRAITS.map(([key, label]) => ({ key, label })),
      hookTypes: HOOK_TYPES,
      topics: TOPIC_LABELS,
      qtypes: QTYPES,
      services: SERVICES,
      formats: Object.entries(FORMATS).map(([key, f]) => ({ key, label: f.label, questions: f.questions, followUps: f.followUps, about: f.about })),
      defaultFormat: DEFAULT_FORMAT,
      temperaments: Object.entries(TEMPERAMENTS).map(([key, t]) => ({ key, label: t.label, blurb: t.blurb })),
      defaultTemperament: DEFAULT_TEMPERAMENT,
      limits: LIMITS,
      features: { mockInterview: mockInterviewEnabled() },
      // How often boards asked about each DAF area when candidates listed it (see lib/interview/meta.js).
      calibration: idx.meta?.areas || null,
      boardCount: idx.meta?.boards?.length || 0
    });
  } catch (err) {
    console.error('[interview] status error:', err);
    fail(res, 500, 'Could not load the interview section.');
  }
};

export const getProfile = async (req, res) => {
  try {
    const p = await InterviewProfile.findOne({ user: req.userId });
    res.json({ profile: publicProfile(p), items: p ? profileItems(p.toObject()) : [], empty: !p || isProfileEmpty(p) });
  } catch (err) {
    console.error('[interview] getProfile error:', err);
    fail(res, 500, 'Could not load your DAF details.');
  }
};

// Saving the DAF details. Before verification (and an admin's) they're simply saved. Once a student is
// verified, details already saved change only through a paid re-upload: the reviewed fields wait on the
// change until an admin verifies the new DAF (or, if it was verified first, replace the details now).
export const saveProfile = async (req, res) => {
  try {
    const fields = cleanProfileInput(req.body || {});
    const admin = await isAdminRequest(req);
    const before = await InterviewProfile.findOne({ user: req.userId }).lean();
    const verified = before?.dafCheck?.status === 'verified';
    // A student never sets their roll number (it decides whose interview slot they see): it comes only from
    // the DAF they upload (read from the file, checked by an admin when verifying) or from a roll number
    // request with proof (POST /daf/roll), also checked by an admin.
    if (!admin) delete fields.rollNo;
    // Locked once there are details. A verified DAF whose details were never filled in (say the file couldn't
    // be read automatically and the student skipped the form) can still be filled in, free.
    const saved = !!before && !isProfileEmpty(before);
    if (!admin && verified && saved) {
      const change = before.dafChange || {};
      if (change.status === 'pending') {
        await InterviewProfile.updateOne({ user: req.userId }, { $set: { 'dafChange.fields': fields } });
        const current = await InterviewProfile.findOne({ user: req.userId });
        return res.json({ profile: publicProfile(current), items: profileItems(current.toObject()), empty: isProfileEmpty(current), changePending: true });
      }
      if (!(change.status === 'verified' && !change.appliedAt)) {
        return fail(res, 403, 'Your DAF is verified. To change it, re-upload it.', { needReupload: true });
      }
    }
    const extra = verified && before?.dafChange?.status === 'verified' && !before.dafChange.appliedAt ? { 'dafChange.appliedAt': new Date() } : {};
    const p = await InterviewProfile.findOneAndUpdate(
      { user: req.userId },
      { $set: { ...fields, source: 'manual', detailsSavedAt: new Date(), ...extra }, $setOnInsert: { user: req.userId } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ profile: publicProfile(p), items: profileItems(p.toObject()), empty: isProfileEmpty(p) });
    // Have the tailored predictions ready by the time the student opens them (once the DAF is verified).
    warmPredictions(p, req).catch(() => {});
  } catch (err) {
    console.error('[interview] saveProfile error:', err);
    fail(res, 500, 'Could not save your DAF details.');
  }
};

// An uploaded DAF is read by AI and returned for the student to check - nothing is saved until they do,
// and the file itself is never stored.
export const extractProfile = async (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose your DAF file (PDF or a photo).');
  if (!(await checkGemini())) return fail(res, 503, 'We could not read your DAF automatically right now. Please fill in the form - it takes about two minutes.', { aiUnavailable: true });
  try {
    if (!(await useAllowance(req.userId, 'extracts', LIMITS.extractsPerDay))) {
      return fail(res, 429, `You can upload up to ${LIMITS.extractsPerDay} DAF files a day. Please fill in the form by hand.`, { limited: true });
    }
    const { fields, unsure } = await extractDaf(req.file.buffer, req.file.mimetype);
    res.json({ fields, unsure, empty: isProfileEmpty(fields) });
  } catch (err) {
    if (err.name === 'GeminiUnavailableError') return fail(res, 503, 'We could not read your DAF right now. Please fill in the form by hand.', { aiUnavailable: true });
    console.error('[interview] extractProfile error:', err);
    fail(res, 502, 'Could not read that file. Try a clearer PDF or photo, or fill in the form by hand.');
  }
};

// Deletes the DAF details only. The same record holds the student's DAF verification, credits (bought and
// free used) and daily usage, which must survive: deleting it all would wipe paid credits and hand out a
// fresh set of free ones.
const DAF_DETAIL_FIELDS = ['homeState', 'homeDistrict', 'hometown', 'education', 'work', 'optional', 'hobbies', 'achievements', 'servicePreference', 'familyBackground', 'languages', 'otherNotes', 'source', 'predictionCache', 'predictionCaches'];
export const deleteProfile = async (req, res) => {
  try {
    // A verified DAF is changed by re-uploading (deleting and refilling it would be a free change).
    const p = await InterviewProfile.findOne({ user: req.userId }).select('dafCheck').lean();
    if (p?.dafCheck?.status === 'verified' && !(await isAdminRequest(req))) return fail(res, 403, 'Your DAF is verified. To change it, re-upload it.', { needReupload: true });
    await InterviewProfile.updateOne({ user: req.userId }, { $unset: Object.fromEntries(DAF_DETAIL_FIELDS.map((k) => [k, 1])) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview] deleteProfile error:', err);
    fail(res, 500, 'Could not delete your DAF details.');
  }
};

// ------------------------------------------------------------------ predictions

// One Gemini prediction run per student at a time. Resolves to the predictions, or null when the run
// was not allowed (daily limit) or failed; the result is saved only if the DAF has not changed meanwhile.
// Predictions are cached per language: English in predictionCache, others in predictionCaches.<lang>.
const langOf = (req) => (req.query.lang === 'hi' ? 'hi' : 'en');
const cacheOf = (profile, lang) => (lang === 'en' ? profile.predictionCache : profile.predictionCaches?.[lang]);
const cacheSet = (lang, value) => (lang === 'en' ? { predictionCache: value } : { [`predictionCaches.${lang}`]: value });

const building = new Map();
const buildTailored = (profile, idx, hash, lang = 'en') => {
  const key = `${profile.user}:${lang}`;
  if (building.has(key)) return building.get(key);
  const run = (async () => {
    try {
      if (!(await useAllowance(profile.user, 'predictionRuns', LIMITS.predictionRunsPerDay))) return null;
      const data = await buildPredictions(idx, profile.toObject(), { useAI: true, lang });
      const latest = await InterviewProfile.findById(profile._id);
      if (latest && profileHash(latest.toObject(), idx) === hash) {
        await InterviewProfile.updateOne({ _id: profile._id }, { $set: cacheSet(lang, { hash, generatedAt: new Date(), aiUsed: data.aiUsed, data }) });
      }
      return data;
    } catch (err) {
      console.warn('[interview] building predictions failed:', String(err.message).slice(0, 200));
      return null;
    } finally {
      building.delete(key);
    }
  })();
  building.set(key, run);
  return run;
};

// Start a run after the DAF is saved, unless the saved predictions already match it. Only for students whose
// DAF is verified (and admins): an unverified upload costs no AI run - predictions build when first opened.
const warmPredictions = async (profile, req) => {
  if (isProfileEmpty(profile) || !(await checkGemini())) return;
  if (!(await isAdminRequest(req)) && (await getDafCheck(req.userId)).status !== 'verified') return;
  const idx = await getCorpusIndex();
  if (!idx.stats.questions) return;
  const hash = profileHash(profile.toObject(), idx);
  if (profile.predictionCache?.hash === hash && profile.predictionCache.aiUsed) return;
  buildTailored(profile, idx, hash);
};

// Predicted questions need a DAF an admin has verified (admins are never gated).
export const getPredictions = async (req, res) => {
  if (await dafGate(req, res)) return;
  try {
    const lang = langOf(req);
    const profile = await InterviewProfile.findOne({ user: req.userId });
    if (!profile || isProfileEmpty(profile)) return fail(res, 400, 'Add your DAF details first — predictions are built from them.', { needsProfile: true });
    const idx = await getCorpusIndex();
    if (!idx.stats.questions) return fail(res, 503, 'The transcript library is still being loaded. Please try again later.');
    const plain = profile.toObject();
    const hash = profileHash(plain, idx);
    const cache = cacheOf(profile, lang);
    const wantAI = await checkGemini();
    const fresh = cache?.data && cache.hash === hash && (cache.aiUsed || !wantAI);
    // No "rebuild on demand": saved predictions are reused until the DAF changes (each AI run costs money).
    if (fresh) return res.json({ ...cache.data, cached: true, ai: aiPayload() });
    // A run started when the DAF was saved may still be going: wait for it rather than paying twice.
    const runKey = `${req.userId}:${lang}`;
    if (wantAI && building.has(runKey)) {
      const ready = await building.get(runKey);
      if (ready) return res.json({ ...ready, cached: false, ai: aiPayload() });
    }

    let useAI = wantAI;
    if (useAI && !(await useAllowance(req.userId, 'predictionRuns', LIMITS.predictionRunsPerDay))) {
      if (cache?.data && cache.hash === hash) return res.json({ ...cache.data, cached: true, ai: aiPayload(), limited: true });
      useAI = false;
    }
    const data = await buildPredictions(idx, plain, { useAI, lang });
    await InterviewProfile.updateOne({ _id: profile._id }, { $set: cacheSet(lang, { hash, generatedAt: new Date(), aiUsed: data.aiUsed, data }) });
    res.json({ ...data, cached: false, ai: aiPayload() });
  } catch (err) {
    console.error('[interview] getPredictions error:', err);
    fail(res, 500, 'Could not build your predicted questions.');
  }
};

// ------------------------------------------------------------------ question bank

// Query embeddings for the bank search box, kept for a while so paging doesn't re-embed.
const queryVecCache = new Map();
const queryVector = async (q, idx) => {
  if (!idx.stats.semantic || !(await checkGemini())) return null;
  const k = q.trim().toLowerCase();
  if (queryVecCache.has(k)) return queryVecCache.get(k);
  try {
    const [v] = await embedTexts([k], { taskType: 'RETRIEVAL_QUERY' });
    if (queryVecCache.size > 500) queryVecCache.delete(queryVecCache.keys().next().value);
    queryVecCache.set(k, v);
    return v;
  } catch {
    return null;
  }
};

const bankFilters = (q) => {
  const f = {};
  if (q.year && /^\d{4}$/.test(q.year)) f.year = Number(q.year);
  if (q.board) f.board = String(q.board).slice(0, 80);
  if (q.topic && TOPIC_LABELS[q.topic]) f.topic = q.topic;
  if (q.hookType && HOOK_TYPES[q.hookType]) f.hookType = q.hookType;
  if (q.asker && /^(chairman|members|m[1-5]|member)$/.test(q.asker)) f.asker = q.asker;
  if (q.qtype && QTYPES[q.qtype]) f.qtype = q.qtype;
  if (q.shelfLife === 'event' || q.shelfLife === 'evergreen') f.shelfLife = q.shelfLife;
  if (q.minAsked && Number(q.minAsked) > 1) f.minAsked = Math.min(50, Number(q.minAsked));
  if (q.often && OFTEN[q.often]) {
    const [min, max] = OFTEN[q.often];
    f.minAsked = min;
    if (max) f.maxAsked = max;
  }
  // A DAF keyword from "browse by DAF": "hobby:Cricket" -> questions about it (hobby or achievement hooks).
  const m = String(q.label || '').match(/^(hobby|college|discipline|job|state|optional):(.{1,80})$/);
  if (m) {
    const [, kind, label] = m;
    f.labels = LABEL_HOOKS[kind](label);
  }
  return f;
};

// The question hooks a DAF keyword covers ("hobby:Cricket" -> hobby and achievement questions about it).
const LABEL_HOOKS = {
  hobby: (l) => [`hobby:${l}`, `eca:${l}`],
  college: (l) => [`education:${l}`],
  discipline: (l) => [`education:${l}`],
  job: (l) => [`work:${l}`],
  state: (l) => [`home:${l}`],
  optional: (l) => [`optional:${l}`]
};

// The student's DAF items as bank keywords, matched the way predictions match them; items the bank has no
// keyword for are left out.
const dafKeywords = (idx, profile) => {
  const out = new Map();
  for (const item of profileItems(profile || {})) {
    const kw = keywordFor(idx, item);
    if (kw && LABEL_HOOKS[kw.kind] && !out.has(`${kw.kind}:${kw.label}`)) out.set(`${kw.kind}:${kw.label}`, { kind: kw.kind, label: kw.label });
  }
  return [...out.values()];
};
const hooksOf = (keywords) => [...new Set(keywords.flatMap((k) => LABEL_HOOKS[k.kind](k.label)))];

// Before a student's DAF is verified (and for visitors who haven't signed in) the bank is a preview: the
// BANK_PREVIEW most-asked questions, whatever the search or filters. Admins and verified students get it all.
export const BANK_PREVIEW = 15;
const fullBankAccess = async (req) => {
  if (!req.userId) return false;
  if (await isAdminRequest(req)) return true;
  return (await getDafCheck(req.userId)).status === 'verified';
};

export const searchBank = async (req, res) => {
  try {
    const idx = await getCorpusIndex();
    if (!(await fullBankAccess(req))) {
      const { total, items, facets } = searchFamilies(idx, { sort: 'asked', offset: 0, limit: BANK_PREVIEW, facets: req.query.facets === '1' });
      return res.json({ total, page: 1, limit: BANK_PREVIEW, items, semantic: false, preview: true, previewLimit: BANK_PREVIEW, ...(facets ? { facets } : {}) });
    }
    const q = String(req.query.q || '').slice(0, 200);
    const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
    const limit = Math.max(5, Math.min(50, Number(req.query.limit) || 20));
    const sort = ['relevance', 'asked', 'recent'].includes(req.query.sort) ? req.query.sort : 'relevance';
    const filters = bankFilters(req.query);
    // mine=1: questions about anything in the student's own DAF.
    if (req.query.mine === '1') {
      const profile = await InterviewProfile.findOne({ user: req.userId }).lean();
      filters.labels = hooksOf(dafKeywords(idx, profile));
      if (!filters.labels.length) return res.json({ total: 0, page, limit, items: [], semantic: false });
    }
    const queryVec = q ? await queryVector(q, idx) : null;
    const { total, items, facets } = searchFamilies(idx, { q, filters, sort, offset: (page - 1) * limit, limit, queryVec, facets: req.query.facets === '1' });
    res.json({ total, page, limit, items, semantic: !!queryVec, ...(facets ? { facets } : {}) });
  } catch (err) {
    console.error('[interview] searchBank error:', err);
    fail(res, 500, 'Search failed. Please try again.');
  }
};

// "From your DAF" in the bank: the student's DAF items as bank keywords, with how many questions each
// (and all of them together) covers. Only with the full bank (a verified DAF, or an admin).
export const getMyDafKeywords = async (req, res) => {
  try {
    if (!(await fullBankAccess(req))) return fail(res, 403, 'The full question bank opens once your DAF is verified.', { preview: true });
    const idx = await getCorpusIndex();
    const profile = await InterviewProfile.findOne({ user: req.userId }).lean();
    const keywords = dafKeywords(idx, profile);
    const count = (labels) => (labels.length ? searchFamilies(idx, { filters: { labels }, sort: 'asked', offset: 0, limit: 1 }).total : 0);
    const items = keywords
      .map((k) => ({ filter: `${k.kind}:${k.label}`, kind: k.kind, label: k.label, questions: count(LABEL_HOOKS[k.kind](k.label)) }))
      .filter((k) => k.questions > 0);
    res.json({ total: count(hooksOf(keywords)), items });
  } catch (err) {
    console.error('[interview] getMyDafKeywords error:', err);
    fail(res, 500, 'Could not load your DAF keywords.');
  }
};

export const getFacets = async (req, res) => {
  try {
    const idx = await getCorpusIndex();
    const list = (obj, labels) => Object.entries(obj).map(([value, count]) => ({ value, label: labels?.[value] || value, count })).sort((a, b) => b.count - a.count);
    res.json({
      years: list(idx.facet.years).sort((a, b) => Number(b.value) - Number(a.value)),
      boards: list(idx.facet.boards),
      topics: list(idx.facet.topics, TOPIC_LABELS),
      hookTypes: list(idx.facet.hookTypes, HOOK_TYPES),
      qtypes: list(idx.facet.qtypes, QTYPES)
    });
  } catch (err) {
    console.error('[interview] getFacets error:', err);
    fail(res, 500, 'Could not load filters.');
  }
};

// The DAF keywords in the bank with interview and question counts (browse by DAF; form suggestions), and
// each board's style.
export const getKeywords = async (req, res) => {
  try {
    const idx = await getCorpusIndex();
    const meta = idx.meta;
    // Boards' favourite questions and openers come as keys; send them as questions the screen can open.
    const boards = (meta?.boards || []).map(({ families, openers, ...b }) => ({
      ...b,
      favourites: familiesByKeys(idx, (families || []).map((f) => f.key)).slice(0, 8),
      openers: familiesByKeys(idx, (openers || []).map((f) => f.key)).slice(0, 4)
    }));
    res.json({ keywords: meta?.keywords || {}, areas: meta?.areas || null, boards, interviews: meta?.interviews || idx.stats.transcripts });
  } catch (err) {
    console.error('[interview] getKeywords error:', err);
    fail(res, 500, 'Could not load the DAF keywords.');
  }
};

export const getTrends = async (req, res) => {
  try {
    const idx = await getCorpusIndex();
    const years = idx.stats.years;
    const topics = Object.entries(idx.topicByYear)
      .map(([topic, byYear]) => ({ topic, label: TOPIC_LABELS[topic] || topic, total: Object.values(byYear).reduce((a, b) => a + b, 0), byYear }))
      .sort((a, b) => b.total - a.total);
    const boards = Object.entries(idx.facet.boards).map(([board, questions]) => ({ board, questions })).sort((a, b) => b.questions - a.questions).slice(0, 16);
    res.json({
      years,
      transcriptsByYear: idx.stats.transcriptsByYear,
      topics,
      boards,
      mostAsked: searchFamilies(idx, { sort: 'asked', limit: 15 }).items,
      // First asked in the latest year and already repeated: what the newest boards brought in.
      latestYear: years.length ? Math.max(...years) : null,
      newInLatest: years.length
        ? idx.families.filter((f) => f.firstYear === Math.max(...years) && f.transcriptCount >= 2).sort((x, y) => y.transcriptCount - x.transcriptCount).slice(0, 12).map(summarizeFamily)
        : [],
      templates: idx.templates.slice(0, 12).map((t) => ({ type: t.type, typeLabel: HOOK_TYPES[t.type], text: t.text, values: t.values.slice(0, 5), timesAsked: t.transcriptCount, years: t.years }))
    });
  } catch (err) {
    console.error('[interview] getTrends error:', err);
    fail(res, 500, 'Could not load trends.');
  }
};

// A short, non-identifying description of the candidate a question was asked to.
const candidateSummary = (p = {}) => {
  const parts = [p.optional && `${p.optional} optional`, p.homeState, (p.education || [])[0], (p.hobbies || []).slice(0, 2).join(', ')].filter(Boolean);
  // Many transcripts only list "DAF keywords"; use a few of those when the structured fields are empty.
  if (parts.length < 2) parts.push(...(p.keywords || []).filter((k) => k.length <= 40).slice(0, 4 - parts.length));
  return parts.join(' · ');
};

const isAdminRequest = async (req) => {
  const u = await User.findById(req.userId).select('email').lean();
  return !!u && isAdminEmail(u.email);
};

export const getFamily = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Question not found.');
  try {
    const admin = await isAdminRequest(req);
    const idx = await getCorpusIndex();
    const fam = familyById(idx, req.params.id);
    if (!fam) return fail(res, 404, 'Question not found.');
    const members = await InterviewQuestion.find({ family: fam.id, hidden: { $ne: true } })
      .sort({ year: -1 })
      .limit(80)
      .populate({ path: 'transcript', select: 'year seq profile hidden' })
      .lean();
    // Up to three questions asked right after each one: the board's follow-up ladder.
    const nexts = members.length
      ? await InterviewQuestion.find({ $or: members.flatMap((m) => [1, 2, 3].map((d) => ({ transcript: m.transcript?._id, order: m.order + d }))), hidden: { $ne: true } }).select('transcript order text followUp asker family').lean()
      : [];
    const nextBy = new Map(nexts.map((n) => [`${n.transcript}:${n.order}`, n]));
    const ladderOf = (m) => {
      const out = [];
      for (let d = 1; d <= 3; d++) {
        const n = nextBy.get(`${m.transcript?._id}:${m.order + d}`);
        if (!n || !n.followUp) break;
        out.push({ text: n.text, asker: n.asker, familyId: n.family ? String(n.family) : null });
      }
      return out;
    };
    const shown = members.filter((m) => m.transcript && !m.transcript.hidden);
    const ladders = new Map(shown.map((m) => [String(m._id), ladderOf(m)]));
    // The follow-ups boards reached for most often after this question.
    const firstFollow = new Map();
    for (const l of ladders.values()) {
      const f = l[0];
      if (!f) continue;
      const k = f.familyId || f.text;
      if (!firstFollow.has(k)) firstFollow.set(k, { text: f.text, familyId: f.familyId, n: 0 });
      firstFollow.get(k).n += 1;
    }
    res.json({
      family: summarizeFamily(fam),
      followUps: [...firstFollow.values()].sort((a, b) => b.n - a.n).slice(0, 6),
      asked: shown.map((m) => {
        const ladder = ladders.get(String(m._id)) || [];
        return {
          id: String(m._id),
          text: m.text,
          originalText: m.originalText || '',
          year: m.year,
          board: m.board,
          asker: m.asker,
          note: m.note,
          // Only admins can open a full transcript; students see the question in context.
          transcriptId: admin ? String(m.transcript._id) : undefined,
          candidate: candidateSummary(m.transcript.profile),
          followedBy: ladder[0]?.text || '',
          ladder
        };
      }),
      related: relatedFamilies(idx, fam.id, 6)
    });
  } catch (err) {
    console.error('[interview] getFamily error:', err);
    fail(res, 500, 'Could not load that question.');
  }
};

// How to approach a question: what the board is testing, a structure, points to cover, pitfalls, and a
// sample answer for factual / opinion questions (never for personal ones - those must be the student's own).
// Made once per wording and language and cached. Students need a verified DAF, and unlocking a question's
// guide costs 1 AI credit (POST); reopening one they already unlocked is free (GET or POST).
const APPROACH_SYSTEM = `You coach UPSC Civil Services interview (Personality Test) candidates. Be concrete, balanced and calm, in the tone of an experienced mentor. Use only well-established facts; never invent statistics, dates or quotes.`;
export const getApproach = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Question not found.');
  if (await dafGate(req, res)) return;
  let spent = null;
  try {
    const lang = langOf(req);
    const idx = await getCorpusIndex();
    const fam = familyById(idx, req.params.id);
    if (!fam) return fail(res, 404, 'Question not found.');
    const unlockKey = prepKey(fam.text);
    const admin = await isAdminRequest(req);
    const unlocked = admin || !!(await InterviewPrep.exists({ user: req.userId, approaches: unlockKey }));
    if (!unlocked) {
      if (req.method !== 'POST') return fail(res, 402, 'Open "How to approach it" to see this answer guide.', { locked: true });
      spent = await takeCredit(req);
      if (!spent?.from) return noCredits(res, spent);
    }
    const remember = async () => {
      if (unlocked) return;
      await InterviewPrep.updateOne({ user: req.userId }, { $addToSet: { approaches: unlockKey }, $setOnInsert: { user: req.userId } }, { upsert: true });
    };
    const key = `approach:${lang}:${textHash(fam.text)}`;
    const hit = await InterviewAiCache.findOne({ key }).lean();
    if (hit?.data) {
      await remember();
      return res.json({ approach: hit.data, cached: true, credits: admin ? null : await getBalance(req.userId) });
    }
    if (!(await checkGemini())) {
      await refundCredit(req.userId, spent?.from === 'admin' ? null : spent).catch(() => {});
      return fail(res, 503, 'Answer guides are not available right now. Please try again later.', { aiUnavailable: true });
    }
    const notes = (await InterviewQuestion.find({ family: fam.id, note: { $gt: '' }, hidden: { $ne: true } }).limit(8).select('note').lean()).map((n) => n.note).filter((n) => n.length > 10);
    const personal = ['personal', 'daf'].includes(fam.qtype) || (fam.hookTypes || []).some((t) => ['intro', 'motivation', 'hobby', 'eca', 'home', 'education', 'work', 'family', 'name', 'service'].includes(t));
    const prompt = `Interview question: "${fam.text}"
Asked in ${fam.transcriptCount} past interviews (in ${fam.years.join(', ')}). Question type: ${fam.qtype}. Topics: ${(fam.topics || []).join(', ') || 'general'}.
${notes.length ? `What past candidates say they answered, or how the board reacted:\n- ${notes.slice(0, 6).join('\n- ')}\n` : ''}
Return JSON {"gist":"what the board is really testing, one sentence","structure":["3-4 steps of a strong answer"],"include":["3-5 points worth covering"],"avoid":["2-3 pitfalls"],"sample":"${personal ? '' : 'a 90-120 word sample answer in the first person'}"}.
${personal ? 'This is a personal question: leave "sample" empty - the answer must be the candidate\'s own.' : ''}
${lang === 'hi' ? 'Write every value in Hindi (Devanagari), simple and natural; keep acronyms and names as commonly written.' : 'Write in clear Indian English.'}`;
    const raw = await generateJson({ system: APPROACH_SYSTEM, prompt, temperature: 0.4, maxOutputTokens: 2200, thinking: 'low' });
    const list = (x, n) => (Array.isArray(x) ? x.map((v) => String(v || '').trim().slice(0, 400)).filter(Boolean).slice(0, n) : []);
    const approach = { gist: String(raw?.gist || '').slice(0, 400), structure: list(raw?.structure, 5), include: list(raw?.include, 6), avoid: list(raw?.avoid, 4), sample: personal ? '' : String(raw?.sample || '').slice(0, 1400), personal };
    await InterviewAiCache.updateOne({ key }, { $set: { key, data: approach } }, { upsert: true });
    await remember();
    res.json({ approach, cached: false, credits: admin ? null : await getBalance(req.userId) });
  } catch (err) {
    // The credit is given back when the guide couldn't be made.
    await refundCredit(req.userId, spent?.from === 'admin' ? null : spent).catch(() => {});
    if (err.name === 'GeminiUnavailableError') return fail(res, 503, 'Answer guides are not available right now. Please try again later.', { aiUnavailable: true });
    console.error('[interview] getApproach error:', err);
    fail(res, 500, 'Could not prepare the answer guide.');
  }
};

// ------------------------------------------------------------------ the student's own prep

const PREP_STATUSES = ['todo', 'drafted', 'practised', 'confident'];
const MAX_PREP_ITEMS = 3000;

export const getPrep = async (req, res) => {
  try {
    const p = await InterviewPrep.findOne({ user: req.userId }).lean();
    res.json({ items: p?.items || [], interviewDate: p?.interviewDate || null });
  } catch (err) {
    console.error('[interview] getPrep error:', err);
    fail(res, 500, 'Could not load your preparation.');
  }
};

export const savePrepItem = async (req, res) => {
  const key = String(req.params.key || '');
  if (!PREP_KEY_RE.test(key)) return fail(res, 400, 'Unknown question.');
  try {
    const b = req.body || {};
    const doc = (await InterviewPrep.findOne({ user: req.userId })) || new InterviewPrep({ user: req.userId, items: [] });
    let item = doc.items.find((i) => i.key === key);
    if (!item) {
      if (doc.items.length >= MAX_PREP_ITEMS) return fail(res, 400, 'Your list is full. Remove a few questions first.');
      doc.items.push({ key });
      item = doc.items[doc.items.length - 1];
    }
    if (b.status !== undefined) {
      if (!PREP_STATUSES.includes(b.status)) return fail(res, 400, 'Unknown status.');
      item.status = b.status;
    }
    if (b.saved !== undefined) item.saved = !!b.saved;
    if (b.note !== undefined) item.note = String(b.note || '').slice(0, 2000);
    if (b.text) item.text = String(b.text).slice(0, 400);
    if (b.familyId !== undefined) item.familyId = isId(b.familyId) ? String(b.familyId) : '';
    if (b.source && ['past', 'tailored', 'new', 'bank'].includes(b.source)) item.source = b.source;
    item.updatedAt = new Date();
    await doc.save();
    res.json({ item: doc.items.find((i) => i.key === key) });
  } catch (err) {
    console.error('[interview] savePrepItem error:', err);
    fail(res, 500, 'Could not save that.');
  }
};

export const deletePrepItem = async (req, res) => {
  const key = String(req.params.key || '');
  if (!PREP_KEY_RE.test(key)) return fail(res, 400, 'Unknown question.');
  try {
    await InterviewPrep.updateOne({ user: req.userId }, { $pull: { items: { key } } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview] deletePrepItem error:', err);
    fail(res, 500, 'Could not remove that.');
  }
};

export const savePrepSettings = async (req, res) => {
  try {
    const d = req.body?.interviewDate ? new Date(req.body.interviewDate) : null;
    if (d && Number.isNaN(d.getTime())) return fail(res, 400, 'That date does not look right.');
    await InterviewPrep.updateOne({ user: req.userId }, { $set: { interviewDate: d }, $setOnInsert: { user: req.userId } }, { upsert: true });
    res.json({ interviewDate: d });
  } catch (err) {
    console.error('[interview] savePrepSettings error:', err);
    fail(res, 500, 'Could not save that.');
  }
};

// ------------------------------------------------------------------ Practice Studio

// How many AI-feedback answers the student has left today.
// ------------------------------------------------------------------ AI credits

// Practice and AI need a DAF an admin has verified; admins are never gated. Answers the request (403) and
// returns true when the student isn't verified yet.
const dafGate = async (req, res) => {
  if (await isAdminRequest(req)) return false;
  const daf = await getDafCheck(req.userId);
  if (daf.status === 'verified') return false;
  fail(res, 403, dafGateMessage(daf.status), { needDafVerification: true, dafStatus: daf.status });
  return true;
};

// One AI credit, free ones first; admins never spend. null when the student has none left, so callers answer
// 402 and the screen offers a pack.
const takeCredit = async (req) => {
  if (await isAdminRequest(req)) return { from: 'admin' };
  return spendCredit(req.userId);
};
const noCredits = (res, spent) => (spent?.limited
  ? fail(res, 429, `That's ${AI_USES_PER_DAY} credits used today - the daily limit. Try again tomorrow.`, { limited: true })
  : fail(res, 402, `You don't have enough credits left for this. Get more to continue.`, { needCredits: true }));

export const getCredits = async (req, res) => {
  try {
    const admin = await isAdminRequest(req);
    res.json({ ...(await getBalance(req.userId)), admin, daf: await getDafCheck(req.userId), packs: Object.values(CREDIT_PACKS), perDay: AI_USES_PER_DAY, feedbackCredits: FEEDBACK_CREDITS_SHORT, feedbackLongCredits: FEEDBACK_CREDITS_LONG, feedbackShortSeconds: FEEDBACK_SHORT_SECONDS, feedbackMaxSeconds: FEEDBACK_MAX_SECONDS });
  } catch (err) {
    console.error('[interview] getCredits error:', err);
    fail(res, 500, 'Could not load your credits.');
  }
};

// POST /answers/draft { question, key?, familyId?, source? } - an answer drafted from the student's DAF,
// saved on their prep item so it can be reopened for free.
export const draftAnswerHandler = async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (question.length < 5) return fail(res, 400, 'Which question?');
  const key = PREP_KEY_RE.test(String(b.key || '')) ? b.key : null;
  if (await dafGate(req, res)) return;
  if (!(await checkGemini())) return fail(res, 503, 'Answer drafts are not available right now. Please try again later.', { aiUnavailable: true });
  const spent = await takeCredit(req);
  if (!spent?.from) return noCredits(res, spent);
  try {
    const profile = await InterviewProfile.findOne({ user: req.userId }).lean();
    const familyId = isId(b.familyId) ? String(b.familyId) : '';
    let approach = null;
    if (familyId) {
      const idx = await getCorpusIndex();
      const fam = familyById(idx, familyId);
      if (fam) approach = (await InterviewAiCache.findOne({ key: `approach:en:${textHash(fam.text)}` }).lean())?.data || null;
    }
    const draft = await draftAnswer({ question, profile: profile || {}, approach, lang: 'en' });
    if (key) {
      const doc = (await InterviewPrep.findOne({ user: req.userId })) || new InterviewPrep({ user: req.userId, items: [] });
      let item = doc.items.find((i) => i.key === key);
      if (!item && doc.items.length < MAX_PREP_ITEMS) {
        doc.items.push({ key, text: question, familyId, source: ['past', 'tailored', 'new', 'bank'].includes(b.source) ? b.source : '' });
        item = doc.items[doc.items.length - 1];
      }
      if (item) {
        item.draft = draft;
        item.status = item.status === 'todo' ? 'drafted' : item.status;
        item.updatedAt = new Date();
        doc.markModified('items');
        await doc.save();
      }
    }
    res.json({ draft, credits: await getBalance(req.userId) });
  } catch (err) {
    await refundCredit(req.userId, spent.from === 'admin' ? null : spent).catch(() => {});
    if (err.name === 'GeminiUnavailableError') return fail(res, 503, 'Answer drafts are not available right now. Please try again later.', { aiUnavailable: true });
    console.error('[interview] draftAnswer error:', err);
    fail(res, 502, 'Could not write that answer. Your credit was not used - try again.');
  }
};

export const analyzePractice = async (req, res) => {
  if (await dafGate(req, res)) return;
  if (!req.file) return fail(res, 400, 'No recording was received.');
  if (!(await checkGemini())) return fail(res, 503, 'Detailed feedback is not available right now. Your on-device report is still here.', { aiUnavailable: true });
  let device = {};
  try { device = JSON.parse(String(req.body?.device || '{}')); } catch { device = {}; }
  // Up to 3 minutes of audio (the screen says so; the size check catches recordings that claim otherwise).
  if (Number(device.durationSec) > FEEDBACK_MAX_SECONDS + 5 || req.file.size > FEEDBACK_MAX_BYTES) {
    return fail(res, 413, 'Detailed feedback works on answers up to 3 minutes.', { tooLong: true });
  }
  try {
    const admin = await isAdminRequest(req);
    // 1 credit up to 90 seconds, 2 for a longer answer.
    const spent = admin ? { from: 'admin' } : await spendCredits(req.userId, feedbackCreditsFor(device.durationSec));
    if (!spent?.from) return noCredits(res, spent);
    req.spentCredit = spent.from === 'admin' ? null : spent;
    const analysis = await analyzeAnswer({
      // "audio/webm;codecs=opus" -> "audio/webm" (Gemini wants the bare type).
      audio: { buffer: req.file.buffer, mimeType: req.file.mimetype.startsWith('video/') ? 'audio/webm' : req.file.mimetype.split(';')[0] },
      question: String(req.body?.question || '').slice(0, 400),
      lang: req.body?.lang === 'hi' ? 'hi' : 'en',
      device
    });
    const credits = await getBalance(req.userId);
    res.json({ analysis, left: credits.total, credits });
  } catch (err) {
    await refundCredits(req.userId, req.spentCredit).catch(() => {});
    if (err.name === 'GeminiUnavailableError') return fail(res, 503, 'Detailed feedback is not available right now. Your on-device report is still here.', { aiUnavailable: true });
    console.error('[interview] analyzePractice error:', err);
    fail(res, 502, 'Could not analyse that recording. Try again, a little closer to the microphone.');
  }
};

const MAX_ATTEMPTS = 500;
// 3 minutes of compressed speech is well under this (the recorder asks for 64 kbps, about 1.5 MB; this
// allows browsers that record at up to ~250 kbps); bigger files are longer recordings.
const FEEDBACK_MAX_BYTES = 6 * 1024 * 1024;
const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : undefined);

export const savePracticeAttempt = async (req, res) => {
  if (await dafGate(req, res)) return;
  try {
    const b = req.body || {};
    const m = b.metrics || {};
    const sc = b.scores || {};
    const doc = await PracticeAttempt.create({
      user: req.userId,
      questionKey: PREP_KEY_RE.test(String(b.questionKey || '')) ? b.questionKey : '',
      question: String(b.question || '').slice(0, 400),
      lang: b.lang === 'hi' ? 'hi' : 'en',
      metrics: {
        durationSec: num(m.durationSec, 0, 900), speakingSec: num(m.speakingSec, 0, 900), words: num(m.words, 0, 5000),
        wpm: num(m.wpm, 0, 400), fillers: num(m.fillers, 0, 500), fillersPerMin: num(m.fillersPerMin, 0, 100),
        longPauses: num(m.longPauses, 0, 200), pauses: num(m.pauses, 0, 500), hedges: num(m.hedges, 0, 200),
        startDelaySec: num(m.startDelaySec, 0, 120), pitchVariation: num(m.pitchVariation, 0, 5), trailingOff: !!m.trailingOff
      },
      scores: { pace: num(sc.pace, 0, 10), fluency: num(sc.fluency, 0, 10), confidence: num(sc.confidence, 0, 10), tone: num(sc.tone, 0, 10), content: num(sc.content, 0, 10) },
      ai: !!b.ai,
      toneLabel: String(b.toneLabel || '').slice(0, 30)
    });
    // Keep the most recent MAX_ATTEMPTS per student.
    const extra = await PracticeAttempt.find({ user: req.userId }).sort({ createdAt: -1 }).skip(MAX_ATTEMPTS).select('_id').lean();
    if (extra.length) await PracticeAttempt.deleteMany({ _id: { $in: extra.map((x) => x._id) } });
    res.json({ attempt: { id: String(doc._id), createdAt: doc.createdAt } });
  } catch (err) {
    console.error('[interview] savePracticeAttempt error:', err);
    fail(res, 500, 'Could not save this attempt.');
  }
};

export const listPracticeAttempts = async (req, res) => {
  try {
    const filter = { user: req.userId };
    if (PREP_KEY_RE.test(String(req.query.key || ''))) filter.questionKey = req.query.key;
    const attempts = await PracticeAttempt.find(filter).sort({ createdAt: -1 }).limit(60).lean();
    res.json({
      attempts: attempts.map(({ _id, user, __v, updatedAt, ...a }) => ({ id: String(_id), ...a })),
      aiLeft: (await getBalance(req.userId)).total,
      credits: await getBalance(req.userId)
    });
  } catch (err) {
    console.error('[interview] listPracticeAttempts error:', err);
    fail(res, 500, 'Could not load your practice history.');
  }
};

export const getTranscript = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Transcript not found.');
  try {
    const t = await InterviewTranscript.findOne({ _id: req.params.id, hidden: { $ne: true } }).lean();
    if (!t) return fail(res, 404, 'Transcript not found.');
    const qs = await InterviewQuestion.find({ transcript: t._id, hidden: { $ne: true } }).sort({ order: 1 }).select('order asker text note followUp family topics').lean();
    const { profile } = t;
    res.json({
      transcript: {
        id: String(t._id),
        year: t.year,
        board: profile.board,
        session: profile.session,
        candidate: {
          optional: profile.optional, homeState: profile.homeState, education: profile.education, work: profile.work,
          hobbies: profile.hobbies, achievements: profile.achievements, keywords: profile.keywords
        },
        experience: t.experience
      },
      questions: qs.map((q) => ({ id: String(q._id), order: q.order, asker: q.asker, text: q.text, note: q.note, followUp: q.followUp, familyId: q.family ? String(q.family) : null, topics: q.topics }))
    });
  } catch (err) {
    console.error('[interview] getTranscript error:', err);
    fail(res, 500, 'Could not load that transcript.');
  }
};

// ------------------------------------------------------------------ mock interview sessions

// One answer at a time per session, so a double-click can't record two answers to one question.
const busy = new Set();

const loadOwnSession = async (req, res) => {
  if (!isId(req.params.id)) { fail(res, 404, 'Interview not found.'); return null; }
  const s = await InterviewSession.findOne({ _id: req.params.id, user: req.userId });
  if (!s) { fail(res, 404, 'Interview not found.'); return null; }
  return s;
};

const PREDICTION_WAIT_MS = 20000;

export const startSession = async (req, res) => {
  try {
    const mode = req.body?.mode === 'real' ? 'real' : 'practice';
    const inputMode = req.body?.inputMode === 'voice' ? 'voice' : 'text';
    // A format fixes the number of questions and follow-ups. `minutes` is how interviews used to be chosen.
    const formatKey = FORMATS[req.body?.format] ? req.body.format : req.body?.minutes !== undefined ? formatFromMinutes(req.body.minutes) : DEFAULT_FORMAT;
    const format = formatOf(formatKey);
    const temperament = TEMPERAMENTS[req.body?.temperament] ? req.body.temperament : DEFAULT_TEMPERAMENT;
    const focus = (Array.isArray(req.body?.focus) ? req.body.focus : []).map((f) => String(f).slice(0, 120)).slice(0, 8);

    const since = new Date(); since.setHours(0, 0, 0, 0);
    if (await InterviewSession.countDocuments({ user: req.userId, createdAt: { $gte: since } }) >= LIMITS.sessionsPerDay) {
      return fail(res, 429, `You've started ${LIMITS.sessionsPerDay} mock interviews today. Please come back tomorrow.`);
    }
    const idx = await getCorpusIndex();
    if (!idx.stats.questions) return fail(res, 503, 'The transcript library is still being loaded. Please try again later.');

    const profile = await ensureProfile(req.userId);
    const plain = profile.toObject();
    const hash = profileHash(plain, idx);
    const useAI = await checkGemini();
    // The board plans from predictions tailored to this DAF. If they are not ready (the DAF was just
    // saved, or the student never opened the predictions page) the board "reads the DAF" now, for up to
    // PREDICTION_WAIT_MS; past that it plans from the past questions themselves.
    const cache = profile.predictionCache;
    let predictions = cache?.data && cache.hash === hash && (cache.aiUsed || !useAI) ? cache.data : null;
    if (!predictions && useAI && !isProfileEmpty(profile)) {
      predictions = await Promise.race([buildTailored(profile, idx, hash), new Promise((resolve) => { setTimeout(() => resolve(null), PREDICTION_WAIT_MS); })]);
    }
    if (!predictions) predictions = cache?.data && cache.hash === hash ? cache.data : await buildPredictions(idx, plain, { useAI: false });

    const plan = await planSession(idx, predictions, { questions: format.questions, focus });

    await InterviewSession.updateMany({ user: req.userId, status: 'in-progress' }, { $set: { status: 'abandoned', endedAt: new Date() } });
    const { _id, user, predictionCache, usage, __v, createdAt, updatedAt, ...snapshot } = plain;
    const session = new InterviewSession({
      user: req.userId, mode, inputMode, format: formatKey, temperament, durationMinutes: format.minutes, focus, profileSnapshot: snapshot,
      aiUsed: useAI, startedAt: new Date(), plan
    });
    openSession(session);
    await session.save();
    res.status(201).json({ session: sessionPayload(session), ai: aiPayload() });
  } catch (err) {
    console.error('[interview] startSession error:', err);
    fail(res, 500, 'Could not start the interview. Please try again.');
  }
};

export const getSession = async (req, res) => {
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    res.json({ session: sessionPayload(s), ai: aiPayload() });
  } catch (err) {
    console.error('[interview] getSession error:', err);
    fail(res, 500, 'Could not load the interview.');
  }
};

export const answerSession = async (req, res) => {
  const key = String(req.params.id);
  if (busy.has(key)) return fail(res, 409, 'Still processing your previous answer.');
  busy.add(key);
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    if (s.status !== 'in-progress') return fail(res, 409, 'This interview has already ended.', { session: sessionPayload(s) });
    const current = s.turns[s.turns.length - 1];
    if (req.body?.turnIdx !== undefined && Number(req.body.turnIdx) !== current.idx) {
      return fail(res, 409, 'That question was already answered.', { session: sessionPayload(s) });
    }
    const { done } = await answerCurrent(s, {
      answer: req.body?.answer,
      answerMode: req.body?.answerMode,
      answerSeconds: req.body?.answerSeconds,
      skipped: !!req.body?.skipped,
      interrupted: !!req.body?.interrupted,
      behaviour: req.body?.behaviour
    });
    await s.save();
    res.json({ done, closing: done ? closingLine() : null, session: sessionPayload(s) });
  } catch (err) {
    console.error('[interview] answerSession error:', err);
    fail(res, 500, 'Could not record your answer. Please try again.');
  } finally {
    busy.delete(key);
  }
};

// Pause / resume the interview clock. Both are safe to repeat.
const setPaused = (paused) => async (req, res) => {
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    if (s.status !== 'in-progress') return fail(res, 409, 'This interview has already ended.', { session: sessionPayload(s) });
    // Only a pause the candidate chose is counted: not the hold before Begin, nor time spent reading the board's notes.
    const counted = !['begin', 'notes'].includes(req.body?.reason);
    if (paused ? pauseSession(s, { counted }) : resumeSession(s)) await s.save();
    res.json({ session: sessionPayload(s) });
  } catch (err) {
    console.error('[interview] pause/resume error:', err);
    fail(res, 500, paused ? 'Could not pause the interview.' : 'Could not resume the interview.');
  }
};
export const pauseSessionNow = setPaused(true);
export const resumeSessionNow = setPaused(false);

export const endSession = async (req, res) => {
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    if (s.status === 'in-progress') {
      resumeSession(s);
      s.endedAt = new Date();
      s.report = await buildReport(s);
      s.status = 'completed';
      await s.save();
    }
    res.json({ session: sessionPayload(s) });
  } catch (err) {
    console.error('[interview] endSession error:', err);
    fail(res, 500, 'Could not finish the interview report.');
  }
};

export const listSessions = async (req, res) => {
  try {
    const sessions = await InterviewSession.find({ user: req.userId, status: { $ne: 'abandoned' } })
      .sort({ createdAt: -1 }).limit(40).select('mode inputMode format temperament durationMinutes status startedAt endedAt aiUsed report.overall report.marks.total report.marks.outOf report.stats turns.idx').lean();
    res.json({
      sessions: sessions.map((s) => ({
        id: String(s._id), mode: s.mode, inputMode: s.inputMode, durationMinutes: s.durationMinutes, status: s.status,
        format: s.format || '', formatLabel: s.format ? formatOf(s.format).label : '', temperament: s.temperament || DEFAULT_TEMPERAMENT,
        marks: s.report?.marks?.total ?? null, marksOutOf: s.report?.marks?.outOf ?? null, minutes: s.report?.stats?.minutes ?? null,
        startedAt: s.startedAt, endedAt: s.endedAt, aiUsed: s.aiUsed,
        overall: s.report?.overall ?? null, questions: s.report?.stats?.questions ?? (s.turns || []).length, answered: s.report?.stats?.answered ?? null
      }))
    });
  } catch (err) {
    console.error('[interview] listSessions error:', err);
    fail(res, 500, 'Could not load your interviews.');
  }
};

export const deleteSession = async (req, res) => {
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    await s.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview] deleteSession error:', err);
    fail(res, 500, 'Could not delete that interview.');
  }
};

// Voice answers from browsers without built-in speech recognition (Firefox) are recorded and sent here.
export const transcribe = async (req, res) => {
  if (!req.file) return fail(res, 400, 'No audio received.');
  if (!(await checkGemini())) return fail(res, 503, 'Voice typing in this browser needs AI, which is not switched on yet. Use Chrome or Edge for voice answers, or type your answer.', { aiUnavailable: true });
  try {
    if (!(await useAllowance(req.userId, 'transcribes', LIMITS.transcribesPerDay))) return fail(res, 429, 'Daily voice limit reached. Please type your answers for today.');
    const mime = (req.file.mimetype || 'audio/webm').split(';')[0];
    const text = await transcribeAnswer(req.file.buffer, mime);
    res.json({ text });
  } catch (err) {
    if (err.name === 'GeminiUnavailableError') return fail(res, 503, 'AI is not available right now. Please type your answer.', { aiUnavailable: true });
    console.error('[interview] transcribe error:', err);
    fail(res, 502, 'Could not understand that recording. Please try again or type your answer.');
  }
};

// ------------------------------------------------------------------ the board's voice

// Speaks a line of the student's own interview as streamed PCM: ?turn=<idx> is that question,
// &part=lead&i=<n> a line said before it, &part=reaction what the member said after the answer,
// &part=interrupt the line for cutting a long answer short, and ?turn=closing the closing words.
// Only text the session already holds can be spoken, so this can't be used as a general TTS service.
// Any failure answers 503 before audio starts and the browser falls back to its built-in voice.
const sendSpeech = async (res, text, asker) => {
  try {
    await streamSpeech(text, asker, res);
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    if (err.name !== 'GeminiUnavailableError') console.warn('[interview] speech failed:', String(err.message).slice(0, 200));
    fail(res, 503, 'AI voice is not available right now.', { aiUnavailable: true });
  }
};

export const speakTurn = async (req, res) => {
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    if (!(await checkGemini())) return fail(res, 503, 'AI voice is not available right now.', { aiUnavailable: true });
    if (req.query.turn === 'closing') return sendSpeech(res, closingLine(), 'chairman');
    const turn = s.turns.find((t) => t.idx === Number(req.query.turn));
    if (!turn) return fail(res, 404, 'Question not found.');
    const part = String(req.query.part || 'question');
    const line = part === 'lead' ? (turn.lead || [])[Number(req.query.i) || 0]
      : part === 'reaction' ? { text: turn.reaction?.text, asker: turn.asker }
        : part === 'interrupt' ? { text: turn.interruptLine, asker: turn.asker }
          : { text: turn.question, asker: turn.asker };
    if (!line?.text) return fail(res, 404, 'Nothing to say there.');
    return sendSpeech(res, line.text, line.asker);
  } catch (err) {
    console.error('[interview] speakTurn error:', err);
    if (!res.headersSent) fail(res, 500, 'Could not play the question.');
  }
};

export const voiceSample = async (req, res) => {
  const asker = SAMPLE_LINES[req.query.asker] ? req.query.asker : 'chairman';
  if (!(await checkGemini())) return fail(res, 503, 'AI voice is not available right now.', { aiUnavailable: true });
  return sendSpeech(res, SAMPLE_LINES[asker], asker);
};
