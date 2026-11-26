// tdhController.js — PYQ & TDH Research. See models/TdhResearch.js.
//
// Student (published sets only; admins also see drafts)
//   GET    /api/tdh                                 sets with sections + the student's progress
//   GET    /api/tdh/sets/:id/sections/:num          that section's PYQs (answers only for attempted ones)
//   POST   /api/tdh/questions/:id/answer            { key } ('' = just show it) → answer, explanation,
//                                                   TDH Research, approved practice MCQs
//   DELETE /api/tdh/sets/:id/attempts?section=      start a section (or the set) again
//
// Admin (/api/tdh/admin/…)
//   GET    /sets                                    sets + gap counts + practice counts + AI job
//   POST   /sets                                    multipart: subject, title, questions (.docx|.json), solutions (.docx)
//   POST   /sets/:id/files                          multipart: questions and/or solutions — updated by number, keeps
//                                                   answers / types / practice already set
//   PATCH  /sets/:id                                { title, subject, isPublished, order }
//   DELETE /sets/:id
//   GET    /sets/:id/questions?section=&filter=     filter: noanswer | nosolution | notype | drafts | nopractice | hidden
//   PATCH  /questions/:id                           { answer, type, questionText, lines, options, hidden, title }
//   POST   /sets/:id/practice/run                   { limit, section, redo } — AI job
//   POST   /sets/:id/practice/stop
//   POST   /sets/:id/practice/approve               { section } — approve every draft (in the section)
//   POST   /questions/:id/practice/generate         AI for this one question, right away
//   POST   /questions/:id/practice                  add one by hand
//   PATCH  /questions/:id/practice/:pid             edit / { status }
//   DELETE /questions/:id/practice/:pid

import mongoose from 'mongoose';
import { TdhSet, TdhQuestion, TdhAttempt } from '../models/TdhResearch.js';
import User from '../models/User.js';
import { requireAdmin } from './progressController.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { parseQuestionsDocx, parseQuestionsJson, parseSolutionsDocx, normType } from '../utils/tdhDocx.js';
import { startPracticeJob, stopPracticeJob, getPracticeJob, practiceBatch, savePractice } from '../utils/tdhPractice.js';
import { assertAiConfigured } from '../utils/aiProvider.js';

const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const KEYS = ['a', 'b', 'c', 'd'];
const httpError = (status, message) => Object.assign(new Error(message), { status });

const fail = (res, err, label) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(`tdh ${label}:`, err);
  return res.status(500).json({ error: label });
};

const isAdminRequest = async (req) => {
  const user = await User.findById(req.userId).select('email').lean().catch(() => null);
  return !!user && isAdminEmail(user.email);
};

const aiReady = () => { try { assertAiConfigured(); return true; } catch { return false; } };

// ---------------------------------------------------------------- shapes

const shapePractice = (p) => ({
  _id: p._id, type: p.type, questionText: p.questionText, statements: p.statements,
  options: p.options, answer: p.answer, why: p.why,
});

const reveal = (q) => ({
  answer: q.answer,
  title: q.title,
  explanation: q.explanation,
  research: q.research,
  note: q.note,
  practice: (q.practice || []).filter((p) => p.status === 'approved').map(shapePractice),
});

const shapeStudent = (q, attempt) => ({
  _id: q._id,
  ref: q.ref,
  year: q.year,
  examSource: q.examSource,
  type: q.type,
  questionText: q.questionText,
  lines: q.lines,
  options: q.options,
  hasResearch: q.research.length > 0,
  // Counts only (no content) so the locked teaser can say what the TDH Research holds.
  teaser: {
    research: q.research.length,
    note: (q.note || []).length,
    practice: (q.practice || []).filter((p) => p.status === 'approved').length,
  },
  attempt: attempt ? { picked: attempt.picked, correct: attempt.correct } : null,
  ...(attempt ? { reveal: reveal(q) } : {}),
});

