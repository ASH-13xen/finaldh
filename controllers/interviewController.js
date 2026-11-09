import mongoose from 'mongoose';
import InterviewProfile from '../models/InterviewProfile.js';
import InterviewSession from '../models/InterviewSession.js';
import InterviewQuestion from '../models/InterviewQuestion.js';
import InterviewTranscript from '../models/InterviewTranscript.js';
import { getCorpusIndex, searchFamilies, familyById, relatedFamilies, summarizeFamily } from '../lib/interview/corpusIndex.js';
import { buildPredictions, profileHash, profileItems } from '../lib/interview/predict.js';
import { planSession, openSession, answerCurrent, buildReport, sessionPayload, closingLine, PANEL, TRAITS } from '../lib/interview/interviewer.js';
import { cleanProfileInput, extractDaf, transcribeAnswer, isProfileEmpty, SERVICES } from '../lib/interview/daf.js';
import { geminiStatus, checkGemini, embedTexts } from '../lib/interview/gemini.js';
import { TOPIC_LABELS, HOOK_TYPES, QTYPES } from '../lib/interview/taxonomy.js';

// Free for now; the caps only stop one account from running up the Gemini bill.
const LIMITS = { sessionsPerDay: 10, predictionRunsPerDay: 15, extractsPerDay: 8, transcribesPerDay: 400 };

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
    { $set: { 'usage.day': day, 'usage.extracts': 0, 'usage.predictionRuns': 0, 'usage.transcribes': 0 } }
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
      limits: LIMITS
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

export const saveProfile = async (req, res) => {
  try {
    const fields = cleanProfileInput(req.body || {});
    const source = req.body?.source === 'upload' ? 'upload' : 'manual';
    const p = await InterviewProfile.findOneAndUpdate(
      { user: req.userId },
      { $set: { ...fields, source }, $setOnInsert: { user: req.userId } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ profile: publicProfile(p), items: profileItems(p.toObject()), empty: isProfileEmpty(p) });
  } catch (err) {
    console.error('[interview] saveProfile error:', err);
    fail(res, 500, 'Could not save your DAF details.');
  }
};

