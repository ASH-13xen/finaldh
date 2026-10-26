// Admin portal for Question Banks: create/manage banks, bulk-import their questions from a
// PYQ JSON dump, and browse / edit / delete individual questions.
//
// A "bank" = a QuestionBank metadata doc + every QuizQuestion row sharing its `subject`.
// The student practice engine (topic / random / all modes, check-as-you-go, review) is
// quizController.js.

import mongoose from 'mongoose';
import QuestionBank from '../models/QuestionBank.js';
import QuizQuestion from '../models/QuizQuestion.js';
import QuizAttempt from '../models/QuizAttempt.js';
import User from '../models/User.js';
import { mapBank } from '../utils/bankImport.js';

const isAdminEmail = (email) =>
  [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map((e) => e.toLowerCase())
    .includes((email || '').toLowerCase());

const requireAdmin = async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Access denied: Admin only' });
    return null;
  }
  return user;
};

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const MISC_TOPIC = 'Miscellaneous';

// Rolls up QuizQuestion counts per subject in one aggregation.
async function statsBySubject(subjects) {
  const rows = await QuizQuestion.aggregate([
    { $match: { subject: { $in: subjects } } },
    {
      $group: {
        _id: '$subject',
        questionCount: { $sum: 1 },
        withExplanation: { $sum: { $cond: [{ $ne: ['$whyCorrect', ''] }, 1, 0] } },
        topics: { $addToSet: '$topic' }
      }
    }
  ]);
  const map = {};
  for (const r of rows) {
    map[r._id] = {
      questionCount: r.questionCount,
      withExplanation: r.withExplanation,
      topicCount: r.topics.length
    };
  }
  return map;
}

// GET /api/question-banks/admin/banks
export const listBanks = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const banks = await QuestionBank.find({}).sort({ order: 1, createdAt: 1 }).lean();
    const stats = await statsBySubject(banks.map((b) => b.subject));
    res.json({
      banks: banks.map((b) => ({
        ...b,
        questionCount: stats[b.subject]?.questionCount || 0,
        withExplanation: stats[b.subject]?.withExplanation || 0,
        topicCount: stats[b.subject]?.topicCount || 0
      }))
    });
  } catch (err) {
    console.error('bank listBanks error:', err);
    res.status(500).json({ error: 'Failed to load banks' });
  }
};

// POST /api/question-banks/admin/banks  { subject, title, description }
export const createBank = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const subject = (req.body?.subject || '').trim();
    const title = (req.body?.title || '').trim();
    if (!subject || !title) return res.status(400).json({ error: 'subject and title are required' });

    if (await QuestionBank.exists({ subject })) {
      return res.status(409).json({ error: `A bank with subject "${subject}" already exists` });
    }
    const count = await QuestionBank.countDocuments({});
    const bank = await QuestionBank.create({
      subject,
      title,
      description: (req.body?.description || '').trim(),
      order: count
    });
    res.status(201).json({ bank });
  } catch (err) {
    console.error('bank createBank error:', err);
    res.status(500).json({ error: 'Failed to create bank' });
  }
};

// PATCH /api/question-banks/admin/banks/:id  { title?, description?, isPublished?, order? }
export const updateBank = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Bank not found' });
    const updates = {};
    for (const f of ['title', 'description', 'isPublished', 'order']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (updates.isPublished === true) {
      const bank = await QuestionBank.findById(req.params.id);
      if (!bank) return res.status(404).json({ error: 'Bank not found' });
      const n = await QuizQuestion.countDocuments({ subject: bank.subject });
      if (n === 0) return res.status(400).json({ error: 'Add questions before publishing this bank.' });
    }
    const bank = await QuestionBank.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!bank) return res.status(404).json({ error: 'Bank not found' });
    res.json({ bank });
  } catch (err) {
    console.error('bank updateBank error:', err);
    res.status(500).json({ error: 'Failed to update bank' });
  }
};

// DELETE /api/question-banks/admin/banks/:id?deleteQuestions=true
export const deleteBank = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Bank not found' });
    const bank = await QuestionBank.findById(req.params.id);
    if (!bank) return res.status(404).json({ error: 'Bank not found' });

    let removedQuestions = 0;
    if (req.query.deleteQuestions === 'true') {
      removedQuestions = (await QuizQuestion.deleteMany({ subject: bank.subject })).deletedCount;
      await QuizAttempt.updateMany(
        { subject: bank.subject, status: 'in-progress' },
        { status: 'completed', completedAt: new Date() }
      );
    }
    await bank.deleteOne();
    res.json({ ok: true, removedQuestions });
  } catch (err) {
    console.error('bank deleteBank error:', err);
    res.status(500).json({ error: 'Failed to delete bank' });
  }
};