const shapeAdmin = (q) => ({
  _id: q._id, ref: q.ref, section: q.section, n: q.n, year: q.year, examSource: q.examSource, type: q.type,
  questionText: q.questionText, lines: q.lines, options: q.options, answer: q.answer, hidden: q.hidden,
  title: q.title, explanation: q.explanation, research: q.research, note: q.note,
  practice: q.practice, practiceAt: q.practiceAt,
});

// ---------------------------------------------------------------- student

const visibleSets = async (req) => {
  const admin = await isAdminRequest(req);
  const sets = await TdhSet.find(admin ? {} : { isPublished: true }).sort({ order: 1, createdAt: 1 }).lean();
  return { admin, sets };
};

const loadSet = async (req, id) => {
  if (!isId(id)) throw httpError(404, 'Not found');
  const { admin, sets } = await visibleSets(req);
  const set = sets.find((s) => String(s._id) === id);
  if (!set) throw httpError(404, 'Not found');
  return { admin, set };
};

// GET /
export const overview = async (req, res) => {
  try {
    const { admin, sets } = await visibleSets(req);
    const ids = sets.map((s) => s._id);
    const [counts, mine] = ids.length ? await Promise.all([
      TdhQuestion.aggregate([
        { $match: { set: { $in: ids }, hidden: false } },
        { $group: { _id: { set: '$set', section: '$section' }, n: { $sum: 1 }, conceptual: { $sum: { $cond: [{ $eq: ['$type', 'Conceptual'] }, 1, 0] } } } },
      ]),
      TdhAttempt.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.userId), set: { $in: ids } } },
        { $group: { _id: { set: '$set', section: '$section' }, done: { $sum: 1 }, correct: { $sum: { $cond: ['$correct', 1, 0] } } } },
      ]),
    ]) : [[], []];
    const find = (rows, set, section) => rows.find((r) => String(r._id.set) === String(set) && r._id.section === section);
    res.json({
      admin,
      sets: sets.map((s) => {
        const sections = s.sections.map((sec) => {
          const c = find(counts, s._id, sec.number);
          const m = find(mine, s._id, sec.number);
          return { number: sec.number, title: sec.title, total: c?.n || 0, conceptual: c?.conceptual || 0, done: m?.done || 0, correct: m?.correct || 0 };
        }).filter((x) => x.total > 0);
        const sum = (k) => sections.reduce((n, x) => n + x[k], 0);
        return {
          _id: s._id, subject: s.subject, title: s.title, isPublished: s.isPublished,
          total: sum('total'), done: sum('done'), correct: sum('correct'), sections,
        };
      }),
    });
  } catch (err) {
    fail(res, err, 'Failed to load PYQ & TDH Research');
  }
};

// GET /sets/:id/sections/:num
export const sectionQuestions = async (req, res) => {
  try {
    const { set } = await loadSet(req, req.params.id);
    const number = Number(req.params.num);
    const section = set.sections.find((s) => s.number === number);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    const questions = await TdhQuestion.find({ set: set._id, section: number, hidden: false }).sort({ n: 1 }).lean();
    const attempts = await TdhAttempt.find({ user: req.userId, question: { $in: questions.map((q) => q._id) } }).lean();
    const byQ = new Map(attempts.map((a) => [String(a.question), a]));
    res.json({
      set: { _id: set._id, subject: set.subject, title: set.title },
      section,
      sections: set.sections,
      questions: questions.map((q) => shapeStudent(q, byQ.get(String(q._id)))),
    });
  } catch (err) {
    fail(res, err, 'Failed to load the section');
  }
};