export const deleteProfile = async (req, res) => {
  try {
    await InterviewProfile.deleteOne({ user: req.userId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview] deleteProfile error:', err);
    fail(res, 500, 'Could not delete your DAF details.');
  }
};

// Reads an uploaded DAF (PDF or photo) with Gemini and returns the fields for the student to check.
// Nothing is saved here and the file is dropped as soon as the request ends.
export const extractProfile = async (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose your DAF file (PDF or image).');
  if (!(await checkGemini())) return fail(res, 503, 'Reading a DAF automatically needs AI, which is not switched on yet. Please fill in the form below — it takes about two minutes.', { aiUnavailable: true });
  try {
    if (!(await useAllowance(req.userId, 'extracts', LIMITS.extractsPerDay))) return fail(res, 429, `You can read up to ${LIMITS.extractsPerDay} DAF files a day. Please edit the form by hand.`);
    const fields = await extractDaf(req.file.buffer, req.file.mimetype);
    res.json({ fields, empty: isProfileEmpty(fields) });
  } catch (err) {
    if (err.name === 'GeminiUnavailableError') return fail(res, 503, 'AI is not available right now. Please fill in the form by hand.', { aiUnavailable: true });
    console.error('[interview] extractProfile error:', err);
    fail(res, 502, 'Could not read that file. Try a clearer PDF or photo, or fill in the form by hand.');
  }
};

// ------------------------------------------------------------------ predictions

export const getPredictions = async (req, res) => {
  try {
    const profile = await InterviewProfile.findOne({ user: req.userId });
    if (!profile || isProfileEmpty(profile)) return fail(res, 400, 'Add your DAF details first — predictions are built from them.', { needsProfile: true });
    const idx = await getCorpusIndex();
    if (!idx.stats.questions) return fail(res, 503, 'The transcript library is still being loaded. Please try again later.');
    const plain = profile.toObject();
    const hash = profileHash(plain, idx);
    const cache = profile.predictionCache;
    const wantAI = await checkGemini();
    const fresh = cache?.data && cache.hash === hash && (cache.aiUsed || !wantAI);
    if (fresh && req.query.refresh !== '1') return res.json({ ...cache.data, cached: true, ai: aiPayload() });

    let useAI = wantAI;
    if (useAI && !(await useAllowance(req.userId, 'predictionRuns', LIMITS.predictionRunsPerDay))) {
      if (cache?.data && cache.hash === hash) return res.json({ ...cache.data, cached: true, ai: aiPayload(), limited: true });
      useAI = false;
    }
    const data = await buildPredictions(idx, plain, { useAI });
    await InterviewProfile.updateOne({ _id: profile._id }, { $set: { predictionCache: { hash, generatedAt: new Date(), aiUsed: data.aiUsed, data } } });
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
  if (q.asker && /^(chairman|m[1-5]|member)$/.test(q.asker)) f.asker = q.asker;
  if (q.qtype && QTYPES[q.qtype]) f.qtype = q.qtype;
  if (q.shelfLife === 'event' || q.shelfLife === 'evergreen') f.shelfLife = q.shelfLife;
  if (q.minAsked && Number(q.minAsked) > 1) f.minAsked = Math.min(50, Number(q.minAsked));
  return f;
};

export const searchBank = async (req, res) => {
  try {
    const idx = await getCorpusIndex();
    const q = String(req.query.q || '').slice(0, 200);
    const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
    const limit = Math.max(5, Math.min(50, Number(req.query.limit) || 20));
    const sort = ['relevance', 'asked', 'recent'].includes(req.query.sort) ? req.query.sort : 'relevance';
    const queryVec = q ? await queryVector(q, idx) : null;
    const { total, items } = searchFamilies(idx, { q, filters: bankFilters(req.query), sort, offset: (page - 1) * limit, limit, queryVec });
    res.json({ total, page, limit, items, semantic: !!queryVec });
  } catch (err) {
    console.error('[interview] searchBank error:', err);
    fail(res, 500, 'Search failed. Please try again.');
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

export const getFamily = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Question not found.');
  try {
    const idx = await getCorpusIndex();
    const fam = familyById(idx, req.params.id);
    if (!fam) return fail(res, 404, 'Question not found.');
    const members = await InterviewQuestion.find({ family: fam.id, hidden: { $ne: true } })
      .sort({ year: -1 })
      .limit(80)
      .populate({ path: 'transcript', select: 'year seq profile hidden' })
      .lean();
    // The question asked right after each one, to show how boards followed up.
    const nexts = members.length
      ? await InterviewQuestion.find({ $or: members.map((m) => ({ transcript: m.transcript?._id, order: m.order + 1 })), hidden: { $ne: true } }).select('transcript order text followUp').lean()
      : [];
    const nextBy = new Map(nexts.map((n) => [`${n.transcript}:${n.order}`, n]));
    res.json({
      family: summarizeFamily(fam),
      asked: members.filter((m) => m.transcript && !m.transcript.hidden).map((m) => {
        const n = nextBy.get(`${m.transcript._id}:${m.order + 1}`);
        return {
          id: String(m._id),
          text: m.text,
          originalText: m.originalText || '',
          year: m.year,
          board: m.board,
          asker: m.asker,
          note: m.note,
          transcriptId: String(m.transcript._id),
          candidate: candidateSummary(m.transcript.profile),
          followedBy: n && n.followUp ? n.text : ''
        };
      }),
      related: relatedFamilies(idx, fam.id, 6)
    });
  } catch (err) {
    console.error('[interview] getFamily error:', err);
    fail(res, 500, 'Could not load that question.');
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

export const startSession = async (req, res) => {
  try {
    const mode = req.body?.mode === 'real' ? 'real' : 'practice';
    const inputMode = req.body?.inputMode === 'voice' ? 'voice' : 'text';
    const minutes = [10, 20, 30].includes(Number(req.body?.minutes)) ? Number(req.body.minutes) : 20;
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
    // Reuse saved predictions when they match this DAF; otherwise build evidence-only ones (fast).
    const predictions = profile.predictionCache?.data && profile.predictionCache.hash === hash
      ? profile.predictionCache.data
      : await buildPredictions(idx, plain, { useAI: false });

    const useAI = await checkGemini();
    const plan = await planSession(idx, predictions, { minutes, focus, useAI });

    await InterviewSession.updateMany({ user: req.userId, status: 'in-progress' }, { $set: { status: 'abandoned', endedAt: new Date() } });
    const { _id, user, predictionCache, usage, __v, createdAt, updatedAt, ...snapshot } = plain;
    const session = new InterviewSession({
      user: req.userId, mode, inputMode, durationMinutes: minutes, focus, profileSnapshot: snapshot,
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
      skipped: !!req.body?.skipped
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

export const endSession = async (req, res) => {
  try {
    const s = await loadOwnSession(req, res);
    if (!s) return;
    if (s.status === 'in-progress') {
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
      .sort({ createdAt: -1 }).limit(40).select('mode inputMode durationMinutes status startedAt endedAt aiUsed report.overall report.stats turns.idx').lean();
    res.json({
      sessions: sessions.map((s) => ({
        id: String(s._id), mode: s.mode, inputMode: s.inputMode, durationMinutes: s.durationMinutes, status: s.status,
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
