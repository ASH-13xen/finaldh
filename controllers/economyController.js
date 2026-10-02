// economyController.js — the Economy Master File module.
//
// Student
//   GET    /api/economy/themes                 theme cards + my progress + "continue" pointer
//   GET    /api/economy/themes/:key            one theme: topics (styled blocks) + my progress
//   GET    /api/economy/themes/:key/pyqs       linked Question Bank topics + PDF-tagged PYQ topics
//   GET    /api/economy/search?q=              topic search across published themes
//   GET    /api/economy/revision               topics due for revision today
//   GET    /api/economy/topics/:id             one topic (used to reopen it from My Notes)
//   PUT    /api/economy/progress/:topicId      { status: read|revised|mastered|null }
//   GET    /api/economy/source-page/:page      that one page of the source PDF (1-page PDF)
//
// Admin (/api/economy/admin/…)
//   GET    /status                             counts + source PDF info
//   GET    /topics?theme=&source=&q=&hidden=   topic list for editing
//   PATCH  /topics/:id                         edit title/theme/body/facts/research/hidden
//   POST   /topics/:id/ai-extras               AI-draft facts + research (saved as draft)
//   PATCH  /themes/:key                        title/description/publish/order/PYQ link
//   POST   /import?mode=&dryRun=&overwriteEdited=   parsed JSON (file or body)
//   POST   /source-pdf                         upload the source PDF (for "view original page")

import fs from 'fs/promises';
import mongoose from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import EconomyTopic from '../models/EconomyTopic.js';
import EconomyTheme from '../models/EconomyTheme.js';
import EconomyProgress, { STATUSES } from '../models/EconomyProgress.js';
import SiteFile from '../models/SiteFile.js';
import QuizQuestion from '../models/QuizQuestion.js';
import User from '../models/User.js';
import { ECONOMY_THEMES } from '../utils/economyThemes.js';
import { importParsed, seedThemes } from '../utils/economyImport.js';
import { runJsonExtraction, assertAiConfigured, getActiveModelLabel } from '../utils/aiProvider.js';

const SOURCE_PDF_KEY = 'economy-master-pdf';
const REVIEW_STEPS_DAYS = [1, 3, 7, 21];
const DAY = 24 * 60 * 60 * 1000;

const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isAdminUser = async (userId) => {
  const user = await User.findById(userId).select('email').lean();
  const admins = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  return !!user && admins.includes((user.email || '').toLowerCase());
};

const sendError = (res, err, label) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(`economy ${label}:`, err);
  return res.status(500).json({ error: label });
};

// Students see published themes; admins see everything (so they can preview before publishing).
const visibleThemeKeys = async (userId) => {
  const admin = await isAdminUser(userId);
  const themes = await EconomyTheme.find(admin ? {} : { isPublished: true }).sort({ order: 1 }).lean();
  return { admin, themes };
};

// What a student is sent for one topic. Facts / research only once an admin publishes them.
const shapeTopic = (t, { admin = false } = {}) => {
  const showExtras = t.extrasStatus === 'published' || admin;
  return {
    _id: t._id,
    themeKey: t.themeKey,
    source: t.source,
    sourceTheme: t.sourceTheme,
    number: t.number,
    title: t.title,
    pages: t.pages,
    blocks: t.blocks,
    pyqTags: t.pyqTags,
    facts: showExtras ? t.facts : [],
    research: showExtras ? t.research : '',
    extrasStatus: admin ? t.extrasStatus : undefined,
  };
};

const shapeProgress = (p) => ({
  status: p.status,
  reviews: p.reviews,
  lastReviewedAt: p.lastReviewedAt,
  nextReviewAt: p.nextReviewAt,
});

// ---------------------------------------------------------------- student