// POST /questions/:id/answer { key }
export const answer = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const q = await TdhQuestion.findById(req.params.id).lean();
    if (!q || q.hidden) return res.status(404).json({ error: 'Not found' });
    await loadSet(req, String(q.set));
    const key = KEYS.includes(req.body?.key) ? req.body.key : '';
    // The first answer counts; later taps only re-open the solution.
    let attempt = await TdhAttempt.findOne({ user: req.userId, question: q._id }).lean();
    if (!attempt) {
      attempt = await TdhAttempt.findOneAndUpdate(
        { user: req.userId, question: q._id },
        { $setOnInsert: { set: q.set, section: q.section, picked: key, correct: !!key && key === q.answer } },
        { upsert: true, new: true },
      ).lean();
    }
    res.json({ attempt: { picked: attempt.picked, correct: attempt.correct }, reveal: reveal(q) });
  } catch (err) {
    fail(res, err, 'Failed to check the answer');
  }
};

// DELETE /sets/:id/attempts?section=
export const resetAttempts = async (req, res) => {
  try {
    const { set } = await loadSet(req, req.params.id);
    const section = Number(req.query.section);
    const r = await TdhAttempt.deleteMany({ user: req.userId, set: set._id, ...(section ? { section } : {}) });
    res.json({ removed: r.deletedCount });
  } catch (err) {
    fail(res, err, 'Failed to reset');
  }
};

// ---------------------------------------------------------------- import

const readQuestionsFile = (file) => {
  if (!file) return null;
  return /\.json$/i.test(file.originalname) ? parseQuestionsJson(file.buffer) : parseQuestionsDocx(file.buffer);
};

const mergeSections = (...lists) => {
  const map = new Map();
  for (const list of lists) for (const s of list || []) if (!map.has(s.number)) map.set(s.number, { number: s.number, title: s.title });
  return [...map.values()].sort((a, b) => a.number - b.number);
};

/** Apply parsed files to a set. Updates by question number; never blanks an answer or type already set. */
const applyFiles = async (set, { questions, solutions }) => {
  const report = { questions: 0, added: 0, solutions: 0, orphanSolutions: [], warnings: [] };
  if (questions) {
    report.warnings.push(...questions.warnings);
    const ops = questions.questions.map((q) => ({
      updateOne: {
        filter: { set: set._id, ref: q.ref },
        update: {
          $set: {
            subject: set.subject, section: q.section, n: q.n, year: q.year, examSource: q.examSource,
            questionText: q.questionText, lines: q.lines, options: q.options,
            ...(q.answer ? { answer: q.answer } : {}),
            ...(q.type ? { type: q.type } : {}),
          },
          $setOnInsert: { ...(q.answer ? {} : { answer: '' }), ...(q.type ? {} : { type: '' }) },
        },
        upsert: true,
      },
    }));
    if (ops.length) {
      const r = await TdhQuestion.bulkWrite(ops);
      report.added = r.upsertedCount;
    }
    report.questions = questions.questions.length;
  }
  if (solutions) {
    const existing = new Set((await TdhQuestion.find({ set: set._id }).select('ref').lean()).map((q) => q.ref));
    const ops = [];
    for (const [ref, s] of Object.entries(solutions.solutions)) {
      if (!existing.has(ref)) { report.orphanSolutions.push(ref); continue; }
      ops.push({ updateOne: { filter: { set: set._id, ref }, update: { $set: { title: s.title, explanation: s.explanation, research: s.research, note: s.note } } } });
    }
    if (ops.length) await TdhQuestion.bulkWrite(ops);
    report.solutions = ops.length;
  }
  const sections = mergeSections(questions?.sections, set.sections, solutions?.sections);
  await TdhSet.updateOne({ _id: set._id }, {
    $set: {
      sections,
      ...(questions ? { questionsFile: questions.fileName } : {}),
      ...(solutions ? { solutionsFile: solutions.fileName } : {}),
    },
  });
  return report;
};

const parseUploads = (req) => {
  const qFile = req.files?.questions?.[0];
  const sFile = req.files?.solutions?.[0];
  const questions = readQuestionsFile(qFile);
  if (questions) questions.fileName = qFile.originalname;
  const solutions = sFile ? parseSolutionsDocx(sFile.buffer) : null;
  if (solutions) solutions.fileName = sFile.originalname;
  return { questions, solutions };
};