// POST /api/question-banks/admin/banks/:id/import   (multipart `file`, or JSON body { questions })
//   ?mode=replace|append  (default replace)
export const importQuestions = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Bank not found' });
    const bank = await QuestionBank.findById(req.params.id);
    if (!bank) return res.status(404).json({ error: 'Bank not found' });

    const mode = (req.query.mode || req.body?.mode || 'replace') === 'append' ? 'append' : 'replace';

    let rows;
    try {
      const raw = req.file ? req.file.buffer.toString('utf8') : null;
      const parsed = raw ? JSON.parse(raw) : req.body?.questions;
      rows = Array.isArray(parsed) ? parsed : parsed?.questions;
    } catch {
      return res.status(400).json({ error: 'Could not parse JSON — expected an array of question objects.' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'JSON must be a non-empty array of question objects.' });
    }

    const { docs, skipped, duplicates } = mapBank(rows);
    if (docs.length === 0) {
      return res.status(400).json({ error: 'No usable questions in this file.', skippedRows: skipped });
    }

    const baseSeq = mode === 'append'
      ? ((await QuizQuestion.findOne({ subject: bank.subject }).sort({ seq: -1 }).select('seq'))?.seq ?? -1) + 1
      : 0;

    if (mode === 'replace') {
      await QuizQuestion.deleteMany({ subject: bank.subject });
      await QuizAttempt.updateMany(
        { subject: bank.subject, status: 'in-progress' },
        { status: 'completed', completedAt: new Date() }
      );
    }

    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH).map((d, j) => ({
        ...d,
        subject: bank.subject,
        seq: baseSeq + i + j
      }));
      await QuizQuestion.insertMany(batch);
      inserted += batch.length;
    }

    const total = await QuizQuestion.countDocuments({ subject: bank.subject });
    res.json({
      message: mode === 'append'
        ? `Appended ${inserted} question(s). Bank now has ${total}.`
        : `Replaced this bank's questions with ${inserted}.`,
      mode,
      insertedCount: inserted,
      questionCount: total,
      duplicatesDropped: duplicates,
      skippedRows: skipped
    });
  } catch (err) {
    console.error('bank importQuestions error:', err);
    res.status(500).json({ error: err.message || 'Failed to import questions' });
  }
};

// GET /api/question-banks/admin/questions?subject=&topic=&q=&aiStatus=&skip=&limit=
export const listQuestions = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const subject = (req.query.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const filter = { subject };
    if (req.query.topic) filter.topic = req.query.topic;
    if (req.query.aiStatus === 'done') filter.whyCorrect = { $ne: '' };
    if (req.query.aiStatus === 'pending') filter.whyCorrect = '';
    if (req.query.q) filter.questionText = { $regex: req.query.q.trim(), $options: 'i' };

    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const [total, questions] = await Promise.all([
      QuizQuestion.countDocuments(filter),
      QuizQuestion.find(filter).sort({ seq: 1 }).skip(skip).limit(limit).lean()
    ]);

    res.json({ total, skip, limit, questions });
  } catch (err) {
    console.error('bank listQuestions error:', err);
    res.status(500).json({ error: 'Failed to load questions' });
  }
};

// PATCH /api/question-banks/admin/questions/:id
export const updateQuestion = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Question not found' });
    const q = await QuizQuestion.findById(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const b = req.body || {};
    if (b.questionText !== undefined) {
      if (!String(b.questionText).trim()) return res.status(400).json({ error: 'questionText cannot be empty' });
      q.questionText = String(b.questionText).trim();
    }
    if (b.statements !== undefined) {
      q.statements = (Array.isArray(b.statements) ? b.statements : String(b.statements).split('\n'))
        .map((s) => String(s).trim()).filter(Boolean);
    }
    if (b.options !== undefined) {
      if (!Array.isArray(b.options) || b.options.length !== 4) {
        return res.status(400).json({ error: 'options must be an array of 4' });
      }
      const opts = b.options.map((o) => ({ key: String(o.key).toUpperCase(), text: String(o.text || '').trim() }));
      if (opts.map((o) => o.key).sort().join('') !== 'ABCD' || opts.some((o) => !o.text)) {
        return res.status(400).json({ error: 'options must be A-D with non-empty text' });
      }
      q.options = opts;
    }
    if (b.correctKey !== undefined) {
      if (!['A', 'B', 'C', 'D'].includes(b.correctKey)) return res.status(400).json({ error: 'correctKey must be A-D' });
      q.correctKey = b.correctKey;
    }
    if (b.questionType !== undefined && ['conceptual', 'factual'].includes(b.questionType)) q.questionType = b.questionType;
    if (b.whyCorrect !== undefined) {
      q.whyCorrect = String(b.whyCorrect).trim();
      q.aiStatus = q.whyCorrect ? 'done' : q.aiStatus;
    }
    if (b.examSource !== undefined) q.examSource = String(b.examSource).trim();
    if (b.topic !== undefined) q.topic = String(b.topic).trim() || MISC_TOPIC;

    await q.save();
    res.json({ question: q });
  } catch (err) {
    console.error('bank updateQuestion error:', err);
    res.status(500).json({ error: 'Failed to update question' });
  }
};

// DELETE /api/question-banks/admin/questions/:id
export const deleteQuestion = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Question not found' });
    const deleted = await QuizQuestion.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Question not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('bank deleteQuestion error:', err);
    res.status(500).json({ error: 'Failed to delete question' });
  }
};

// GET /api/question-banks/admin/topics?subject=
export const listTopics = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const subject = (req.query.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject is required' });
    const agg = await QuizQuestion.aggregate([
      { $match: { subject } },
      {
        $group: {
          _id: '$topic',
          total: { $sum: 1 },
          withExplanation: { $sum: { $cond: [{ $ne: ['$whyCorrect', ''] }, 1, 0] } }
        }
      }
    ]);
    const topics = agg
      .map((t) => ({ topic: t._id || MISC_TOPIC, total: t.total, withExplanation: t.withExplanation }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
    res.json({ subject, topics });
  } catch (err) {
    console.error('bank listTopics error:', err);
    res.status(500).json({ error: 'Failed to load topics' });
  }
};

// POST /api/question-banks/admin/topics/rename  { subject, from, to }
export const renameTopic = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { subject, from, to } = req.body || {};
    if (!subject || !from || !to) return res.status(400).json({ error: 'subject, from and to are required' });
    const r = await QuizQuestion.updateMany({ subject, topic: from }, { topic: String(to).trim() });
    res.json({ ok: true, modified: r.modifiedCount });
  } catch (err) {
    console.error('bank renameTopic error:', err);
    res.status(500).json({ error: 'Failed to rename topic' });
  }
};
