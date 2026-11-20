// Notes: current-topic notes and the 100-question guide. Students read what admins have published; admins
// draft notes with AI from the sources they choose, review, edit, publish, and prepare the guide.
import mongoose from 'mongoose';
import InterviewNote from '../models/InterviewNote.js';
import InterviewGuide from '../models/InterviewGuide.js';
import InterviewProfile from '../models/InterviewProfile.js';
import User from '../models/User.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { checkGemini } from '../lib/interview/gemini.js';
import {
  generateNote, cleanUrls, sanitizeLangNote, cleanTags, noteSlug, profileText, matchTags,
  CATEGORIES, MAX_TEXT, MIN_TEXT
} from '../lib/interview/notes.js';
import { startGuideJob, guideStatusOf, sanitizeGuidance, GUIDE_KEY } from '../lib/interview/guide.js';

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const langOf = (req) => (req.query.lang === 'hi' ? 'hi' : 'en');
const NOTE_STALE_MS = 10 * 60 * 1000; // a draft still "generating" after this long was lost to a restart
const NOTES_PER_DAY = 40; // drafts any admin can start in 24 hours (each is a paid AI call)

const isAdminRequest = async (req) => {
  const u = await User.findById(req.userId).select('email').lean();
  return !!u && isAdminEmail(u.email);
};

const statusOf = (n) => (n.status === 'generating' && Date.now() - new Date(n.updatedAt).getTime() > NOTE_STALE_MS ? 'failed' : n.status);
const pick = (n, lang) => n?.[lang] || n?.en || null;

// ------------------------------------------------------------------ students

// Published notes, newest first, in the student's language; the ones that fit the student's DAF are marked.
export const listNotes = async (req, res) => {
  try {
    const lang = langOf(req);
    const [notes, profile] = await Promise.all([
      InterviewNote.find({ status: 'published' }).sort({ publishedAt: -1 }).limit(300).select('slug category tags en hi publishedAt updatedAt').lean(),
      InterviewProfile.findOne({ user: req.userId }).lean()
    ]);
    const text = profileText(profile);
    res.json({
      notes: notes.map((n) => {
        const c = pick(n, lang);
        const matched = matchTags(n.tags, text);
        return {
          slug: n.slug,
          category: n.category,
          title: c?.title || '',
          why: c?.why || '',
          likelyFor: c?.likelyFor || [],
          questions: c?.questions?.length || 0,
          date: n.publishedAt || n.updatedAt,
          forYou: matched.length > 0
        };
      }),
      categories: CATEGORIES,
      hasDaf: !!text.trim()
    });
  } catch (err) {
    console.error('[interview] listNotes error:', err);
    fail(res, 500, 'Could not load the notes.');
  }
};

export const getNote = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').slice(0, 120);
    const n = await InterviewNote.findOne({ slug }).lean();
    if (!n || (n.status !== 'published' && !(await isAdminRequest(req)))) return fail(res, 404, 'That note is not available.');
    const lang = langOf(req);
    res.json({
      note: {
        slug: n.slug,
        status: n.status,
        category: n.category,
        tags: n.tags,
        date: n.publishedAt || n.updatedAt,
        sources: n.sources || [],
        lang: n[lang] ? lang : 'en',
        ...pick(n, lang)
      }
    });
  } catch (err) {
    console.error('[interview] getNote error:', err);
    fail(res, 500, 'Could not load that note.');
  }
};

// The published guide in the student's language (hidden entries left out). Visitors who haven't signed in
// get its first GUIDE_PREVIEW questions and the total.
export const GUIDE_PREVIEW = 5;
export const getGuide = async (req, res) => {
  try {
    const lang = langOf(req);
    const g = await InterviewGuide.findOne({ key: GUIDE_KEY }).select('published').lean();
    if (!g?.published?.at) return res.json({ status: 'none' });
    const visible = (g.published.entries || []).filter((e) => !e.hidden && e.en);
    const preview = !req.userId;
    res.json({
      status: 'published',
      publishedAt: g.published.at,
      corpus: g.published.corpus || null,
      total: visible.length,
      ...(preview ? { preview: true } : {}),
      entries: (preview ? visible.slice(0, GUIDE_PREVIEW) : visible).map((e) => ({
        key: e.key,
        text: lang === 'hi' && e.textHi ? e.textHi : e.text,
        textEn: e.text,
        qtype: e.qtype,
        timesAsked: e.timesAsked,
        years: e.years,
        guide: (lang === 'hi' && e.hi) || e.en
      }))
    });
  } catch (err) {
    console.error('[interview] getGuide error:', err);
    fail(res, 500, 'Could not load the guide.');
  }
};

// ------------------------------------------------------------------ admins: notes

