import mongoose from 'mongoose';
import InterviewTranscript from '../models/InterviewTranscript.js';
import InterviewQuestion from '../models/InterviewQuestion.js';
import InterviewFamily from '../models/InterviewFamily.js';
import InterviewSession from '../models/InterviewSession.js';
import { getCorpusIndex, invalidateCorpusIndex } from '../lib/interview/corpusIndex.js';
import { recomputeFamilies } from '../lib/interview/familyStats.js';
import { geminiStatus } from '../lib/interview/gemini.js';
import { canonicalBoard, canonicalOptional, canonicalState, uniq } from '../lib/interview/text.js';
import { TOPIC_LABELS, HOOK_TYPES, QTYPES, isTrivialQuestion } from '../lib/interview/taxonomy.js';
import { ASKERS } from '../lib/interview/corpus.js';

// Admin review of the interview-transcript corpus. Every route here sits behind requireAdmin.

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const fail = (res, status, error) => res.status(status).json({ error });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getOverview = async (req, res) => {
  try {
    const [idx, byYear, sessions, sessionsAi] = await Promise.all([
      getCorpusIndex(),
      InterviewTranscript.aggregate([
        { $group: { _id: { year: '$year', engine: '$engine' }, n: { $sum: 1 }, reviewed: { $sum: { $cond: ['$reviewed', 1, 0] } }, hidden: { $sum: { $cond: ['$hidden', 1, 0] } } } },
        { $sort: { '_id.year': 1 } }
      ]),
      InterviewSession.countDocuments({}),
      InterviewSession.countDocuments({ aiUsed: true })
    ]);
    res.json({
      corpus: idx.stats,
      years: byYear.map((r) => ({ year: r._id.year, engine: r._id.engine, transcripts: r.n, reviewed: r.reviewed, hidden: r.hidden })),
      ai: geminiStatus(),
      sessions: { total: sessions, withAi: sessionsAi },
      templates: idx.templates.length
    });
  } catch (err) {
    console.error('[interview admin] overview error:', err);
    fail(res, 500, 'Could not load the overview.');
  }
};

export const listTranscripts = async (req, res) => {
  try {
    const filter = {};
    if (/^\d{4}$/.test(req.query.year || '')) filter.year = Number(req.query.year);
    if (req.query.reviewed === 'yes') filter.reviewed = true;
    if (req.query.reviewed === 'no') filter.reviewed = { $ne: true };
    if (req.query.hidden === 'yes') filter.hidden = true;
    if (req.query.board) filter['profile.board'] = req.query.board === '(none)' ? '' : String(req.query.board);
    if (req.query.few === 'yes') filter.questionCount = { $lt: 8 };
    if (req.query.q) {
      const re = new RegExp(escapeRe(String(req.query.q).slice(0, 80)), 'i');
      filter.$or = [{ 'profile.board': re }, { 'profile.keywords': re }, { 'profile.hobbies': re }, { 'profile.optional': re }, { 'profile.homeState': re }];
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 30;
    const [total, items] = await Promise.all([
      InterviewTranscript.countDocuments(filter),
      InterviewTranscript.find(filter).sort({ year: -1, seq: 1 }).skip((page - 1) * limit).limit(limit).lean()
    ]);
    res.json({
      total, page, limit,
      items: items.map((t) => ({
        id: String(t._id), year: t.year, seq: t.seq, engine: t.engine, pages: [t.pageStart, t.pageEnd],
        board: t.profile?.board || '', optional: t.profile?.optional || '', homeState: t.profile?.homeState || '',
        keywords: [...(t.profile?.hobbies || []), ...(t.profile?.keywords || [])].slice(0, 6),
        questionCount: t.questionCount, reviewed: t.reviewed, hidden: t.hidden
      }))
    });
  } catch (err) {
    console.error('[interview admin] listTranscripts error:', err);
    fail(res, 500, 'Could not load transcripts.');
  }
};

export const getTranscriptAdmin = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Transcript not found.');
  try {
    const t = await InterviewTranscript.findById(req.params.id).select('+rawText').lean();
    if (!t) return fail(res, 404, 'Transcript not found.');
    const qs = await InterviewQuestion.find({ transcript: t._id }).sort({ order: 1 }).populate({ path: 'family', select: 'text transcriptCount' }).lean();
    res.json({
      transcript: { ...t, id: String(t._id) },
      questions: qs.map((q) => ({
        id: String(q._id), order: q.order, asker: q.asker, text: q.text, originalText: q.originalText, note: q.note, followUp: q.followUp,
        hooks: q.hooks, topics: q.topics, qtype: q.qtype, shelfLife: q.shelfLife, hidden: q.hidden, trivial: q.trivial,
        family: q.family ? { id: String(q.family._id), text: q.family.text, timesAsked: q.family.transcriptCount } : null
      })),
      vocab: { askers: ASKERS, topics: TOPIC_LABELS, hookTypes: HOOK_TYPES, qtypes: QTYPES }
    });
  } catch (err) {
    console.error('[interview admin] getTranscript error:', err);
    fail(res, 500, 'Could not load that transcript.');
  }
};

const strList = (v, n = 20) => uniq((Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim().slice(0, 100)).filter(Boolean)).slice(0, n);