// ---------------------------------------------------------------- admin: sets

const setStats = async (ids) => {
  if (!ids.length) return [];
  return TdhQuestion.aggregate([
    { $match: { set: { $in: ids } } },
    {
      $group: {
        _id: '$set',
        total: { $sum: 1 },
        hidden: { $sum: { $cond: ['$hidden', 1, 0] } },
        noAnswer: { $sum: { $cond: [{ $eq: ['$answer', ''] }, 1, 0] } },
        noType: { $sum: { $cond: [{ $eq: ['$type', ''] }, 1, 0] } },
        noSolution: { $sum: { $cond: [{ $eq: [{ $size: '$explanation' }, 0] }, 1, 0] } },
        noResearch: { $sum: { $cond: [{ $eq: [{ $size: '$research' }, 0] }, 1, 0] } },
        withPractice: { $sum: { $cond: [{ $gt: [{ $size: '$practice' }, 0] }, 1, 0] } },
        drafts: { $sum: { $size: { $filter: { input: '$practice', cond: { $eq: ['$$this.status', 'draft'] } } } } },
        approved: { $sum: { $size: { $filter: { input: '$practice', cond: { $eq: ['$$this.status', 'approved'] } } } } },
      },
    },
  ]);
};

// GET /admin/sets
export const adminSets = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const sets = await TdhSet.find().sort({ order: 1, createdAt: 1 }).lean();
    const stats = await setStats(sets.map((s) => s._id));
    res.json({
      aiReady: aiReady(),
      sets: sets.map((s) => ({
        ...s,
        stats: stats.find((x) => String(x._id) === String(s._id)) || { total: 0 },
        job: getPracticeJob(s._id),
      })),
    });
  } catch (err) {
    fail(res, err, 'Failed to load sets');
  }
};

// POST /admin/sets
export const adminCreateSet = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const subject = clip(req.body?.subject, 80);
    const title = clip(req.body?.title, 160);
    if (!subject || !title) return res.status(400).json({ error: 'Subject and title are required' });
    if (!req.files?.questions?.[0]) return res.status(400).json({ error: 'Add the Questions file' });
    const parsed = parseUploads(req);
    const set = await TdhSet.create({ subject, title, order: await TdhSet.countDocuments() });
    const report = await applyFiles(set, parsed);
    res.status(201).json({ set: { _id: set._id, title: set.title }, report });
  } catch (err) {
    fail(res, err, 'Upload failed');
  }
};

// POST /admin/sets/:id/files
export const adminUploadFiles = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const set = isId(req.params.id) && await TdhSet.findById(req.params.id);
    if (!set) return res.status(404).json({ error: 'Set not found' });
    if (!req.files?.questions?.[0] && !req.files?.solutions?.[0]) return res.status(400).json({ error: 'Add a file' });
    const report = await applyFiles(set, parseUploads(req));
    res.json({ report });
  } catch (err) {
    fail(res, err, 'Upload failed');
  }
};

// PATCH /admin/sets/:id
export const adminUpdateSet = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Set not found' });
    const b = req.body || {};
    const $set = {};
    if (typeof b.title === 'string' && b.title.trim()) $set.title = clip(b.title, 160);
    if (typeof b.subject === 'string' && b.subject.trim()) $set.subject = clip(b.subject, 80);
    if (typeof b.isPublished === 'boolean') $set.isPublished = b.isPublished;
    if (Number.isFinite(b.order)) $set.order = b.order;
    const set = await TdhSet.findByIdAndUpdate(req.params.id, { $set }, { new: true }).lean();
    if (!set) return res.status(404).json({ error: 'Set not found' });
    if ($set.subject) await TdhQuestion.updateMany({ set: set._id }, { $set: { subject: $set.subject } });
    res.json({ set });
  } catch (err) {
    fail(res, err, 'Failed to update the set');
  }
};

