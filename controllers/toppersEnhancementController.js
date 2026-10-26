// Toppers Copy — the margin "enhancement layer" over one topper's answer copy.
// Generation lives in utils/toppersEnhancement.js; this file is the HTTP layer:
//
//   POST   /api/toppers-copy/admin/:id/questions/:qid/answers/:aidx/enhance   (re)generate a draft
//   GET    /api/toppers-copy/admin/:id/enhancements                           all layers of a topic (+ tone issues)
//   PATCH  /api/toppers-copy/admin/enhancements/:eid                          edit notes / takeaways / publish
//   DELETE /api/toppers-copy/admin/enhancements/:eid
//
// Students receive published layers inline with GET /api/toppers-copy/:id (see
// enhancementsByAnswer), never drafts.

import mongoose from 'mongoose';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersEnhancement from '../models/ToppersEnhancement.js';
import { requireAdmin } from './progressController.js';
import { assertAiConfigured } from '../utils/aiProvider.js';
import {
  generateAnswerEnhancement,
  findToneIssues,
  shapeNote,
  shapeTakeaways,
} from '../utils/toppersEnhancement.js';

const rangeKey = (s, e) => `${s}-${e}`;

const publicShape = (enh) => ({
  _id: enh._id,
  notes: (enh.notes || []).map((n) => ({
    _id: n._id, page: n.page, kind: n.kind, yFrom: n.yFrom, yTo: n.yTo,
    title: n.title, text: n.text, use: n.use || '', points: n.points || [], diagram: n.diagram || '',
  })),
  takeaways: {
    techniques: enh.takeaways?.techniques || [],
    enrichment: enh.takeaways?.enrichment || [],
    keywords: enh.takeaways?.keywords || [],
    altIntro: { text: enh.takeaways?.altIntro?.text || '', keywords: enh.takeaways?.altIntro?.keywords || [] },
    altConclusion: { text: enh.takeaways?.altConclusion?.text || '', keywords: enh.takeaways?.altConclusion?.keywords || [] },
  },
  published: !!enh.published,
});

const adminShape = (enh) => ({
  ...publicShape(enh),
  questionId: enh.questionId,
  startPage: enh.startPage,
  endPage: enh.endPage,
  topperName: enh.topperName,
  aiModel: enh.aiModel,
  generatedAt: enh.generatedAt,
  editedAt: enh.editedAt,
  toneIssues: findToneIssues(enh),
});

/**
 * Map "startPage-endPage" → layer, for attaching to answers in GET /:id.
 * Students get published layers only; admins get drafts too (flagged by `published`).
 */
export const enhancementsByAnswer = async (toppersCopyId, { admin = false } = {}) => {
  const filter = { toppersCopy: toppersCopyId, ...(admin ? {} : { published: true }) };
  const rows = await ToppersEnhancement.find(filter).lean();
  return new Map(rows.map((r) => [rangeKey(r.startPage, r.endPage), publicShape(r)]));
};

// POST /admin/:id/questions/:qid/answers/:aidx/enhance
export const enhanceAnswer = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    assertAiConfigured();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const doc = await ToppersCopy.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const question = doc.questions.id(req.params.qid);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    const aidx = Number(req.params.aidx);
    const answer = Number.isInteger(aidx) ? question.answers[aidx] : null;
    if (!answer) return res.status(404).json({ error: 'Answer not found' });

    const gen = await generateAnswerEnhancement(doc, question, answer);

    // A regenerate always goes back to draft — the admin re-reviews before students see it.
    const enh = await ToppersEnhancement.findOneAndUpdate(
      { toppersCopy: doc._id, startPage: answer.startPage, endPage: answer.endPage },
      {
        $set: {
          questionId: question._id,
          topperName: answer.name,
          notes: gen.notes,
          takeaways: gen.takeaways,
          aiModel: gen.aiModel,
          generatedAt: gen.generatedAt,
          editedAt: null,
          published: false,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ message: `Enhancement drafted (${enh.notes.length} notes).`, enhancement: adminShape(enh) });
  } catch (err) {
    if (err.code === 'NO_PDF' || err.code === 'NO_ANSWER') {
      return res.status(400).json({ error: err.message });
    }
    console.error('enhanceAnswer error:', err);
    res.status(500).json({ error: err.message || 'Enhancement failed' });
  }
};

// GET /admin/:id/enhancements
export const listEnhancements = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const rows = await ToppersEnhancement.find({ toppersCopy: req.params.id }).sort({ startPage: 1 });
    res.json({ enhancements: rows.map(adminShape) });
  } catch (err) {
    console.error('listEnhancements error:', err);
    res.status(500).json({ error: 'Failed to load enhancements' });
  }
};

// PATCH /admin/enhancements/:eid  { notes?, takeaways?, published?, ignoreTone? }
// Publishing is refused (409) while any line still reads like a critique, unless
// the admin explicitly overrides with ignoreTone: true.
export const updateEnhancement = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const enh = await ToppersEnhancement.findById(req.params.eid);
    if (!enh) return res.status(404).json({ error: 'Not found' });

    const edited = 'notes' in req.body || 'takeaways' in req.body;
    if (Array.isArray(req.body.notes)) {
      enh.notes = req.body.notes
        .map((n) => shapeNote(n, { lo: enh.startPage, hi: enh.endPage }))
        .filter(Boolean)
        .sort((x, y) => x.page - y.page || x.yFrom - y.yFrom);
    }
    if (req.body.takeaways && typeof req.body.takeaways === 'object') {
      enh.takeaways = shapeTakeaways(req.body.takeaways);
    }
    if (edited) enh.editedAt = new Date();

    if (typeof req.body.published === 'boolean') {
      if (req.body.published && !req.body.ignoreTone) {
        const issues = findToneIssues(enh);
        if (issues.length) {
          return res.status(409).json({
            error: `${issues.length} line(s) read like a critique — reword them, or publish anyway.`,
            toneIssues: issues,
          });
        }
      }
      enh.published = req.body.published;
    }

    await enh.save();
    res.json({ enhancement: adminShape(enh) });
  } catch (err) {
    console.error('updateEnhancement error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
};

// DELETE /admin/enhancements/:eid
export const deleteEnhancement = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const enh = await ToppersEnhancement.findByIdAndDelete(req.params.eid);
    if (!enh) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Enhancement deleted.' });
  } catch (err) {
    console.error('deleteEnhancement error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
};