// GET /themes
export const listThemes = async (req, res) => {
  try {
    const { admin, themes } = await visibleThemeKeys(req.userId);
    const keys = themes.map((t) => t.key);
    const userId = new mongoose.Types.ObjectId(req.userId);
    const now = new Date();
    const [counts, pyqCounts, mine, due, last] = await Promise.all([
      EconomyTopic.aggregate([
        { $match: { themeKey: { $in: keys }, hidden: false } },
        { $group: { _id: { theme: '$themeKey', source: '$source' }, n: { $sum: 1 } } },
      ]),
      EconomyTopic.aggregate([
        { $match: { themeKey: { $in: keys }, hidden: false, 'pyqTags.0': { $exists: true } } },
        { $group: { _id: '$themeKey', n: { $sum: 1 } } },
      ]),
      EconomyProgress.aggregate([
        { $match: { user: userId, themeKey: { $in: keys } } },
        { $group: { _id: { theme: '$themeKey', status: '$status' }, n: { $sum: 1 } } },
      ]),
      EconomyProgress.aggregate([
        { $match: { user: userId, themeKey: { $in: keys }, status: { $ne: 'mastered' }, nextReviewAt: { $lte: now } } },
        { $group: { _id: '$themeKey', n: { $sum: 1 } } },
      ]),
      EconomyProgress.findOne({ user: req.userId, themeKey: { $in: keys } }).sort({ updatedAt: -1 }).lean(),
    ]);

    let resume = null;
    if (last) {
      const t = await EconomyTopic.findById(last.topic).select('themeKey title number').lean();
      if (t) resume = { topicId: t._id, themeKey: t.themeKey, title: t.title, number: t.number, at: last.updatedAt };
    }

    res.json({
      admin,
      resume,
      themes: themes.map((th) => {
        const bySource = Object.fromEntries(counts.filter((c) => c._id.theme === th.key).map((c) => [c._id.source, c.n]));
        const progress = Object.fromEntries(mine.filter((c) => c._id.theme === th.key).map((c) => [c._id.status, c.n]));
        return {
          key: th.key,
          title: th.title,
          description: th.description,
          order: th.order,
          isPublished: th.isPublished,
          topicCount: Object.values(bySource).reduce((a, b) => a + b, 0),
          bySource,
          pyqTopicCount: pyqCounts.find((c) => c._id === th.key)?.n || 0,
          hasLinkedPyqs: !!(th.pyq?.subject && th.pyq?.topics?.length),
          progress: { read: progress.read || 0, revised: progress.revised || 0, mastered: progress.mastered || 0 },
          due: due.find((d) => d._id === th.key)?.n || 0,
        };
      }),
    });
  } catch (err) {
    sendError(res, err, 'Failed to load themes');
  }
};

const loadVisibleTheme = async (userId, key) => {
  const { admin, themes } = await visibleThemeKeys(userId);
  const theme = themes.find((t) => t.key === key);
  if (!theme) throw Object.assign(new Error('Theme not found'), { status: 404 });
  return { admin, theme };
};

// GET /themes/:key
export const getTheme = async (req, res) => {
  try {
    const { admin, theme } = await loadVisibleTheme(req.userId, req.params.key);
    const topics = await EconomyTopic.find({ themeKey: theme.key, hidden: false }).sort({ order: 1 }).lean();
    const progress = await EconomyProgress.find({ user: req.userId, topic: { $in: topics.map((t) => t._id) } }).lean();
    res.json({
      admin,
      theme: { key: theme.key, title: theme.title, description: theme.description, isPublished: theme.isPublished, pyq: theme.pyq },
      topics: topics.map((t) => shapeTopic(t, { admin })),
      progress: Object.fromEntries(progress.map((p) => [String(p.topic), shapeProgress(p)])),
    });
  } catch (err) {
    sendError(res, err, 'Failed to load theme');
  }
};

// GET /topics/:id
export const getTopic = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Topic not found' });
    const t = await EconomyTopic.findById(req.params.id).lean();
    if (!t || t.hidden) return res.status(404).json({ error: 'Topic not found' });
    const { admin } = await loadVisibleTheme(req.userId, t.themeKey);
    res.json({ topic: shapeTopic(t, { admin }) });
  } catch (err) {
    sendError(res, err, 'Failed to load topic');
  }
};

// GET /themes/:key/pyqs
export const getThemePyqs = async (req, res) => {
  try {
    const { theme } = await loadVisibleTheme(req.userId, req.params.key);
    let linked = null;
    if (theme.pyq?.subject && theme.pyq?.topics?.length) {
      const rows = await QuizQuestion.aggregate([
        { $match: { subject: theme.pyq.subject, topic: { $in: theme.pyq.topics } } },
        { $group: { _id: '$topic', n: { $sum: 1 } } },
      ]);
      linked = {
        subject: theme.pyq.subject,
        topics: theme.pyq.topics.map((t) => ({ topic: t, count: rows.find((r) => r._id === t)?.n || 0 })).filter((t) => t.count),
      };
    }
    const tagged = await EconomyTopic.find({ themeKey: theme.key, hidden: false, 'pyqTags.0': { $exists: true } })
      .sort({ order: 1 }).select('title number source pyqTags').lean();
    res.json({ linked, tagged });
  } catch (err) {
    sendError(res, err, 'Failed to load PYQs');
  }
};