// DELETE /admin/sets/:id
export const adminDeleteSet = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Set not found' });
    stopPracticeJob(req.params.id);
    await Promise.all([
      TdhSet.deleteOne({ _id: req.params.id }),
      TdhQuestion.deleteMany({ set: req.params.id }),
      TdhAttempt.deleteMany({ set: req.params.id }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Failed to delete the set');
  }
};

// ---------------------------------------------------------------- admin: questions

const FILTERS = {
  noanswer: { answer: '' },
  notype: { type: '' },
  nosolution: { 'explanation.0': { $exists: false } },
  nopractice: { 'practice.0': { $exists: false } },
  drafts: { practice: { $elemMatch: { status: 'draft' } } },
  hidden: { hidden: true },
};

// GET /admin/sets/:id/questions?section=&filter=
export const adminQuestions = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Set not found' });
    const section = Number(req.query.section);
    const questions = await TdhQuestion.find({
      set: req.params.id,
      ...(section ? { section } : {}),
      ...(FILTERS[req.query.filter] || {}),
    }).sort({ section: 1, n: 1 }).lean();
    res.json({ questions: questions.map(shapeAdmin) });
  } catch (err) {
    fail(res, err, 'Failed to load questions');
  }
};

const cleanOptions = (opts) => (Array.isArray(opts) ? opts : [])
  .filter((o) => KEYS.includes(o?.key))
  .map((o) => ({ key: o.key, text: clip(o.text, 1000) }));

const cleanLines = (lines) => (Array.isArray(lines) ? lines : []).map((l) => clip(l, 1000)).filter(Boolean).slice(0, 20);

// PATCH /admin/questions/:id
export const adminUpdateQuestion = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const $set = {};
    if (b.answer !== undefined) $set.answer = KEYS.includes(b.answer) ? b.answer : '';
    if (b.type !== undefined) $set.type = normType(b.type);
    if (typeof b.questionText === 'string') $set.questionText = clip(b.questionText, 3000);
    if (typeof b.title === 'string') $set.title = clip(b.title, 300);
    if (b.lines !== undefined) $set.lines = cleanLines(b.lines);
    if (b.options !== undefined) $set.options = cleanOptions(b.options);
    if (typeof b.hidden === 'boolean') $set.hidden = b.hidden;
    const q = await TdhQuestion.findByIdAndUpdate(req.params.id, { $set }, { new: true }).lean();
    if (!q) return res.status(404).json({ error: 'Not found' });
    // A changed key re-marks every attempt on it.
    if ($set.answer !== undefined) {
      await TdhAttempt.updateMany({ question: q._id }, [{ $set: { correct: { $and: [{ $ne: ['$picked', ''] }, { $eq: ['$picked', q.answer] }] } } }]);
    }
    res.json({ question: shapeAdmin(q) });
  } catch (err) {
    fail(res, err, 'Failed to update the question');
  }
};

// ---------------------------------------------------------------- admin: practice MCQs

// POST /admin/sets/:id/practice/run { limit, section, redo }
export const adminRunPractice = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Set not found' });
    const job = await startPracticeJob(req.params.id, {
      limit: Math.max(0, Math.min(1000, Number(req.body?.limit) || 0)),
      section: Number(req.body?.section) || null,
      redo: !!req.body?.redo,
    });
    res.json({ job });
  } catch (err) {
    fail(res, err.status ? err : Object.assign(err, { status: 400 }), 'Failed to start');
  }
};

// POST /admin/sets/:id/practice/stop
export const adminStopPractice = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    stopPracticeJob(req.params.id);
    res.json({ job: getPracticeJob(req.params.id) });
  } catch (err) {
    fail(res, err, 'Failed to stop');
  }
};