const adminSummary = (n) => ({
  id: String(n._id),
  slug: n.slug,
  status: statusOf(n),
  topic: n.topic,
  category: n.category,
  title: n.en?.title || n.topic,
  titleHi: n.hi?.title || '',
  questions: n.en?.questions?.length || 0,
  sources: n.sources || [],
  input: n.input || { urls: [], textChars: 0 },
  error: n.error || '',
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
  publishedAt: n.publishedAt
});

export const adminListNotes = async (req, res) => {
  try {
    const notes = await InterviewNote.find({}).sort({ createdAt: -1 }).limit(500)
      .select('-en.sections -en.questions.answer -hi.why -hi.sections -hi.questions -hi.likelyFor -hi.keywords').lean();
    res.json({ notes: notes.map(adminSummary), categories: CATEGORIES });
  } catch (err) {
    console.error('[interview] adminListNotes error:', err);
    fail(res, 500, 'Could not load the notes.');
  }
};

export const adminGetNote = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Note not found.');
  try {
    const n = await InterviewNote.findById(req.params.id).lean();
    if (!n) return fail(res, 404, 'Note not found.');
    res.json({ note: { ...adminSummary(n), tags: n.tags, en: n.en, hi: n.hi } });
  } catch (err) {
    console.error('[interview] adminGetNote error:', err);
    fail(res, 500, 'Could not load that note.');
  }
};

const uniqueSlug = async (title, id) => {
  const base = noteSlug(title);
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await InterviewNote.exists({ slug, _id: { $ne: id } }))) return slug;
  }
  return `${base}-${String(id).slice(-6)}`;
};

// Starts an AI draft from the topic and sources and answers at once; the draft appears when it is written
// (about a minute), so the request never waits on Gemini.
export const adminCreateNote = async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const urls = cleanUrls(req.body?.urls);
    const text = String(req.body?.text || '').trim().slice(0, MAX_TEXT);
    if (topic.length < 3) return fail(res, 400, 'Name the topic first.');
    if (!urls.length && text.length < MIN_TEXT) return fail(res, 400, 'Add at least one link, or paste the article text, so the note is written from real sources.');
    if (!(await checkGemini())) return fail(res, 503, 'Writing notes needs AI, which is not switched on right now.', { aiUnavailable: true });
    if (await InterviewNote.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }) >= NOTES_PER_DAY) {
      return fail(res, 429, `${NOTES_PER_DAY} drafts have been started in the last 24 hours. Try again later.`, { limited: true });
    }
    const id = new mongoose.Types.ObjectId();
    const note = await InterviewNote.create({
      _id: id, slug: `draft-${id}`, status: 'generating', topic, input: { urls, textChars: text.length }, createdBy: req.userId
    });
    res.status(202).json({ note: adminSummary(note.toObject()) });

    (async () => {
      try {
        const out = await generateNote({ topic, urls, text });
        const slug = await uniqueSlug(out.en.title, id);
        const u = out.usage || {};
        console.log(`[interview] note drafted: ${slug} (tokens in ${u.promptTokenCount || 0} + tools ${u.toolUsePromptTokenCount || 0}, out ${u.candidatesTokenCount || 0}, thinking ${u.thoughtsTokenCount || 0}; read ${JSON.stringify(out.read)})`);
        await InterviewNote.updateOne({ _id: id }, {
          $set: {
            slug, status: 'draft', category: out.category, tags: out.tags, en: out.en, hi: out.hi, sources: out.sources,
            error: out.unread.length ? `Could not open: ${out.unread.join(', ')}`.slice(0, 600) : ''
          }
        });
      } catch (err) {
        console.error('[interview] note draft failed:', err?.message || err);
        await InterviewNote.updateOne({ _id: id }, { $set: { status: 'failed', error: String(err?.message || err).slice(0, 400) } }).catch(() => {});
      }
    })();
  } catch (err) {
    console.error('[interview] adminCreateNote error:', err);
    if (!res.headersSent) fail(res, 500, 'Could not start the draft.');
  }
};