// GET /search?q=
export const searchTopics = async (req, res) => {
  try {
    const q = clip(req.query.q, 100);
    if (q.length < 2) return res.json({ results: [] });
    const { admin, themes } = await visibleThemeKeys(req.userId);
    const rx = new RegExp(escapeRegex(q), 'i');
    const rows = await EconomyTopic.find({
      themeKey: { $in: themes.map((t) => t.key) },
      hidden: false,
      $or: [{ title: rx }, { 'blocks.spans.t': rx }, { pyqTags: rx }],
    }).sort({ order: 1 }).limit(60).select('themeKey title number source blocks pyqTags').lean();
    const titleOf = Object.fromEntries(themes.map((t) => [t.key, t.title]));
    res.json({
      admin,
      results: rows
        .map((t) => {
          const inTitle = rx.test(t.title);
          let snippet = '';
          for (const b of t.blocks) {
            const text = b.spans.map((s) => s.t || '').join('');
            const i = text.search(rx);
            if (i >= 0) { snippet = `${i > 40 ? '…' : ''}${text.slice(Math.max(0, i - 40), i + 100)}`; break; }
          }
          return { _id: t._id, themeKey: t.themeKey, themeTitle: titleOf[t.themeKey], title: t.title, number: t.number, source: t.source, snippet, inTitle };
        })
        .sort((a, b) => Number(b.inTitle) - Number(a.inTitle)),
    });
  } catch (err) {
    sendError(res, err, 'Search failed');
  }
};

// GET /revision — due (or overdue) topics, oldest first.
export const revisionQueue = async (req, res) => {
  try {
    const { themes } = await visibleThemeKeys(req.userId);
    const rows = await EconomyProgress.find({
      user: req.userId,
      themeKey: { $in: themes.map((t) => t.key) },
      status: { $ne: 'mastered' },
      nextReviewAt: { $lte: new Date() },
    }).sort({ nextReviewAt: 1 }).limit(100).lean();
    const topics = await EconomyTopic.find({ _id: { $in: rows.map((r) => r.topic) }, hidden: false })
      .select('themeKey title number source').lean();
    const byId = new Map(topics.map((t) => [String(t._id), t]));
    const titleOf = Object.fromEntries(themes.map((t) => [t.key, t.title]));
    res.json({
      due: rows
        .filter((r) => byId.has(String(r.topic)))
        .map((r) => {
          const t = byId.get(String(r.topic));
          return { _id: t._id, themeKey: t.themeKey, themeTitle: titleOf[t.themeKey], title: t.title, number: t.number, source: t.source, ...shapeProgress(r) };
        }),
    });
  } catch (err) {
    sendError(res, err, 'Failed to load revision queue');
  }
};

