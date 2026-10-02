// studyController.js — a student's personal study layer on top of Toppers Copy and the
// Question Bank: bookmarks, notes (selected quote + own comment), revision tracking, and the
// server-side "seen" ticks for Toppers Copy questions.
//
// The client only ever sends a ref (ids); everything shown later (question text, topper,
// pages, subject/topic) is looked up here and snapshotted into `context`, so a student can't
// save a note against content that doesn't exist or smuggle in a fake title.

import mongoose from 'mongoose';
import UserNote, { REF_TYPES, SECTIONS } from '../models/UserNote.js';
import ToppersSeen from '../models/ToppersSeen.js';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersPyq from '../models/ToppersPyq.js';
import QuizQuestion from '../models/QuizQuestion.js';
import EconomyTopic from '../models/EconomyTopic.js';
import EconomyTheme from '../models/EconomyTheme.js';
import User from '../models/User.js';

const QUOTE_MAX = 4000;
const BODY_MAX = 10000;
const QUOTE_FROM_MAX = 80;
const PAGE_MAX = 200;
const SEEN_IMPORT_MAX = 5000;

const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Same rule as toppersCopyController's isAdminReq: admins can preview (and so save from)
// unpublished topics; students only see published ones.
const isAdmin = async (userId) => {
  const user = await User.findById(userId).select('email').lean();
  const admins = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  return !!user && admins.includes((user.email || '').toLowerCase());
};

const topperLabel = (a) => [a.name, a.rank ? `AIR ${a.rank}` : '', a.year || ''].filter(Boolean).join(' · ');

// Resolves a client ref into { refType, refKey, ref, context } or throws { status, message }.
const resolveRef = async (body = {}, userId) => {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const { refType } = body;
  if (!REF_TYPES.includes(refType)) fail(400, `refType must be one of ${REF_TYPES.join(', ')}`);

  if (refType === 'tc_question' || refType === 'tc_answer') {
    const { toppersCopyId, questionId } = body;
    if (!isId(toppersCopyId) || !isId(questionId)) fail(400, 'toppersCopyId and questionId are required');
    const doc = await ToppersCopy.findById(toppersCopyId).select('subject topic published questions._id questions.questionText questions.answers');
    if (!doc || (!doc.published && !(await isAdmin(userId)))) fail(404, 'Toppers Copy topic not found');
    const q = doc.questions.id(questionId);
    if (!q) fail(404, 'Question not found');

    const context = { section: 'toppers_copy', subject: doc.subject, topic: doc.topic, title: q.questionText || '' };
    const ref = { toppersCopy: doc._id, question: q._id };

    if (refType === 'tc_question') {
      return { refType, refKey: `tc_question:${doc._id}:${q._id}`, ref, context };
    }
    const idx = Number(body.answerIdx);
    const a = Number.isInteger(idx) ? q.answers[idx] : null;
    if (!a) fail(404, 'Answer not found');
    return {
      refType,
      refKey: `tc_answer:${doc._id}:${q._id}:${idx}`,
      ref: { ...ref, answerIdx: idx },
      context: {
        ...context,
        subtitle: `${topperLabel(a)} · pp. ${a.startPage}${a.endPage && a.endPage !== a.startPage ? `-${a.endPage}` : ''}`,
        startPage: a.startPage,
        endPage: a.endPage || a.startPage,
      },
    };
  }

  if (refType === 'tc_pyq') {
    const { pyqId, toppersCopyId } = body;
    if (!isId(pyqId)) fail(400, 'pyqId is required');
    const pyq = await ToppersPyq.findById(pyqId).select('subject topic microtheme questionText year marks');
    if (!pyq) fail(404, 'PYQ not found');
    // The topic the student found it under — only used to reopen that drawer, not identity.
    const tcId = isId(toppersCopyId) ? toppersCopyId : null;
    return {
      refType,
      refKey: `tc_pyq:${pyq._id}`,
      ref: { pyq: pyq._id, toppersCopy: tcId },
      context: {
        section: 'toppers_copy',
        subject: pyq.subject,
        topic: pyq.topic || pyq.microtheme || '',
        title: pyq.questionText,
        subtitle: [`PYQ ${pyq.year}`, pyq.marks ? `${pyq.marks} marks` : ''].filter(Boolean).join(' · '),
      },
    };
  }

  if (refType === 'em_topic') {
    const { economyTopicId } = body;
    if (!isId(economyTopicId)) fail(400, 'economyTopicId is required');
    const t = await EconomyTopic.findById(economyTopicId).select('themeKey title number source pages hidden');
    if (!t || t.hidden) fail(404, 'Topic not found');
    const theme = await EconomyTheme.findOne({ key: t.themeKey }).select('title isPublished');
    if (!theme || (!theme.isPublished && !(await isAdmin(userId)))) fail(404, 'Topic not found');
    const part = { forum: 'Forum', partB: 'Part B', vision: 'Vision' }[t.source] || '';
    return {
      refType,
      refKey: `em_topic:${t._id}`,
      ref: { economyTopic: t._id },
      context: {
        section: 'economy_master',
        subject: 'Economy',
        topic: theme.title,
        title: t.title,
        subtitle: [part, t.pages?.length ? `p. ${t.pages[0]}` : ''].filter(Boolean).join(' · '),
        startPage: t.pages?.[0] ?? null,
        endPage: t.pages?.[t.pages.length - 1] ?? null,
      },
    };
  }

  // qb_question
  const { quizQuestionId } = body;
  if (!isId(quizQuestionId)) fail(400, 'quizQuestionId is required');
  const qq = await QuizQuestion.findById(quizQuestionId).select('subject topic questionText examSource');
  if (!qq) fail(404, 'Question not found');
  return {
    refType,
    refKey: `qb_question:${qq._id}`,
    ref: { quizQuestion: qq._id },
    context: {
      section: 'question_bank',
      subject: qq.subject,
      topic: qq.topic || '',
      title: qq.questionText,
      subtitle: qq.examSource || '',
    },
  };
};