// Edit and/or publish: { status: 'published' | 'draft', category, tags, en, hi } - any subset.
export const adminUpdateNote = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Note not found.');
  try {
    const n = await InterviewNote.findById(req.params.id);
    if (!n) return fail(res, 404, 'Note not found.');
    const b = req.body || {};
    if (['generating', 'failed'].includes(statusOf(n))) return fail(res, 409, 'This note has no draft to edit yet.');
    for (const lang of ['en', 'hi']) {
      if (b[lang] === undefined) continue;
      const clean = sanitizeLangNote(b[lang]);
      if (!clean) return fail(res, 400, `The ${lang === 'en' ? 'English' : 'Hindi'} note needs a title and at least one section with points.`);
      n[lang] = clean;
      n.markModified(lang);
    }
    if (b.category !== undefined) n.category = CATEGORIES.includes(b.category) ? b.category : n.category;
    if (b.tags !== undefined) n.tags = cleanTags(Array.isArray(b.tags) ? b.tags : String(b.tags).split(','));
    if (b.status === 'published' || b.status === 'draft') {
      if (b.status === 'published' && (!n.en || !n.hi)) return fail(res, 400, 'Both the English and the Hindi note are needed to publish.');
      if (b.status === 'published' && !n.publishedAt) n.publishedAt = new Date();
      n.status = b.status;
    }
    await n.save();
    res.json({ note: { ...adminSummary(n.toObject()), tags: n.tags, en: n.en, hi: n.hi } });
  } catch (err) {
    console.error('[interview] adminUpdateNote error:', err);
    fail(res, 500, 'Could not save the note.');
  }
};

export const adminDeleteNote = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Note not found.');
  try {
    await InterviewNote.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview] adminDeleteNote error:', err);
    fail(res, 500, 'Could not delete the note.');
  }
};

// ------------------------------------------------------------------ admins: the guide

const guidePayload = (g) => ({
  status: guideStatusOf(g),
  progress: g?.progress || { done: 0, total: 0, step: '' },
  error: g?.error || '',
  generatedAt: g?.generatedAt || null,
  corpus: g?.corpus || null,
  entries: g?.entries || [],
  published: g?.published?.at ? { at: g.published.at, count: (g.published.entries || []).filter((e) => !e.hidden).length } : null
});

export const adminGetGuide = async (req, res) => {
  try {
    res.json({ guide: guidePayload(await InterviewGuide.findOne({ key: GUIDE_KEY }).lean()) });
  } catch (err) {
    console.error('[interview] adminGetGuide error:', err);
    fail(res, 500, 'Could not load the guide.');
  }
};

export const adminGenerateGuide = async (req, res) => {
  try {
    if (!(await checkGemini())) return fail(res, 503, 'Preparing the guide needs AI, which is not switched on right now.', { aiUnavailable: true });
    if (!(await startGuideJob())) return fail(res, 409, 'The guide is already being prepared.');
    res.status(202).json({ guide: guidePayload(await InterviewGuide.findOne({ key: GUIDE_KEY }).lean()) });
  } catch (err) {
    console.error('[interview] adminGenerateGuide error:', err);
    fail(res, 500, 'Could not start preparing the guide.');
  }
};

// { entries: [{ key, hidden?, text?, textHi?, en?, hi? }] } edits the working copy;
// { publish: true } makes the working copy what students see; { publish: false } takes the guide down.
export const adminUpdateGuide = async (req, res) => {
  try {
    const g = await InterviewGuide.findOne({ key: GUIDE_KEY });
    if (!g) return fail(res, 404, 'The guide has not been prepared yet.');
    const b = req.body || {};
    if (Array.isArray(b.entries)) {
      if (guideStatusOf(g) === 'generating') return fail(res, 409, 'Wait for the guide to finish preparing.');
      const byKey = new Map(g.entries.map((e) => [e.key, e]));
      for (const edit of b.entries.slice(0, 200)) {
        const e = byKey.get(String(edit?.key || ''));
        if (!e) continue;
        if (typeof edit.hidden === 'boolean') e.hidden = edit.hidden;
        if (typeof edit.text === 'string' && edit.text.trim()) e.text = edit.text.trim().slice(0, 300);
        if (typeof edit.textHi === 'string') e.textHi = edit.textHi.trim().slice(0, 300);
        for (const lang of ['en', 'hi']) {
          if (edit[lang] === undefined) continue;
          const clean = sanitizeGuidance(edit[lang]);
          if (!clean) return fail(res, 400, 'Each answer guide needs "what it tests" and at least one step.');
          e[lang] = clean;
        }
      }
      g.markModified('entries');
    }
    if (b.publish === true) {
      if (guideStatusOf(g) === 'generating') return fail(res, 409, 'Wait for the guide to finish preparing.');
      if (!g.entries.some((e) => !e.hidden && e.en)) return fail(res, 400, 'The guide has no questions to publish.');
      g.published = { at: new Date(), corpus: g.corpus, entries: g.entries.map((e) => (e.toObject ? e.toObject() : e)) };
      g.markModified('published');
    } else if (b.publish === false) {
      g.published = { at: null, entries: [] };
      g.markModified('published');
    }
    await g.save();
    res.json({ guide: guidePayload(g.toObject()) });
  } catch (err) {
    console.error('[interview] adminUpdateGuide error:', err);
    fail(res, 500, 'Could not save the guide.');
  }
};