// POST /admin/sets/:id/practice/approve { section }
export const adminApproveAll = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Set not found' });
    const section = Number(req.body?.section);
    const r = await TdhQuestion.updateMany(
      { set: req.params.id, ...(section ? { section } : {}), 'practice.status': 'draft' },
      { $set: { 'practice.$[p].status': 'approved' } },
      { arrayFilters: [{ 'p.status': 'draft' }] },
    );
    res.json({ questions: r.modifiedCount });
  } catch (err) {
    fail(res, err, 'Failed to approve');
  }
};

const loadQuestion = async (id) => {
  if (!isId(id)) throw httpError(404, 'Not found');
  const q = await TdhQuestion.findById(id);
  if (!q) throw httpError(404, 'Not found');
  return q;
};

// POST /admin/questions/:id/practice/generate
export const adminGenerateOne = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const q = await loadQuestion(req.params.id);
    if (!q.research.length) return res.status(400).json({ error: 'This question has no TDH Research yet' });
    try { assertAiConfigured(); } catch (e) { return res.status(400).json({ error: e.message }); }
    const [r] = await practiceBatch([q.toObject()]);
    if (!r.mcqs.length) return res.status(502).json({ error: 'The AI gave no usable MCQ — try again' });
    await savePractice(q.toObject(), r.mcqs);
    res.json({ question: shapeAdmin(await TdhQuestion.findById(q._id).lean()) });
  } catch (err) {
    fail(res, err, 'Failed to write practice MCQs');
  }
};

const cleanPractice = (b, partial) => {
  const out = {};
  if (!partial || b.questionText !== undefined) out.questionText = clip(b.questionText, 2000);
  if (!partial || b.statements !== undefined) out.statements = cleanLines(b.statements);
  if (!partial || b.options !== undefined) out.options = cleanOptions(b.options);
  if (!partial || b.answer !== undefined) out.answer = KEYS.includes(b.answer) ? b.answer : '';
  if (!partial || b.why !== undefined) out.why = clip(b.why, 600);
  if (!partial || b.type !== undefined) out.type = normType(b.type) || 'Factual';
  if (b.status !== undefined) out.status = b.status === 'approved' ? 'approved' : 'draft';
  return out;
};

const practiceValid = (p) => p.questionText && p.options?.length === 4 && p.options.every((o) => o.text) && KEYS.includes(p.answer);

// POST /admin/questions/:id/practice
export const adminAddPractice = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const q = await loadQuestion(req.params.id);
    const p = cleanPractice(req.body || {}, false);
    if (!practiceValid(p)) return res.status(400).json({ error: 'Question, 4 options and the answer are needed' });
    q.practice.push({ ...p, status: p.status || 'approved', by: 'admin' });
    await q.save();
    res.status(201).json({ question: shapeAdmin(q.toObject()) });
  } catch (err) {
    fail(res, err, 'Failed to add');
  }
};

// PATCH /admin/questions/:id/practice/:pid
export const adminUpdatePractice = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const q = await loadQuestion(req.params.id);
    const p = isId(req.params.pid) && q.practice.id(req.params.pid);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const patch = cleanPractice(req.body || {}, true);
    const next = { ...p.toObject(), ...patch };
    if (!practiceValid(next)) return res.status(400).json({ error: 'Question, 4 options and the answer are needed' });
    const edited = Object.keys(patch).some((k) => k !== 'status');
    p.set({ ...patch, ...(edited ? { by: 'admin' } : {}) });
    await q.save();
    res.json({ question: shapeAdmin(q.toObject()) });
  } catch (err) {
    fail(res, err, 'Failed to update');
  }
};

// DELETE /admin/questions/:id/practice/:pid
export const adminDeletePractice = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const q = await loadQuestion(req.params.id);
    const p = isId(req.params.pid) && q.practice.id(req.params.pid);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.deleteOne();
    await q.save();
    res.json({ question: shapeAdmin(q.toObject()) });
  } catch (err) {
    fail(res, err, 'Failed to delete');
  }
};