export const updateTranscript = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Transcript not found.');
  try {
    const t = await InterviewTranscript.findById(req.params.id);
    if (!t) return fail(res, 404, 'Transcript not found.');
    const b = req.body || {};
    const before = { board: t.profile.board, hidden: t.hidden };
    if (b.board !== undefined) t.profile.board = canonicalBoard(b.board, { allowUnknown: true }) || '';
    if (b.optional !== undefined) t.profile.optional = canonicalOptional(b.optional) || String(b.optional).slice(0, 80);
    if (b.homeState !== undefined) t.profile.homeState = canonicalState(b.homeState) || String(b.homeState).slice(0, 60);
    for (const k of ['hobbies', 'education', 'work', 'achievements', 'keywords']) if (b[k] !== undefined) t.profile[k] = strList(b[k]);
    if (b.reviewed !== undefined) t.reviewed = !!b.reviewed;
    if (b.hidden !== undefined) t.hidden = !!b.hidden;
    await t.save();

    const changedBoard = before.board !== t.profile.board;
    const changedHidden = before.hidden !== t.hidden;
    if (changedBoard || changedHidden) {
      const set = {};
      if (changedBoard) set.board = t.profile.board;
      if (changedHidden) set.hidden = t.hidden;
      await InterviewQuestion.updateMany({ transcript: t._id }, { $set: set });
      const fams = await InterviewQuestion.distinct('family', { transcript: t._id });
      await recomputeFamilies(fams, { keepText: true });
    } else {
      invalidateCorpusIndex();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview admin] updateTranscript error:', err);
    fail(res, 500, 'Could not save the transcript.');
  }
};

export const updateQuestion = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Question not found.');
  try {
    const q = await InterviewQuestion.findById(req.params.id);
    if (!q) return fail(res, 404, 'Question not found.');
    const b = req.body || {};
    let textChanged = false;
    if (typeof b.text === 'string' && b.text.trim() && b.text.trim() !== q.text) {
      q.text = b.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      q.trivial = isTrivialQuestion(q.text);
      textChanged = true;
    }
    if (b.asker && ASKERS.includes(b.asker)) q.asker = b.asker;
    if (b.followUp !== undefined) q.followUp = !!b.followUp;
    if (typeof b.note === 'string') q.note = b.note.slice(0, 600);
    if (Array.isArray(b.topics)) q.topics = b.topics.filter((t) => TOPIC_LABELS[t]).slice(0, 2);
    if (Array.isArray(b.hooks)) q.hooks = b.hooks.filter((h) => h && HOOK_TYPES[h.type]).slice(0, 4).map((h) => ({ type: h.type, value: String(h.value || '').toLowerCase().trim().slice(0, 60) }));
    if (b.qtype && QTYPES[b.qtype]) q.qtype = b.qtype;
    if (b.shelfLife === 'event' || b.shelfLife === 'evergreen') q.shelfLife = b.shelfLife;
    if (b.hidden !== undefined) q.hidden = !!b.hidden;
    await q.save();
    if (q.family) await recomputeFamilies([q.family], { keepText: !textChanged });
    else invalidateCorpusIndex();
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview admin] updateQuestion error:', err);
    fail(res, 500, 'Could not save the question.');
  }
};

// Move a question into another family, or (familyId: null) out into a family of its own.
export const moveQuestion = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Question not found.');
  try {
    const q = await InterviewQuestion.findById(req.params.id);
    if (!q) return fail(res, 404, 'Question not found.');
    const from = q.family;
    let to;
    if (req.body?.familyId) {
      if (!isId(req.body.familyId) || !(await InterviewFamily.exists({ _id: req.body.familyId }))) return fail(res, 404, 'Target family not found.');
      to = req.body.familyId;
    } else {
      const fam = await InterviewFamily.create({ key: `admin-${new mongoose.Types.ObjectId()}`, text: q.text });
      to = fam._id;
    }
    q.family = to;
    await q.save();
    await recomputeFamilies([from, to]);
    res.json({ ok: true, familyId: String(to) });
  } catch (err) {
    console.error('[interview admin] moveQuestion error:', err);
    fail(res, 500, 'Could not move the question.');
  }
};

export const mergeFamilies = async (req, res) => {
  const { targetId, sourceIds } = req.body || {};
  const sources = (Array.isArray(sourceIds) ? sourceIds : []).filter((id) => isId(id) && String(id) !== String(targetId));
  if (!isId(targetId) || !sources.length) return fail(res, 400, 'Pick a family to keep and at least one to merge into it.');
  try {
    if (!(await InterviewFamily.exists({ _id: targetId }))) return fail(res, 404, 'Target family not found.');
    await InterviewQuestion.updateMany({ family: { $in: sources } }, { $set: { family: targetId } });
    await recomputeFamilies([targetId, ...sources], { keepText: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview admin] mergeFamilies error:', err);
    fail(res, 500, 'Could not merge.');
  }
};

export const updateFamily = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Family not found.');
  try {
    const f = await InterviewFamily.findById(req.params.id);
    if (!f) return fail(res, 404, 'Family not found.');
    if (typeof req.body?.text === 'string' && req.body.text.trim()) f.text = req.body.text.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (req.body?.hidden !== undefined) f.hidden = !!req.body.hidden;
    await f.save();
    invalidateCorpusIndex();
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview admin] updateFamily error:', err);
    fail(res, 500, 'Could not save.');
  }
};

// Families for the admin's merge picker (includes hidden ones, by wording).
export const findFamiliesAdmin = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ items: [] });
    const items = await InterviewFamily.find({ text: new RegExp(escapeRe(q), 'i') }).sort({ transcriptCount: -1 }).limit(25).select('text transcriptCount years hidden').lean();
    res.json({ items: items.map((f) => ({ id: String(f._id), text: f.text, timesAsked: f.transcriptCount, years: f.years, hidden: f.hidden })) });
  } catch (err) {
    console.error('[interview admin] findFamilies error:', err);
    fail(res, 500, 'Search failed.');
  }
};