// PUT /progress/:topicId  { status }
// read / revised schedule the next revision on the 1-3-7-21 day ladder; mastered clears it;
// null removes the row (un-tick).
export const setProgress = async (req, res) => {
  try {
    const { topicId } = req.params;
    if (!isId(topicId)) return res.status(400).json({ error: 'Invalid topic id' });
    const status = req.body?.status ?? null;
    if (status !== null && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')} or null` });

    const topic = await EconomyTopic.findById(topicId).select('themeKey hidden').lean();
    if (!topic || topic.hidden) return res.status(404).json({ error: 'Topic not found' });
    await loadVisibleTheme(req.userId, topic.themeKey);

    if (status === null) {
      await EconomyProgress.deleteOne({ user: req.userId, topic: topicId });
      return res.json({ progress: null });
    }
    const prev = await EconomyProgress.findOne({ user: req.userId, topic: topicId }).lean();
    const now = new Date();
    // read = first rung (again tomorrow); each revised climbs one rung; mastered stops the ladder
    const reviews = status === 'read' ? 1 : status === 'revised' ? Math.max(prev?.reviews || 0, 1) + 1 : prev?.reviews || 0;
    const step = REVIEW_STEPS_DAYS[Math.min(reviews - 1, REVIEW_STEPS_DAYS.length - 1)] || 1;
    const doc = await EconomyProgress.findOneAndUpdate(
      { user: req.userId, topic: topicId },
      {
        $set: {
          themeKey: topic.themeKey,
          status,
          reviews,
          lastReviewedAt: now,
          nextReviewAt: status === 'mastered' ? null : new Date(now.getTime() + step * DAY),
        },
      },
      { upsert: true, returnDocument: 'after' }
    ).lean();
    res.json({ progress: shapeProgress(doc) });
  } catch (err) {
    sendError(res, err, 'Failed to save progress');
  }
};

// The source PDF is fetched from storage once and kept in memory; each request gets a fresh
// single-page PDF, so the full file is never handed to the browser.
let sourceCache = null; // { storageKey, updatedAt, doc }
const loadSourcePdf = async () => {
  const meta = await SiteFile.findOne({ key: SOURCE_PDF_KEY }).lean();
  if (!meta) return null;
  if (sourceCache && sourceCache.storageKey === meta.storageKey && +sourceCache.updatedAt === +meta.updatedAt) return sourceCache.doc;
  const obj = await r2Client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: meta.storageKey.replace('r2://', '') }));
  const bytes = Buffer.from(await obj.Body.transformToByteArray());
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  sourceCache = { storageKey: meta.storageKey, updatedAt: meta.updatedAt, doc };
  return doc;
};

// GET /source-page/:page
export const getSourcePage = async (req, res) => {
  try {
    const page = parseInt(req.params.page, 10);
    // only pages that hold a topic of a theme this user can see
    const { themes } = await visibleThemeKeys(req.userId);
    const ok = await EconomyTopic.exists({ themeKey: { $in: themes.map((t) => t.key) }, hidden: false, pages: page });
    if (!ok) return res.status(404).json({ error: 'Page not available' });
    const src = await loadSourcePdf();
    if (!src) return res.status(404).json({ error: 'The source PDF has not been uploaded yet' });
    if (page < 1 || page > src.getPageCount()) return res.status(404).json({ error: 'Page out of range' });
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(src, [page - 1]);
    out.addPage(copied);
    const bytes = await out.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(bytes));
  } catch (err) {
    sendError(res, err, 'Failed to load page');
  }
};

// ---------------------------------------------------------------- admin

const adminOnly = async (req, res) => {
  if (await isAdminUser(req.userId)) return true;
  res.status(403).json({ error: 'Access denied: Admin only' });
  return false;
};

// GET /admin/status
export const adminStatus = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    await seedThemes();
    const [themes, counts, extras, pdf] = await Promise.all([
      EconomyTheme.find({}).sort({ order: 1 }).lean(),
      EconomyTopic.aggregate([{ $group: { _id: { theme: '$themeKey', hidden: '$hidden' }, n: { $sum: 1 } } }]),
      EconomyTopic.aggregate([{ $match: { hidden: false } }, { $group: { _id: { theme: '$themeKey', st: '$extrasStatus' }, n: { $sum: 1 } } }]),
      SiteFile.findOne({ key: SOURCE_PDF_KEY }).lean(),
    ]);
    const banks = await QuizQuestion.aggregate([{ $group: { _id: '$subject', topics: { $addToSet: '$topic' } } }]);
    res.json({
      themes: themes.map((t) => ({
        ...t,
        topicCount: counts.find((c) => c._id.theme === t.key && !c._id.hidden)?.n || 0,
        hiddenCount: counts.find((c) => c._id.theme === t.key && c._id.hidden)?.n || 0,
        extras: Object.fromEntries(extras.filter((e) => e._id.theme === t.key).map((e) => [e._id.st, e.n])),
      })),
      sourcePdf: pdf ? { originalName: pdf.originalName, pageCount: pdf.pageCount, size: pdf.size, updatedAt: pdf.updatedAt } : null,
      banks: banks.map((b) => ({ subject: b._id, topics: b.topics.filter(Boolean).sort() })).sort((a, b) => a.subject.localeCompare(b.subject)),
      ai: getActiveModelLabel(),
    });
  } catch (err) {
    sendError(res, err, 'Failed to load status');
  }
};