const sendError = (res, err, fallback) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`study ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
};

const shapeItem = (n, extra = {}) => ({
  _id: n._id,
  kind: n.kind,
  refType: n.refType,
  refKey: n.refKey,
  ref: n.ref,
  context: n.context,
  quote: n.quote,
  quoteFrom: n.quoteFrom,
  body: n.body,
  subtopic: n.subtopic || '',
  revisedCount: n.revisedCount,
  lastRevisedAt: n.lastRevisedAt,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
  ...extra,
});

// Question Bank items carry the full MCQ (answer + explanation) so My Notes can show and
// revise it in place — the student chose to save it, so revealing the key here is fine.
const attachMcqs = async (items) => {
  const ids = items.filter((n) => n.refType === 'qb_question' && n.ref?.quizQuestion).map((n) => n.ref.quizQuestion);
  if (!ids.length) return items.map((n) => shapeItem(n));
  const docs = await QuizQuestion.find({ _id: { $in: ids } })
    .select('questionText statements matchLists options correctKey whyCorrect topic examSource questionType')
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return items.map((n) => {
    if (n.refType !== 'qb_question') return shapeItem(n);
    const q = byId.get(String(n.ref?.quizQuestion));
    return shapeItem(n, {
      mcq: q
        ? {
            questionText: q.questionText,
            statements: q.statements || [],
            matchLists: q.matchLists || null,
            options: (q.options || []).map((o) => ({ key: o.key, text: o.text })),
            correctKey: q.correctKey,
            whyCorrect: q.whyCorrect || '',
            examSource: q.examSource || '',
            questionType: q.questionType || '',
          }
        : null, // question removed since (e.g. a --replace re-import)
    });
  });
};

// Toppers Copy items get the question's CURRENT sub-topic name (looked up live, not
// snapshotted) — admins regroup questions after students have saved them.
const attachSubtopics = async (items) => {
  const tcIds = [...new Set(items
    .filter((n) => (n.refType === 'tc_question' || n.refType === 'tc_answer') && n.ref?.toppersCopy)
    .map((n) => String(n.ref.toppersCopy)))];
  if (!tcIds.length) return items;
  const docs = await ToppersCopy.find({ _id: { $in: tcIds } })
    .select('subtopics questions._id questions.subtopicId')
    .lean();
  const nameOf = new Map(); // questionId -> sub-topic name
  for (const d of docs) {
    const subs = new Map((d.subtopics || []).map((st) => [String(st._id), st.name]));
    for (const q of d.questions || []) {
      if (q.subtopicId && subs.has(String(q.subtopicId))) nameOf.set(String(q._id), subs.get(String(q.subtopicId)));
    }
  }
  return items.map((n) => {
    const name = n.ref?.question ? nameOf.get(String(n.ref.question)) : null;
    return name ? { ...n, subtopic: name } : n;
  });
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/study/items?kind=&section=&subject=&q=&skip=&limit=
export const listItems = async (req, res) => {
  try {
    const filter = { user: req.userId };
    if (['bookmark', 'note'].includes(req.query.kind)) filter.kind = req.query.kind;
    if (SECTIONS.includes(req.query.section)) filter['context.section'] = req.query.section;
    if (typeof req.query.subject === 'string' && req.query.subject) filter['context.subject'] = req.query.subject;
    const q = clip(req.query.q, 200);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ 'context.title': rx }, { 'context.topic': rx }, { quote: rx }, { body: rx }];
    }
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const [items, total, facets] = await Promise.all([
      UserNote.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      UserNote.countDocuments(filter),
      UserNote.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.userId) } },
        { $group: { _id: { section: '$context.section', kind: '$kind', subject: '$context.subject' }, n: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      items: await attachSubtopics(await attachMcqs(items)),
      total,
      skip,
      limit,
      facets: facets.map((f) => ({ ...f._id, count: f.n })),
    });
  } catch (err) {
    sendError(res, err, 'Failed to load notes');
  }
};

// GET /api/study/bookmarks?section=toppers_copy  -> { keys: [refKey…] }
// Lets a section paint its ☆/★ states in one request.
export const listBookmarkKeys = async (req, res) => {
  try {
    const filter = { user: req.userId, kind: 'bookmark' };
    if (SECTIONS.includes(req.query.section)) filter['context.section'] = req.query.section;
    const rows = await UserNote.find(filter).select('refKey').lean();
    res.json({ keys: rows.map((r) => r.refKey) });
  } catch (err) {
    sendError(res, err, 'Failed to load bookmarks');
  }
};

// POST /api/study/bookmarks/toggle  { refType, …ref ids }  -> { bookmarked, refKey, item? }
export const toggleBookmark = async (req, res) => {
  try {
    const r = await resolveRef(req.body, req.userId);
    const removed = await UserNote.findOneAndDelete({ user: req.userId, kind: 'bookmark', refKey: r.refKey });
    if (removed) return res.json({ bookmarked: false, refKey: r.refKey });
    try {
      const item = await UserNote.create({ user: req.userId, kind: 'bookmark', ...r });
      return res.status(201).json({ bookmarked: true, refKey: r.refKey, item: shapeItem(item) });
    } catch (e) {
      // Double-click race: the other request already created it.
      if (e?.code === 11000) return res.json({ bookmarked: true, refKey: r.refKey });
      throw e;
    }
  } catch (err) {
    sendError(res, err, 'Failed to update bookmark');
  }
};

// POST /api/study/notes  { refType, …ref ids, quote?, quoteFrom?, body? }
export const createNote = async (req, res) => {
  try {
    const r = await resolveRef(req.body, req.userId);
    const quote = clip(req.body.quote, QUOTE_MAX);
    const body = clip(req.body.body, BODY_MAX);
    if (!quote && !body) return res.status(400).json({ error: 'A note needs some text' });
    const item = await UserNote.create({
      user: req.userId,
      kind: 'note',
      ...r,
      quote,
      quoteFrom: clip(req.body.quoteFrom, QUOTE_FROM_MAX),
      body,
    });
    res.status(201).json({ item: shapeItem(item) });
  } catch (err) {
    sendError(res, err, 'Failed to save note');
  }
};

// PATCH /api/study/items/:id  { body?, quote? }  (notes only)
export const updateNote = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Note not found' });
    const note = await UserNote.findOne({ _id: req.params.id, user: req.userId, kind: 'note' });
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (typeof req.body?.body === 'string') note.body = clip(req.body.body, BODY_MAX);
    if (typeof req.body?.quote === 'string') note.quote = clip(req.body.quote, QUOTE_MAX);
    if (!note.quote && !note.body) return res.status(400).json({ error: 'A note needs some text' });
    await note.save();
    res.json({ item: shapeItem(note) });
  } catch (err) {
    sendError(res, err, 'Failed to update note');
  }
};

// DELETE /api/study/items/:id
export const deleteItem = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const gone = await UserNote.findOneAndDelete({ _id: req.params.id, user: req.userId });
    if (!gone) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, refKey: gone.refKey, kind: gone.kind });
  } catch (err) {
    sendError(res, err, 'Failed to delete');
  }
};

// POST /api/study/items/:id/revised — revision mode's "Mark revised".
// Deliberately doesn't touch updatedAt, so revising doesn't reshuffle the list.
export const markRevised = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const item = await UserNote.findOneAndUpdate(
      { _id: req.params.id, user: req.userId },
      { $inc: { revisedCount: 1 }, $set: { lastRevisedAt: new Date() } },
      { returnDocument: 'after', timestamps: false }
    );
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ revisedCount: item.revisedCount, lastRevisedAt: item.lastRevisedAt });
  } catch (err) {
    sendError(res, err, 'Failed to mark revised');
  }
};

// --- Toppers Copy "seen" ticks ------------------------------------------------------------
// Same shape as the old localStorage map — { [questionId]: topicId } — so the frontend's
// progress maths didn't have to change.

const seenMap = async (userId) => {
  const rows = await ToppersSeen.find({ user: userId }).select('question toppersCopy').lean();
  return Object.fromEntries(rows.map((r) => [String(r.question), r.toppersCopy ? String(r.toppersCopy) : true]));
};

// GET /api/study/tc-seen
export const getSeen = async (req, res) => {
  try {
    res.json({ seen: await seenMap(req.userId) });
  } catch (err) {
    sendError(res, err, 'Failed to load progress');
  }
};

// PUT /api/study/tc-seen/:questionId  { seen: bool, topicId? }
export const setSeen = async (req, res) => {
  try {
    const { questionId } = req.params;
    if (!isId(questionId)) return res.status(400).json({ error: 'Invalid question id' });
    if (req.body?.seen === false) {
      await ToppersSeen.deleteOne({ user: req.userId, question: questionId });
    } else {
      const topicId = isId(req.body?.topicId) ? req.body.topicId : null;
      await ToppersSeen.updateOne(
        { user: req.userId, question: questionId },
        { $set: { toppersCopy: topicId } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 'Failed to save progress');
  }
};

// POST /api/study/tc-seen/import  { seen: { [questionId]: topicId|true } }
// One-time migration of a browser's old localStorage ticks. Adds only — never un-ticks.
export const importSeen = async (req, res) => {
  try {
    const entries = Object.entries(req.body?.seen || {}).filter(([qid]) => isId(qid)).slice(0, SEEN_IMPORT_MAX);
    if (entries.length) {
      await ToppersSeen.bulkWrite(
        entries.map(([qid, topic]) => ({
          updateOne: {
            filter: { user: req.userId, question: qid },
            update: { $setOnInsert: { toppersCopy: isId(topic) ? topic : null } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }
    res.json({ imported: entries.length, seen: await seenMap(req.userId) });
  } catch (err) {
    sendError(res, err, 'Failed to import progress');
  }
};