// GET /admin/topics
export const adminListTopics = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const filter = {};
    if (typeof req.query.theme === 'string' && req.query.theme) filter.themeKey = req.query.theme;
    if (['forum', 'partB', 'vision'].includes(req.query.source)) filter.source = req.query.source;
    if (req.query.hidden === 'only') filter.hidden = true;
    else if (req.query.hidden !== 'all') filter.hidden = false;
    if (['none', 'draft', 'published'].includes(req.query.extras)) filter.extrasStatus = req.query.extras;
    const q = clip(req.query.q, 100);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ title: rx }, { 'blocks.spans.t': rx }, { sourceTheme: rx }];
    }
    const topics = await EconomyTopic.find(filter).sort({ order: 1 }).limit(1000).lean();
    res.json({ topics: topics.map((t) => ({ ...shapeTopic(t, { admin: true }), hidden: t.hidden, editedAt: t.editedAt, importKey: t.importKey })) });
  } catch (err) {
    sendError(res, err, 'Failed to load topics');
  }
};

const cleanEditedBlocks = (blocks) => (Array.isArray(blocks) ? blocks : []).slice(0, 300).map((b) => ({
  level: Math.max(0, Math.min(3, Number(b?.level) || 0)),
  glyph: typeof b?.glyph === 'string' ? b.glyph.slice(0, 4) : null,
  heading: !!b?.heading,
  spans: (Array.isArray(b?.spans) ? b.spans : []).slice(0, 200).map((s) => {
    const o = { t: typeof s?.t === 'string' ? s.t.slice(0, 4000) : '' };
    if (s?.b) o.b = 1;
    if (['g', 'c', 'y'].includes(s?.hl)) o.hl = s.hl;
    if (['ok', 'no'].includes(s?.m)) { o.m = s.m; o.t = ''; }
    return o;
  }).filter((s) => s.t || s.m),
})).filter((b) => b.spans.length);

// PATCH /admin/topics/:id
export const adminUpdateTopic = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Topic not found' });
    const t = await EconomyTopic.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Topic not found' });
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) { t.title = clip(b.title, 300); t.editedAt = new Date(); }
    if (Array.isArray(b.blocks)) { t.blocks = cleanEditedBlocks(b.blocks); t.editedAt = new Date(); }
    if (typeof b.themeKey === 'string') {
      if (!ECONOMY_THEMES.some((x) => x.key === b.themeKey)) return res.status(400).json({ error: 'Unknown theme' });
      t.themeKey = b.themeKey;
      await EconomyProgress.updateMany({ topic: t._id }, { $set: { themeKey: b.themeKey } });
    }
    if (Array.isArray(b.facts)) t.facts = b.facts.map((f) => clip(f, 600)).filter(Boolean).slice(0, 10);
    if (typeof b.research === 'string') t.research = clip(b.research, 4000);
    if (['none', 'draft', 'published'].includes(b.extrasStatus)) t.extrasStatus = b.extrasStatus;
    if (typeof b.hidden === 'boolean') t.hidden = b.hidden;
    if (Array.isArray(b.pyqTags)) t.pyqTags = b.pyqTags.map((x) => clip(x, 60)).filter(Boolean).slice(0, 20);
    await t.save();
    res.json({ topic: { ...shapeTopic(t.toObject(), { admin: true }), hidden: t.hidden, editedAt: t.editedAt } });
  } catch (err) {
    sendError(res, err, 'Failed to save topic');
  }
};

const EXTRAS_SYSTEM = `You write short study add-ons for Indian UPSC aspirants revising Economy.
You are given one topic from a revision master file. Do NOT repeat or rephrase the notes — add to them.
Return JSON only: {"facts": [string], "research": string}
- facts: 2-3 relatable, real-world hooks that make the concept stick — a well-known Indian or global
  episode, a number a student can picture, an everyday analogy. One sentence each, max 30 words.
- research: 3-5 crisp lines (separate with \\n) of "beyond the book" value: the latest official data
  or rule change you are confident about, the committee/report/act behind it, and one Mains angle.
  Start each line with a short bold-free label like "Latest:", "Source:", "Mains angle:".
- Accuracy first: use only widely documented facts (RBI / Budget / Economic Survey / well-known
  history). Never invent an event, allocation, date or number; if unsure, leave it out — fewer
  items is fine. No markdown.`;

// POST /admin/topics/:id/ai-extras
export const adminAiExtras = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Topic not found' });
    const t = await EconomyTopic.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Topic not found' });
    try { assertAiConfigured(); } catch (e) { return res.status(503).json({ error: e.message }); }

    const notes = t.blocks.map((b) => `${'  '.repeat(b.level)}- ${b.spans.map((s) => (s.m === 'ok' ? '[correct] ' : s.m === 'no' ? '[wrong] ' : s.t)).join('')}`).join('\n');
    const out = await runJsonExtraction({
      system: EXTRAS_SYSTEM,
      prompt: `Theme: ${t.themeKey}\nTopic: ${t.title}\n\nNotes:\n${notes}`,
      maxOutputTokens: 1500,
      maxRetries: 3,
    });
    const facts = (Array.isArray(out?.facts) ? out.facts : []).map((f) => clip(String(f), 600)).filter(Boolean).slice(0, 5);
    const research = clip(typeof out?.research === 'string' ? out.research : '', 4000);
    if (!facts.length && !research) return res.status(502).json({ error: 'The AI returned nothing usable — try again' });
    t.facts = facts;
    t.research = research;
    t.extrasStatus = 'draft';
    await t.save();
    res.json({ topic: { ...shapeTopic(t.toObject(), { admin: true }), hidden: t.hidden, editedAt: t.editedAt }, model: getActiveModelLabel() });
  } catch (err) {
    sendError(res, err, 'AI draft failed');
  }
};

// PATCH /admin/themes/:key
export const adminUpdateTheme = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    await seedThemes();
    const th = await EconomyTheme.findOne({ key: req.params.key });
    if (!th) return res.status(404).json({ error: 'Theme not found' });
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) th.title = clip(b.title, 120);
    if (typeof b.description === 'string') th.description = clip(b.description, 600);
    if (typeof b.isPublished === 'boolean') th.isPublished = b.isPublished;
    if (Number.isFinite(b.order)) th.order = b.order;
    if (b.pyq && typeof b.pyq === 'object') {
      th.pyq = {
        subject: clip(b.pyq.subject, 120),
        topics: (Array.isArray(b.pyq.topics) ? b.pyq.topics : []).map((x) => clip(x, 200)).filter(Boolean).slice(0, 100),
      };
    }
    await th.save();
    res.json({ theme: th });
  } catch (err) {
    sendError(res, err, 'Failed to save theme');
  }
};

// POST /admin/import  (multipart "file" or JSON body)
export const adminImport = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    let parsed = req.body;
    if (req.file) {
      try { parsed = JSON.parse(await fs.readFile(req.file.path, 'utf8')); }
      catch { return res.status(400).json({ error: 'File is not valid JSON' }); }
      finally { fs.unlink(req.file.path).catch(() => {}); }
    }
    const report = await importParsed(parsed, {
      mode: req.query.mode === 'replace' ? 'replace' : 'merge',
      overwriteEdited: req.query.overwriteEdited === 'true',
      dryRun: req.query.dryRun === 'true',
    });
    res.json({ ...report, errors: report.errors.slice(0, 100), dryRun: req.query.dryRun === 'true' });
  } catch (err) {
    sendError(res, err, 'Import failed');
  }
};

// POST /admin/source-pdf  (multipart "file")
export const adminUploadSourcePdf = async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    if (!req.file) return res.status(400).json({ error: 'PDF file is required' });
    try {
      const bytes = await fs.readFile(req.file.path);
      let pageCount;
      try { pageCount = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); }
      catch { return res.status(400).json({ error: 'That file is not a readable PDF' }); }
      const key = `economy-master/source-${Date.now()}.pdf`;
      await r2Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: bytes, ContentType: 'application/pdf' }));
      const doc = await SiteFile.findOneAndUpdate(
        { key: SOURCE_PDF_KEY },
        { $set: { storageKey: `r2://${key}`, originalName: req.file.originalname, pageCount, size: bytes.length } },
        { upsert: true, returnDocument: 'after' }
      ).lean();
      sourceCache = null;
      res.json({ sourcePdf: { originalName: doc.originalName, pageCount: doc.pageCount, size: doc.size, updatedAt: doc.updatedAt } });
    } finally {
      fs.unlink(req.file.path).catch(() => {});
    }
  } catch (err) {
    sendError(res, err, 'Upload failed');
  }
};
