import mongoose from 'mongoose';
import { parse } from 'csv-parse/sync';
import McqTest from '../models/McqTest.js';
import McqQuestion from '../models/McqQuestion.js';
import McqAttempt from '../models/McqAttempt.js';
import McqAttemptQuota from '../models/McqAttemptQuota.js';
import McqFlag from '../models/McqFlag.js';
import McqReport from '../models/McqReport.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';
import User from '../models/User.js';
import { resolveTagsCell } from '../utils/syllabusTagMatcher.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { round2 } from '../utils/mcqScoring.js';
import { correctAnswerKey } from '../utils/mcqAnswerKey.js';
import {
  userCanAccessTest,
  maxAttemptsFor,
  consumeAttempt,
  quotaInfo,
  finalizeAttempt,
  finalizeIfExpired,
  buildResponses,
  attemptPayload,
  isFinished
} from '../utils/mcqAttempts.js';

const requireAdmin = async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Access denied: Admin only' });
    return null;
  }
  return user;
};

const normalizeHeader = (key) => key.toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');

const MCQ_QUESTION_FIELD_ALIASES = {
  order: ['order', 'question number', 'q no', 'sno', 's no'],
  questionText: ['question text', 'questiontext', 'text', 'question'],
  optionA: ['option a', 'optiona', 'a'],
  optionB: ['option b', 'optionb', 'b'],
  optionC: ['option c', 'optionc', 'c'],
  optionD: ['option d', 'optiond', 'd'],
  correctOption: ['correct option', 'correctoption', 'answer', 'correct answer'],
  explanation: ['explanation', 'solution'],
  difficulty: ['difficulty', 'level'],
  marks: ['marks', 'mark'],
  tags: ['tags', 'tag'],
  examSource: ['exam source', 'examsource', 'source', 'appeared in', 'exam'],
  questionType: ['question type', 'questiontype', 'type']
};

const mapRecord = (record, fieldAliases) => {
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    const norm = normalizeHeader(key);
    for (const [canonical, aliases] of Object.entries(fieldAliases)) {
      if (aliases.includes(norm)) {
        result[canonical] = typeof value === 'string' ? value.trim() : value;
        break;
      }
    }
  }
  return result;
};

const parseCsvBuffer = (buffer) => {
  const text = buffer.toString('utf8');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
};

// Thresholds used by the analyzer (section 2 of the plan) - named constants for easy tuning.
const WEAK_THRESHOLD = 50;
const STRONG_THRESHOLD = 75;
const TOO_FAST_RATIO = 0.4;
const TOO_SLOW_RATIO = 2.0;

const OPTION_VALUES = ['A', 'B', 'C', 'D'];
const STATUS_VALUES = ['not-visited', 'not-answered', 'answered', 'marked-for-review', 'answered-marked-for-review'];
// Attempts with no `source` (created before modes existed) are all normal test attempts.
const TEST_SOURCE = { $in: ['test', null] };
const MAX_DELTA_SECONDS_PER_SAVE = 1800; // a single save can never claim more than 30 minutes on one question

const attemptLabel = (attempt, test) => {
  if (test?.title) return test.title;
  if (attempt.source === 'flagged') return 'Flagged questions practice';
  if (attempt.source === 'mistakes') return 'Mistakes practice';
  return 'Practice session';
};

// ================= Admin =================

export const createTest = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { title, subject, description, durationMinutes, marksPerQuestion, negativeMarkingRatio, instructions, requiresPurchase, price, discountedPrice, useDiscount, maxAttempts } = req.body;

  if (!title || !subject || !durationMinutes) {
    return res.status(400).json({ error: 'title, subject and durationMinutes are required' });
  }
  if (maxAttempts !== undefined && maxAttempts !== '' && !(Number.isInteger(Number(maxAttempts)) && Number(maxAttempts) >= 1 && Number(maxAttempts) <= 20)) {
    return res.status(400).json({ error: 'maxAttempts must be a whole number from 1 to 20' });
  }

  try {
    const test = await McqTest.create({
      title,
      subject,
      description: description || '',
      durationMinutes: Number(durationMinutes),
      marksPerQuestion: marksPerQuestion !== undefined && marksPerQuestion !== '' ? Number(marksPerQuestion) : 2,
      negativeMarkingRatio: negativeMarkingRatio !== undefined && negativeMarkingRatio !== '' ? Number(negativeMarkingRatio) : 0.33,
      instructions: Array.isArray(instructions) ? instructions : [],
      requiresPurchase: requiresPurchase !== undefined ? !!requiresPurchase : true,
      price: price !== undefined && price !== '' ? Number(price) : 499,
      discountedPrice: discountedPrice !== undefined && discountedPrice !== '' ? Number(discountedPrice) : 0,
      useDiscount: !!useDiscount,
      maxAttempts: maxAttempts !== undefined && maxAttempts !== '' ? Number(maxAttempts) : 2
    });
    res.json({ test });
  } catch (err) {
    console.error('Error creating MCQ test:', err);
    res.status(500).json({ error: 'Server error creating test' });
  }
};

// Recomputes questionCount/totalMarks from the ACTIVE question set - shared by the single-question
// builder endpoints and the CSV upload.
async function recomputeTestTotals(testId) {
  const test = await McqTest.findById(testId);
  if (!test) return;
  const questions = await McqQuestion.find({ test: testId, isActive: { $ne: false } }).select('marks');
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks ?? test.marksPerQuestion), 0);
  test.questionCount = questions.length;
  test.totalMarks = Math.round(totalMarks * 100) / 100;
  await test.save();
}

// Upload = the full source of truth for the test, but questions are matched by number and UPDATED IN
// PLACE. They used to be deleted and recreated, which gave every question a new id and orphaned past
// attempts, students' flags and reports. Questions missing from the CSV are removed, or retired when
// students already have attempts on them.
export const uploadQuestionsCsv = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { testId } = req.params;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'CSV file is required' });

  try {
    const test = await McqTest.findById(testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const records = parseCsvBuffer(file.buffer);
    if (records.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty or could not be parsed' });
    }

    const docs = [];
    const skippedRows = [];
    const unmatchedTagsSet = new Set();
    const seenOrders = new Set();
    const validDifficulties = ['Easy', 'Medium', 'Hard'];

    for (let i = 0; i < records.length; i++) {
      const row = mapRecord(records[i], MCQ_QUESTION_FIELD_ALIASES);
      const rowNum = i + 2;

      const orderNum = Number(row.order);
      if (!row.order || isNaN(orderNum) || orderNum <= 0) {
        skippedRows.push({ row: rowNum, reason: 'Missing or invalid order' });
        continue;
      }
      if (seenOrders.has(orderNum)) {
        skippedRows.push({ row: rowNum, reason: `Duplicate question number ${orderNum}` });
        continue;
      }
      if (!row.questionText || !row.questionText.trim()) {
        skippedRows.push({ row: rowNum, reason: 'Missing question text' });
        continue;
      }

      const optA = row.optionA?.trim();
      const optB = row.optionB?.trim();
      const optC = row.optionC?.trim();
      const optD = row.optionD?.trim();
      if (!optA || !optB || !optC || !optD) {
        skippedRows.push({ row: rowNum, reason: 'All 4 options (A-D) are required' });
        continue;
      }

      const correctOption = (row.correctOption || '').trim().toUpperCase();
      if (!OPTION_VALUES.includes(correctOption)) {
        skippedRows.push({ row: rowNum, reason: 'Correct option must be A, B, C or D' });
        continue;
      }

      const difficultyRaw = (row.difficulty || '').trim();
      const difficulty = validDifficulties.find(d => d.toLowerCase() === difficultyRaw.toLowerCase()) || 'Medium';
      const marks = row.marks && !isNaN(Number(row.marks)) ? Number(row.marks) : null;

      const { tags, rawTags } = await resolveTagsCell(test.subject, row.tags);
      tags.filter(t => !t.matched).forEach(t => unmatchedTagsSet.add(t.title));

      const questionType = ['conceptual', 'factual'].find(t => t === (row.questionType || '').trim().toLowerCase());

      seenOrders.add(orderNum);
      docs.push({
        order: orderNum,
        questionText: row.questionText.trim(),
        options: [
          { label: 'A', text: optA },
          { label: 'B', text: optB },
          { label: 'C', text: optC },
          { label: 'D', text: optD }
        ],
        correctOption,
        explanation: (row.explanation || '').trim(),
        difficulty,
        marks,
        tags,
        rawTags,
        examSource: (row.examSource || '').trim(),
        questionType
      });
    }

    const active = await McqQuestion.find({ test: test._id, isActive: { $ne: false } });
    const byOrder = new Map(active.map(q => [q.order, q]));
    let added = 0;
    let updated = 0;
    let rescoredAttempts = 0;

    for (const d of docs) {
      const existing = byOrder.get(d.order);
      if (existing) {
        existing.questionText = d.questionText;
        existing.options = d.options;
        existing.difficulty = d.difficulty;
        existing.marks = d.marks;
        existing.tags = d.tags;
        existing.rawTags = d.rawTags;
        if (d.examSource) existing.examSource = d.examSource;
        if (d.questionType) existing.questionType = d.questionType;
        // A changed answer key must also reach past attempts, so it goes through the shared helper.
        const result = await correctAnswerKey({
          question: existing,
          correctOption: d.correctOption,
          explanation: d.explanation,
          changedBy: admin._id,
          note: 'CSV re-upload'
        });
        rescoredAttempts += result.rescoredAttempts;
        updated += 1;
        byOrder.delete(d.order);
      } else {
        await McqQuestion.create({
          test: test._id,
          order: d.order,
          questionText: d.questionText,
          options: d.options,
          correctOption: d.correctOption,
          explanation: d.explanation,
          difficulty: d.difficulty,
          marks: d.marks,
          tags: d.tags,
          rawTags: d.rawTags,
          examSource: d.examSource,
          questionType: d.questionType || 'conceptual'
        });
        added += 1;
      }
    }

    // Anything left was not in the CSV.
    let removed = 0;
    let retired = 0;
    for (const leftover of byOrder.values()) {
      const inUse = await McqAttempt.exists({ 'responses.question': leftover._id });
      if (inUse) {
        leftover.isActive = false;
        await leftover.save();
        retired += 1;
      } else {
        await leftover.deleteOne();
        removed += 1;
      }
    }

    await recomputeTestTotals(test._id);
    const fresh = await McqTest.findById(test._id).select('questionCount');

    const parts = [`${updated} updated`, `${added} added`];
    if (removed) parts.push(`${removed} removed`);
    if (retired) parts.push(`${retired} retired (students already have attempts on them)`);
    res.json({
      message: `Questions synced: ${parts.join(', ')}. The test now has ${fresh.questionCount} question(s).`,
      insertedCount: fresh.questionCount,
      addedCount: added,
      updatedCount: updated,
      removedCount: removed,
      retiredCount: retired,
      rescoredAttempts,
      skippedRows,
      unmatchedTags: Array.from(unmatchedTagsSet)
    });
  } catch (err) {
    console.error('Error uploading MCQ question CSV:', err);
    res.status(500).json({ error: err.message || 'Server error processing CSV' });
  }
};

export const listTestsAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const tests = await McqTest.find({}).sort({ createdAt: -1 });
    res.json({ tests });
  } catch (err) {
    console.error('Error listing MCQ tests:', err);
    res.status(500).json({ error: 'Server error listing tests' });
  }
};

export const updateTest = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { testId } = req.params;
    const allowedFields = ['title', 'description', 'durationMinutes', 'negativeMarkingRatio', 'marksPerQuestion', 'isPublished', 'instructions', 'requiresPurchase', 'price', 'discountedPrice', 'useDiscount', 'maxAttempts'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (updates.maxAttempts !== undefined) {
      const n = Number(updates.maxAttempts);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return res.status(400).json({ error: 'maxAttempts must be a whole number from 1 to 20' });
      }
      updates.maxAttempts = n;
    }

    if (updates.isPublished === true) {
      const existing = await McqTest.findById(testId).select('questionCount');
      if (!existing) return res.status(404).json({ error: 'Test not found' });
      if (existing.questionCount === 0) {
        return res.status(400).json({ error: 'Add at least one question before publishing this test.' });
      }
    }

    const test = await McqTest.findByIdAndUpdate(testId, updates, { new: true, runValidators: true });
    if (!test) return res.status(404).json({ error: 'Test not found' });
    res.json({ test });
  } catch (err) {
    console.error('Error updating MCQ test:', err);
    res.status(500).json({ error: 'Server error updating test' });
  }
};

export const deleteTest = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { testId } = req.params;
    const hasAttempts = await McqAttempt.exists({ test: testId });
    if (hasAttempts) {
      return res.status(400).json({ error: 'Cannot delete a test with existing attempts. Unpublish it instead.' });
    }
    await McqQuestion.deleteMany({ test: testId });
    const deleted = await McqTest.findByIdAndDelete(testId);
    if (!deleted) return res.status(404).json({ error: 'Test not found' });
    res.json({ message: 'Test deleted' });
  } catch (err) {
    console.error('Error deleting MCQ test:', err);
    res.status(500).json({ error: 'Server error deleting test' });
  }
};

export const listQuestionsAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { testId } = req.params;
    // Retired questions are included (flagged isActive:false) so the admin can still see and restore them.
    const questions = await McqQuestion.find({ test: testId }).sort({ order: 1 });
    res.json({ questions });
  } catch (err) {
    console.error('Error listing MCQ questions:', err);
    res.status(500).json({ error: 'Server error listing questions' });
  }
};

const validateQuestionPayload = (body) => {
  const { questionText, options, correctOption } = body;
  if (!questionText || !questionText.trim()) return 'Question text is required';
  if (!Array.isArray(options) || options.length !== 4) return 'Exactly 4 options are required';
  const labels = options.map(o => o.label);
  if (!OPTION_VALUES.every(l => labels.includes(l))) return 'Options must be labeled A, B, C and D';
  if (options.some(o => !o.text || !o.text.trim())) return 'All 4 options must have text';
  if (!OPTION_VALUES.includes(correctOption)) return 'Correct option must be A, B, C or D';
  return null;
};

// Builder: add one question to a test at a time. Appends after the highest existing number
// (retired questions keep theirs, so "count + 1" could collide).
export const createQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { testId } = req.params;
    const test = await McqTest.findById(testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const validationError = validateQuestionPayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const { questionText, options, correctOption, explanation, difficulty, marks, tags, examSource, questionType } = req.body;
    const last = await McqQuestion.findOne({ test: testId }).sort({ order: -1 }).select('order');
    const nextOrder = (last?.order || 0) + 1;
    const { tags: resolvedTags, rawTags } = await resolveTagsCell(test.subject, tags || '');

    const question = await McqQuestion.create({
      test: testId,
      order: nextOrder,
      questionText: questionText.trim(),
      options,
      correctOption,
      explanation: (explanation || '').trim(),
      difficulty: ['Easy', 'Medium', 'Hard'].includes(difficulty) ? difficulty : 'Medium',
      marks: marks !== undefined && marks !== '' && marks !== null ? Number(marks) : null,
      tags: resolvedTags,
      rawTags,
      examSource: (examSource || '').trim(),
      questionType: ['conceptual', 'factual'].includes(questionType) ? questionType : 'conceptual'
    });

    await recomputeTestTotals(testId);
    res.json({ question });
  } catch (err) {
    console.error('Error creating MCQ question:', err);
    res.status(500).json({ error: 'Server error creating question' });
  }
};

export const updateQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { testId, questionId } = req.params;
    const question = await McqQuestion.findOne({ _id: questionId, test: testId });
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const validationError = validateQuestionPayload({
      questionText: req.body.questionText ?? question.questionText,
      options: req.body.options ?? question.options,
      correctOption: req.body.correctOption ?? question.correctOption
    });
    if (validationError) return res.status(400).json({ error: validationError });

    const plainFields = ['questionText', 'options', 'difficulty', 'marks', 'examSource', 'questionType', 'isActive'];
    for (const field of plainFields) {
      if (req.body[field] !== undefined) question[field] = req.body[field];
    }
    if (req.body.tags !== undefined) {
      const test = await McqTest.findById(testId);
      const { tags: resolvedTags, rawTags } = await resolveTagsCell(test.subject, req.body.tags);
      question.tags = resolvedTags;
      question.rawTags = rawTags;
    }

    // The answer key (and explanation) go through the shared helper: it records who changed what and, when
    // the key changed, re-scores every past attempt that contained this question. Saving the old key on
    // each attempt used to leave students seeing the wrong answer after an admin fixed it.
    const result = await correctAnswerKey({
      question,
      correctOption: req.body.correctOption,
      explanation: req.body.explanation,
      changedBy: admin._id,
      rescore: req.body.rescore !== false
    });

    await recomputeTestTotals(testId);
    res.json({ question, rescoredAttempts: result.rescoredAttempts, answerChanged: result.optionChanged });
  } catch (err) {
    console.error('Error updating MCQ question:', err);
    res.status(500).json({ error: 'Server error updating question' });
  }
};

export const deleteQuestionById = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { testId, questionId } = req.params;
    const question = await McqQuestion.findOne({ _id: questionId, test: testId });
    if (!question) return res.status(404).json({ error: 'Question not found' });

    // Students' past attempts, flags and reports point at this question, so it can only be hard-deleted
    // when nothing does. Otherwise it is retired: hidden from new attempts, kept for history.
    const inUse = await McqAttempt.exists({ 'responses.question': question._id });
    if (inUse) {
      question.isActive = false;
      await question.save();
      await recomputeTestTotals(testId);
      return res.json({ message: 'Question retired: students already have attempts on it, so it was kept for their history and will not appear in new attempts.', retired: true });
    }

    await question.deleteOne();

    // Renumber the remaining active questions sequentially so numbering stays gap-free (1..N).
    const remaining = await McqQuestion.find({ test: testId, isActive: { $ne: false } }).sort({ order: 1 });
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].order !== i + 1) {
        remaining[i].order = i + 1;
        await remaining[i].save();
      }
    }

    await recomputeTestTotals(testId);
    res.json({ message: 'Question deleted' });
  } catch (err) {
    console.error('Error deleting MCQ question:', err);
    res.status(500).json({ error: 'Server error deleting question' });
  }
};

// Support tool: how many attempts has this student used on a test, and grant more.
export const getAttemptQuotaAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'No student with that email' });

    const tests = await McqTest.find({}).select('title subject maxAttempts').sort({ subject: 1, title: 1 });
    const rows = await McqAttemptQuota.find({ user: user._id });
    const byTest = new Map(rows.map(r => [String(r.test), r]));
    res.json({
      student: { _id: user._id, name: user.fullName || user.name, email: user.email },
      tests: tests
        .map(t => {
          const q = byTest.get(String(t._id));
          const max = maxAttemptsFor(t) + (q?.extra || 0);
          return { testId: t._id, title: t.title, subject: t.subject, used: q?.used || 0, extra: q?.extra || 0, max, remaining: Math.max(0, max - (q?.used || 0)) };
        })
        .filter(t => t.used > 0 || t.extra > 0)
    });
  } catch (err) {
    console.error('Error reading attempt quota:', err);
    res.status(500).json({ error: 'Server error reading attempts' });
  }
};

export const updateAttemptQuotaAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { email, testId, action } = req.body || {};
    const user = await User.findOne({ email: String(email || '').trim().toLowerCase() });
    if (!user) return res.status(404).json({ error: 'No student with that email' });
    const test = await McqTest.findById(testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    if (action === 'grant') {
      const amount = Number(req.body.amount ?? 1);
      if (!Number.isInteger(amount) || amount < 1 || amount > 5) return res.status(400).json({ error: 'amount must be a whole number from 1 to 5' });
      await McqAttemptQuota.updateOne({ user: user._id, test: test._id }, { $inc: { extra: amount } }, { upsert: true });
    } else if (action === 'reset') {
      await McqAttemptQuota.updateOne({ user: user._id, test: test._id }, { $set: { used: 0 } }, { upsert: true });
    } else {
      return res.status(400).json({ error: "action must be 'grant' or 'reset'" });
    }
    res.json({ ok: true, attempts: await quotaInfo(user._id, test) });
  } catch (err) {
    console.error('Error updating attempt quota:', err);
    res.status(500).json({ error: 'Server error updating attempts' });
  }
};

// ================= Student =================

const REQUESTER_FIELDS = 'purchasedMcqTests purchasedMcqSubjects';

export const getSubjects = async (req, res) => {
  try {
    const results = await McqTest.aggregate([
      { $match: { isPublished: true } },
      { $group: { _id: '$subject', testCount: { $sum: 1 }, lockedCount: { $sum: { $cond: ['$requiresPurchase', 1, 0] } } } },
      { $sort: { _id: 1 } }
    ]);

    const requester = await User.findById(req.userId).select('purchasedMcqSubjects');
    const ownedSubjects = new Set(requester?.purchasedMcqSubjects || []);

    const pricingDocs = await McqSubjectPricing.find({ subject: { $in: results.map(r => r._id) } });
    const pricingBySubject = {};
    pricingDocs.forEach(p => { pricingBySubject[p.subject] = p; });

    // How many distinct tests in each subject this student has finished (drives the progress ring).
    const attemptedRows = await McqAttempt.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.userId), status: { $in: ['submitted', 'auto-submitted'] }, source: TEST_SOURCE, test: { $ne: null } } },
      { $group: { _id: { subject: '$subject', test: '$test' } } },
      { $group: { _id: '$_id.subject', testsAttempted: { $sum: 1 } } }
    ]);
    const attemptedBySubject = {};
    attemptedRows.forEach(r => { attemptedBySubject[r._id] = r.testsAttempted; });

    res.json({
      subjects: results.map(r => {
        const pricing = pricingBySubject[r._id];
        return {
          subject: r._id,
          testCount: r.testCount,
          lockedCount: r.lockedCount,
          freeCount: r.testCount - r.lockedCount,
          testsAttempted: Math.min(attemptedBySubject[r._id] || 0, r.testCount),
          isOwned: r.lockedCount === 0 || ownedSubjects.has(r._id),
          price: pricing?.price ?? null,
          discountedPrice: pricing?.discountedPrice ?? 0,
          useDiscount: pricing?.useDiscount ?? false
        };
      })
    });
  } catch (err) {
    console.error('Error listing MCQ subjects:', err);
    res.status(500).json({ error: 'Server error listing subjects' });
  }
};

// Home-screen summary: unfinished attempts to resume, lifetime stats and the flagged count.
export const getOverview = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.userId);

    const open = await McqAttempt.find({ user: userId, status: 'in-progress' }).sort({ updatedAt: -1 }).limit(12).populate('test', 'title');
    const inProgress = [];
    for (const attempt of open) {
      if (await finalizeIfExpired(attempt)) continue;
      inProgress.push({
        attemptId: attempt._id,
        title: attemptLabel(attempt, attempt.test),
        subject: attempt.subject,
        mode: attempt.mode || 'test',
        source: attempt.source || 'test',
        startedAt: attempt.startedAt,
        serverDeadline: attempt.serverDeadline || null,
        answered: attempt.responses.filter(r => r.selectedOption).length,
        total: attempt.responses.length
      });
    }

    const [stats] = await McqAttempt.aggregate([
      { $match: { user: userId, status: { $in: ['submitted', 'auto-submitted'] } } },
      { $group: { _id: null, attempts: { $sum: 1 }, avgAccuracy: { $avg: '$accuracyPercent' }, questions: { $sum: { $add: ['$totalCorrect', '$totalWrong'] } } } }
    ]);
    const flaggedCount = await McqFlag.countDocuments({ user: userId });

    res.json({
      inProgress,
      flaggedCount,
      stats: {
        attemptsTaken: stats?.attempts || 0,
        avgAccuracy: stats ? round2(stats.avgAccuracy || 0) : 0,
        questionsAnswered: stats?.questions || 0
      }
    });
  } catch (err) {
    console.error('Error building MCQ overview:', err);
    res.status(500).json({ error: 'Server error loading overview' });
  }
};

export const getTests = async (req, res) => {
  const { subject } = req.query;
  if (!subject) return res.status(400).json({ error: 'subject query param is required' });

  try {
    // Natural title order ("Mock 2" before "Mock 10", "Test 1" before "Test 2") - students expect a numbered
    // series to read in order, not newest-first.
    const tests = await McqTest.find({ subject, isPublished: true })
      .sort({ title: 1, createdAt: 1 })
      .collation({ locale: 'en', numericOrdering: true });
    const testIds = tests.map(t => t._id);

    // Finished attempts (light - no per-question data) newest first
    const finishedAttempts = await McqAttempt.find({
      user: req.userId,
      test: { $in: testIds },
      source: TEST_SOURCE,
      status: { $in: ['submitted', 'auto-submitted'] }
    }).select('-responses').sort({ submittedAt: -1 });

    const historyByTest = {};
    for (const a of finishedAttempts) {
      const key = a.test.toString();
      (historyByTest[key] = historyByTest[key] || []).push({
        attemptId: a._id,
        mode: a.mode || 'test',
        score: a.totalMarksObtained,
        totalMarks: a.totalMaxMarks || 0,
        accuracyPercent: a.accuracyPercent,
        submittedAt: a.submittedAt
      });
    }

    // Unfinished attempts: auto-submit any that ran out of time while the student was away
    const openAttempts = await McqAttempt.find({ user: req.userId, test: { $in: testIds }, source: TEST_SOURCE, status: 'in-progress' });
    const inProgressByTest = {};
    for (const a of openAttempts) {
      if (await finalizeIfExpired(a)) {
        const key = a.test.toString();
        (historyByTest[key] = historyByTest[key] || []).unshift({
          attemptId: a._id, mode: a.mode || 'test', score: a.totalMarksObtained, totalMarks: a.totalMaxMarks || 0,
          accuracyPercent: a.accuracyPercent, submittedAt: a.submittedAt
        });
        continue;
      }
      inProgressByTest[a.test.toString()] = {
        attemptId: a._id,
        mode: a.mode || 'test',
        startedAt: a.startedAt,
        serverDeadline: a.serverDeadline || null,
        answered: a.responses.filter(r => r.selectedOption).length,
        total: a.responses.length
      };
    }

    const quotaRows = await McqAttemptQuota.find({ user: req.userId, test: { $in: testIds } });
    const quotaByTest = {};
    quotaRows.forEach(q => { quotaByTest[q.test.toString()] = q; });

    const requester = await User.findById(req.userId).select(REQUESTER_FIELDS);
    const subjectOwned = (requester?.purchasedMcqSubjects || []).includes(subject);
    const pricing = await McqSubjectPricing.findOne({ subject });

    res.json({
      tests: tests.map(t => {
        const key = t._id.toString();
        const history = historyByTest[key] || [];
        const q = quotaByTest[key];
        const max = maxAttemptsFor(t) + (q?.extra || 0);
        const used = q?.used || 0;
        return {
          _id: t._id,
          title: t.title,
          description: t.description,
          durationMinutes: t.durationMinutes,
          totalMarks: t.totalMarks,
          questionCount: t.questionCount,
          negativeMarkingRatio: t.negativeMarkingRatio,
          instructions: t.instructions,
          requiresPurchase: t.requiresPurchase,
          price: t.price,
          discountedPrice: t.discountedPrice,
          useDiscount: t.useDiscount,
          isOwned: userCanAccessTest(requester, t) || subjectOwned,
          attempts: { max, used, remaining: Math.max(0, max - used) },
          inProgress: inProgressByTest[key] || null,
          lastAttempt: history[0] || null,
          history: history.slice(0, 5)
        };
      }),
      subjectAccess: {
        subject,
        isOwned: subjectOwned,
        hasLockedTests: tests.some(t => t.requiresPurchase),
        price: pricing?.price ?? null,
        discountedPrice: pricing?.discountedPrice ?? 0,
        useDiscount: pricing?.useDiscount ?? false
      }
    });
  } catch (err) {
    console.error('Error listing MCQ tests:', err);
    res.status(500).json({ error: 'Server error listing tests' });
  }
};

// Starts (or resumes) a test attempt in 'test' or 'practice' mode.
// Every NEW attempt uses up one of the student's attempts for this test, Test and Practice combined;
// resuming an unfinished attempt does not.
export const startTest = async (req, res) => {
  const { testId } = req.params;
  const mode = req.body?.mode === 'practice' ? 'practice' : 'test';
  const timerEnabled = req.body?.timerEnabled !== false;

  try {
    const test = await McqTest.findById(testId);
    if (!test || !test.isPublished) return res.status(404).json({ error: 'Test not found' });

    const requester = await User.findById(req.userId).select(REQUESTER_FIELDS);
    if (!userCanAccessTest(requester, test)) {
      return res.status(403).json({ error: 'This test requires purchase. Please buy the subject first.' });
    }

    const resumePayload = async (attempt) =>
      attemptPayload(attempt, { testTitle: test.title, resumed: true, attempts: await quotaInfo(req.userId, test) });

    // Idempotent: resume an existing unfinished attempt rather than creating a duplicate.
    let attempt = await McqAttempt.findOne({ user: req.userId, test: testId, source: TEST_SOURCE, status: 'in-progress' });
    if (attempt) {
      if (await finalizeIfExpired(attempt)) attempt = null;
      else return res.json(await resumePayload(attempt));
    }

    const questions = await McqQuestion.find({ test: testId, isActive: { $ne: false } }).sort({ order: 1 });
    if (questions.length === 0) return res.status(400).json({ error: 'This test has no questions yet' });

    // Already out of attempts? (A plain read is enough here: an exhausted student stays exhausted.)
    const limitReached = async () => {
      const info = await quotaInfo(req.userId, test);
      return res.status(403).json({
        error: `You have used all ${info.max} attempts for this test. You can still review your answers any time.`,
        code: 'ATTEMPT_LIMIT',
        attempts: info
      });
    };
    if ((await quotaInfo(req.userId, test)).remaining <= 0) return limitReached();

    const startedAt = new Date();
    const doc = {
      user: req.userId,
      test: test._id,
      subject: test.subject,
      mode,
      source: 'test',
      timerEnabled: mode === 'practice' ? timerEnabled : true,
      startedAt,
      durationMinutes: test.durationMinutes,
      responses: buildResponses(questions, new Map([[String(test._id), test]])),
      lastActiveQuestionOrder: 1
    };
    if (mode === 'test') doc.serverDeadline = new Date(startedAt.getTime() + test.durationMinutes * 60 * 1000);

    // Take the "one unfinished attempt per student per test" lock FIRST, by inserting the attempt. When a
    // double-click or a second tab fires several starts at once, the unique index lets exactly one insert
    // through; the others resume that attempt and never touch the quota, so they can't see a bogus
    // "limit reached" and can't use up extra slots.
    try {
      attempt = await McqAttempt.create(doc);
    } catch (err) {
      if (err.code === 11000) {
        const winner = await McqAttempt.findOne({ user: req.userId, test: testId, source: TEST_SOURCE, status: 'in-progress' });
        if (winner) return res.json(await resumePayload(winner));
      }
      throw err;
    }

    // Only the winner uses up an attempt. The increment is a single conditional update (see
    // consumeAttempt), so it holds even against races the unique index can't see.
    const quota = await consumeAttempt(req.userId, test._id, maxAttemptsFor(test));
    if (!quota) {
      await McqAttempt.deleteOne({ _id: attempt._id });
      return limitReached();
    }

    res.json(await attemptPayload(attempt, { testTitle: test.title, attempts: await quotaInfo(req.userId, test) }));
  } catch (err) {
    console.error('Error starting MCQ test:', err);
    res.status(500).json({ error: 'Server error starting test' });
  }
};

// Practice sessions built from questions spread across tests (the student's flagged questions, or the
// questions they got wrong in an attempt). They are always practice mode, never use up an attempt and
// are never ranked.
async function startCrossTestPractice(req, res, { source, questionIds, subject, sourceAttempt }) {
  const timerEnabled = req.body?.timerEnabled !== false;
  const questions = await McqQuestion.find({ _id: { $in: questionIds }, isActive: { $ne: false } });
  const tests = await McqTest.find({ _id: { $in: [...new Set(questions.map(q => String(q.test)))] }, isPublished: true });
  const testsById = new Map(tests.map(t => [String(t._id), t]));
  const requester = await User.findById(req.userId).select(REQUESTER_FIELDS);

  const rank = new Map(questionIds.map((id, i) => [String(id), i]));
  const usable = questions
    .filter(q => { const t = testsById.get(String(q.test)); return t && userCanAccessTest(requester, t); })
    .sort((a, b) => rank.get(String(a._id)) - rank.get(String(b._id)));

  if (usable.length === 0) return res.status(400).json({ error: 'None of those questions are available to you right now.' });

  const attempt = await McqAttempt.create({
    user: req.userId,
    subject,
    mode: 'practice',
    source,
    sourceAttempt,
    timerEnabled,
    startedAt: new Date(),
    durationMinutes: Math.max(1, Math.ceil(usable.length * 1.2)),
    responses: buildResponses(usable, testsById),
    lastActiveQuestionOrder: 1
  });

  res.json(await attemptPayload(attempt, {
    testTitle: attemptLabel(attempt, null),
    skippedUnavailable: questionIds.length - usable.length
  }));
}

export const startFlaggedPractice = async (req, res) => {
  try {
    const subject = req.body?.subject || '';
    const flags = await McqFlag.find({ user: req.userId, ...(subject ? { subject } : {}) }).sort({ createdAt: -1 }).limit(100);
    if (flags.length === 0) return res.status(400).json({ error: 'You have not flagged any questions yet.' });
    await startCrossTestPractice(req, res, { source: 'flagged', questionIds: flags.map(f => f.question), subject: subject || 'Mixed' });
  } catch (err) {
    console.error('Error starting flagged practice:', err);
    res.status(500).json({ error: 'Server error starting flagged practice' });
  }
};

export const startMistakesPractice = async (req, res) => {
  try {
    const source = await McqAttempt.findById(req.body?.attemptId);
    if (!source) return res.status(404).json({ error: 'Attempt not found' });
    if (source.user.toString() !== req.userId) return res.status(403).json({ error: 'Access denied' });
    if (!isFinished(source.status)) return res.status(400).json({ error: 'Finish the attempt first.' });

    const wrongIds = source.responses.filter(r => r.isCorrect === false).map(r => r.question);
    if (wrongIds.length === 0) return res.status(400).json({ error: 'You got nothing wrong in this attempt - nothing to practice.' });
    await startCrossTestPractice(req, res, { source: 'mistakes', questionIds: wrongIds, subject: source.subject, sourceAttempt: source._id });
  } catch (err) {
    console.error('Error starting mistakes practice:', err);
    res.status(500).json({ error: 'Server error starting mistakes practice' });
  }
};

const loadOwnAttempt = async (req, res) => {
  const attempt = await McqAttempt.findById(req.params.attemptId);
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return null; }
  if (attempt.user.toString() !== req.userId) { res.status(403).json({ error: 'Access denied' }); return null; }
  return attempt;
};

export const getAttempt = async (req, res) => {
  try {
    const attempt = await loadOwnAttempt(req, res);
    if (!attempt) return;

    if (await finalizeIfExpired(attempt)) {
      return res.json({ deadlineExpired: true, attemptId: attempt._id });
    }
    if (attempt.status !== 'in-progress') {
      return res.json({ deadlineExpired: false, status: attempt.status, attemptId: attempt._id });
    }

    const test = attempt.test ? await McqTest.findById(attempt.test).select('title maxAttempts') : null;
    res.json(await attemptPayload(attempt, {
      testTitle: attemptLabel(attempt, test),
      ...(test ? { attempts: await quotaInfo(req.userId, test) } : {})
    }));
  } catch (err) {
    console.error('Error fetching MCQ attempt:', err);
    res.status(500).json({ error: 'Server error fetching attempt' });
  }
};

// Applies a mutation to one response and saves, retrying if a concurrent autosave got there first.
async function mutateResponse(req, res, mutate) {
  for (let tryNo = 0; tryNo < 4; tryNo++) {
    const attempt = await loadOwnAttempt(req, res);
    if (!attempt) return null;

    if (attempt.status !== 'in-progress') {
      res.status(409).json({ error: 'This attempt is no longer in progress' });
      return null;
    }
    if (await finalizeIfExpired(attempt)) {
      res.json({ ok: true, deadlineExpired: true, attemptId: attempt._id });
      return null;
    }

    const orderNum = Number(req.params.order);
    const response = attempt.responses.find(r => r.order === orderNum);
    if (!response) {
      res.status(404).json({ error: 'Question not found in this attempt' });
      return null;
    }

    const outcome = await mutate(attempt, response, orderNum);
    if (outcome === false) return null; // mutate already responded

    try {
      await attempt.save();
      return { attempt, response, outcome };
    } catch (err) {
      if (err instanceof mongoose.Error.VersionError && tryNo < 3) continue; // concurrent autosave - reload and retry
      throw err;
    }
  }
  return null;
}

const applyTimeDelta = (response, delta) => {
  const d = Number(delta);
  if (Number.isFinite(d) && d > 0) response.timeSpentSeconds += Math.min(d, MAX_DELTA_SECONDS_PER_SAVE);
};

export const saveResponse = async (req, res) => {
  const { selectedOption, status, deltaTimeSpentSeconds, isVisit, confidenceTag } = req.body;

  // Reject junk with a 400 instead of letting the schema validator turn it into a 500.
  if (selectedOption !== undefined && selectedOption !== null && !OPTION_VALUES.includes(selectedOption)) {
    return res.status(400).json({ error: 'selectedOption must be A, B, C, D or null' });
  }
  if (status !== undefined && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const result = await mutateResponse(req, res, (attempt, response, orderNum) => {
      let locked = false;
      if (selectedOption !== undefined) {
        if (response.revealed) {
          locked = true; // the student already saw the answer in practice mode
        } else {
          if (response.selectedOption !== null && selectedOption !== response.selectedOption) {
            response.answerChangedCount += 1;
          }
          response.selectedOption = selectedOption;
        }
      }
      if (status !== undefined) response.status = status;
      if (confidenceTag !== undefined && (confidenceTag === null || ['sure', 'elimination', 'guess'].includes(confidenceTag))) {
        response.confidenceTag = confidenceTag;
      }
      applyTimeDelta(response, deltaTimeSpentSeconds);
      if (isVisit) {
        response.visitCount += 1;
        if (!response.firstVisitedAt) response.firstVisitedAt = new Date();
        response.lastVisitedAt = new Date();
        if (response.status === 'not-visited') response.status = 'not-answered';
      }
      attempt.lastActiveQuestionOrder = orderNum;
      return { locked };
    });
    if (result) res.json({ ok: true, ...(result.outcome.locked ? { locked: true } : {}) });
  } catch (err) {
    console.error('Error saving MCQ response:', err);
    res.status(500).json({ error: 'Server error saving response' });
  }
};

// Practice mode only: "Check answer". Reveals the key + explanation for ONE question and locks it.
// Test-mode attempts can never reach this - the key stays server-side until the attempt is submitted.
export const revealAnswer = async (req, res) => {
  const { selectedOption, deltaTimeSpentSeconds } = req.body || {};
  if (selectedOption !== undefined && selectedOption !== null && !OPTION_VALUES.includes(selectedOption)) {
    return res.status(400).json({ error: 'selectedOption must be A, B, C, D or null' });
  }

  try {
    let denied = false;
    const result = await mutateResponse(req, res, (attempt, response) => {
      if (attempt.mode !== 'practice') {
        denied = true;
        res.status(403).json({ error: 'Answers stay hidden in Test mode until you submit.' });
        return false;
      }
      if (!response.revealed) {
        if (selectedOption !== undefined && selectedOption !== response.selectedOption) {
          if (response.selectedOption !== null) response.answerChangedCount += 1;
          response.selectedOption = selectedOption;
        }
        applyTimeDelta(response, deltaTimeSpentSeconds);
        if (response.selectedOption) {
          const wasMarked = response.status === 'marked-for-review' || response.status === 'answered-marked-for-review';
          response.status = wasMarked ? 'answered-marked-for-review' : 'answered';
        }
        response.revealed = true;
      }
      return true;
    });
    if (!result || denied) return;

    const { response } = result;
    const question = await McqQuestion.findById(response.question).select('explanation examSource');
    res.json({
      correctOption: response.correctOption,
      selectedOption: response.selectedOption,
      isCorrect: response.selectedOption ? response.selectedOption === response.correctOption : null,
      explanation: question?.explanation || '',
      examSource: question?.examSource || '',
      tags: response.tags
    });
  } catch (err) {
    console.error('Error revealing MCQ answer:', err);
    res.status(500).json({ error: 'Server error revealing answer' });
  }
};

// Practice mode: turn the on-screen stopwatch on/off.
export const updateAttemptSettings = async (req, res) => {
  try {
    const attempt = await loadOwnAttempt(req, res);
    if (!attempt) return;
    if (attempt.status !== 'in-progress') return res.status(409).json({ error: 'This attempt is no longer in progress' });
    if (attempt.mode !== 'practice') return res.status(400).json({ error: 'The timer can only be switched off in Practice mode.' });
    if (typeof req.body?.timerEnabled === 'boolean') {
      await McqAttempt.updateOne({ _id: attempt._id }, { $set: { timerEnabled: req.body.timerEnabled } });
    }
    res.json({ ok: true, timerEnabled: typeof req.body?.timerEnabled === 'boolean' ? req.body.timerEnabled : attempt.timerEnabled });
  } catch (err) {
    console.error('Error updating attempt settings:', err);
    res.status(500).json({ error: 'Server error updating settings' });
  }
};

export const submitAttempt = async (req, res) => {
  const { autoSubmit } = req.body;

  try {
    const attempt = await loadOwnAttempt(req, res);
    if (!attempt) return;

    if (attempt.status !== 'in-progress') {
      return res.json({ attemptId: attempt._id, redirectToResult: true });
    }

    await finalizeAttempt(attempt, !!autoSubmit && attempt.mode !== 'practice');
    res.json({ attemptId: attempt._id, redirectToResult: true });
  } catch (err) {
    console.error('Error submitting MCQ attempt:', err);
    res.status(500).json({ error: 'Server error submitting attempt' });
  }
};

export const getAttemptResult = async (req, res) => {
  const { attemptId } = req.params;

  try {
    const attempt = await McqAttempt.findById(attemptId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt.user.toString() !== req.userId) return res.status(403).json({ error: 'Access denied' });
    if (attempt.status === 'in-progress') return res.status(400).json({ error: 'Attempt has not been submitted yet' });

    // Look questions up by the ids stored on the attempt (not "everything currently in the test"), so
    // retired/deleted questions and cross-test practice sessions all resolve correctly.
    const test = attempt.test ? await McqTest.findById(attempt.test) : null;
    const questions = await McqQuestion.find({ _id: { $in: attempt.responses.map(r => r.question) } });
    const isRanked = !!attempt.test && attempt.mode !== 'practice' && (attempt.source || 'test') === 'test';
    const flagRows = await McqFlag.find({ user: attempt.user, question: { $in: questions.map(q => q._id) } }).select('question');
    const flaggedIds = new Set(flagRows.map(f => String(f.question)));
    const openReports = await McqReport.find({ reporter: attempt.user, status: 'pending', question: { $in: questions.map(q => q._id) } }).select('question');
    const reportedIds = new Set(openReports.map(r => String(r.question)));
    const questionById = {};
    questions.forEach(q => { questionById[q._id.toString()] = q; });

    const responses = attempt.responses;
    const questionCount = responses.length;
    const idealTimePerQuestion = questionCount > 0 ? (attempt.durationMinutes * 60) / questionCount : 0;

    // --- Summary ---
    const summary = {
      totalMarksObtained: attempt.totalMarksObtained,
      totalMarks: attempt.totalMaxMarks || round2(responses.reduce((s, r) => s + r.maxMarks, 0)),
      accuracyPercent: attempt.accuracyPercent,
      totalCorrect: attempt.totalCorrect,
      totalWrong: attempt.totalWrong,
      totalUnattempted: attempt.totalUnattempted,
      totalMarked: attempt.totalMarked,
      totalTimeSpentSeconds: attempt.totalTimeSpentSeconds,
      durationMinutes: attempt.durationMinutes
    };

    // --- Topic-wise breakdown ---
    const topicMap = {};
    for (const r of responses) {
      const sections = r.tags.length > 0 ? r.tags.map(t => t.section) : ['Untagged'];
      const uniqueSections = Array.from(new Set(sections));
      for (const section of uniqueSections) {
        if (!topicMap[section]) topicMap[section] = { topic: section, correct: 0, wrong: 0, unattempted: 0, totalTime: 0 };
        if (r.selectedOption === null) topicMap[section].unattempted += 1;
        else if (r.isCorrect) topicMap[section].correct += 1;
        else topicMap[section].wrong += 1;
        topicMap[section].totalTime += r.timeSpentSeconds;
      }
    }
    const topicBreakdown = Object.values(topicMap).map(t => {
      const attempted = t.correct + t.wrong;
      const accuracy = attempted > 0 ? Math.round((t.correct / attempted) * 10000) / 100 : null;
      let bucket;
      if (attempted === 0) bucket = 'Not Attempted';
      else if (accuracy < WEAK_THRESHOLD) bucket = 'Weak';
      else if (accuracy < STRONG_THRESHOLD) bucket = 'Average';
      else bucket = 'Strong';
      const totalQuestionsInTopic = attempted + t.unattempted;
      return {
        topic: t.topic,
        accuracy,
        attempted,
        correct: t.correct,
        wrong: t.wrong,
        unattempted: t.unattempted,
        avgTimeSpent: totalQuestionsInTopic > 0 ? Math.round(t.totalTime / totalQuestionsInTopic) : 0,
        bucket
      };
    }).sort((a, b) => (a.accuracy ?? -1) - (b.accuracy ?? -1));

    const weakTopics = topicBreakdown.filter(t => t.bucket === 'Weak').map(t => t.topic);

    // --- Topic x Confidence cross-tab (feeds personalizedInsights below) ---
    const topicConfidenceMap = {};
    for (const r of responses) {
      if (!r.confidenceTag || r.selectedOption === null) continue;
      const sections = r.tags.length > 0 ? r.tags.map(t => t.section) : ['Untagged'];
      const uniqueSections = Array.from(new Set(sections));
      for (const section of uniqueSections) {
        if (!topicConfidenceMap[section]) topicConfidenceMap[section] = {};
        if (!topicConfidenceMap[section][r.confidenceTag]) {
          topicConfidenceMap[section][r.confidenceTag] = { total: 0, correct: 0, totalTime: 0 };
        }
        const bucket = topicConfidenceMap[section][r.confidenceTag];
        bucket.total += 1;
        if (r.isCorrect) bucket.correct += 1;
        bucket.totalTime += r.timeSpentSeconds;
      }
    }

    // --- Difficulty-wise breakdown ---
    const difficultyMap = {
      Easy: { correct: 0, wrong: 0, unattempted: 0 },
      Medium: { correct: 0, wrong: 0, unattempted: 0 },
      Hard: { correct: 0, wrong: 0, unattempted: 0 }
    };
    for (const r of responses) {
      const d = difficultyMap[r.difficulty] ? r.difficulty : 'Medium';
      if (r.selectedOption === null) difficultyMap[d].unattempted += 1;
      else if (r.isCorrect) difficultyMap[d].correct += 1;
      else difficultyMap[d].wrong += 1;
    }
    const difficultyBreakdown = Object.entries(difficultyMap).map(([difficulty, d]) => {
      const attempted = d.correct + d.wrong;
      return {
        difficulty,
        accuracy: attempted > 0 ? Math.round((d.correct / attempted) * 10000) / 100 : 0,
        attempted,
        ...d
      };
    });

    // --- Question type breakdown (conceptual vs factual mastery) ---
    const questionTypeMap = {
      conceptual: { correct: 0, wrong: 0, unattempted: 0 },
      factual: { correct: 0, wrong: 0, unattempted: 0 }
    };
    for (const r of responses) {
      const q = questionById[r.question.toString()];
      const qt = q?.questionType;
      if (qt !== 'conceptual' && qt !== 'factual') continue;
      if (r.selectedOption === null) questionTypeMap[qt].unattempted += 1;
      else if (r.isCorrect) questionTypeMap[qt].correct += 1;
      else questionTypeMap[qt].wrong += 1;
    }
    // Buckets with zero questions of that type in the test are dropped rather than shown as an
    // empty "0/0" card - most existing tests are 100% conceptual, so factual won't appear for them.
    const questionTypeBreakdown = Object.entries(questionTypeMap).map(([questionType, d]) => {
      const attempted = d.correct + d.wrong;
      return {
        questionType,
        accuracy: attempted > 0 ? Math.round((d.correct / attempted) * 10000) / 100 : null,
        attempted,
        ...d
      };
    }).filter(d => d.attempted + d.unattempted > 0);

    // --- Time management ---
    const timeAnalysisPerQuestion = responses.map(r => ({
      order: r.order,
      timeSpentSeconds: r.timeSpentSeconds,
      isCorrect: r.isCorrect,
      tooFast: r.selectedOption !== null && r.isCorrect === false && r.timeSpentSeconds < TOO_FAST_RATIO * idealTimePerQuestion,
      tooSlow: r.timeSpentSeconds > TOO_SLOW_RATIO * idealTimePerQuestion
    }));
    const rushedWrongQuestions = timeAnalysisPerQuestion.filter(t => t.tooFast).map(t => t.order);
    const timeSinkQuestions = timeAnalysisPerQuestion.filter(t => t.tooSlow).map(t => t.order);

    // --- Time-slot / fatigue breakdown ---
    // Buckets each visited question by when in the exam window it was first opened (firstVisitedAt
    // relative to startedAt), not by question order, so palette-jumping students still get an
    // accurate early-vs-late-in-the-exam read.
    const totalDurationSeconds = attempt.durationMinutes * 60;
    const SLOT_LABELS = ['Q1 (0-25%)', 'Q2 (25-50%)', 'Q3 (50-75%)', 'Q4 (75-100%)'];
    const slotBuckets = SLOT_LABELS.map(label => ({ slot: label, correct: 0, wrong: 0, unattempted: 0, totalTime: 0, visited: 0 }));
    // Quarter-of-the-exam analysis only makes sense for a timed test, not untimed practice.
    if (totalDurationSeconds > 0 && attempt.mode !== 'practice') {
      for (const r of responses) {
        if (!r.firstVisitedAt) continue;
        const elapsedSeconds = (new Date(r.firstVisitedAt).getTime() - new Date(attempt.startedAt).getTime()) / 1000;
        const clamped = Math.max(0, Math.min(totalDurationSeconds - 0.001, elapsedSeconds));
        const slotIdx = Math.min(SLOT_LABELS.length - 1, Math.floor((clamped / totalDurationSeconds) * SLOT_LABELS.length));
        const bucket = slotBuckets[slotIdx];
        bucket.visited += 1;
        bucket.totalTime += r.timeSpentSeconds;
        if (r.selectedOption === null) bucket.unattempted += 1;
        else if (r.isCorrect) bucket.correct += 1;
        else bucket.wrong += 1;
      }
    }
    const timeSlotBreakdown = slotBuckets.map(s => {
      const attempted = s.correct + s.wrong;
      return {
        slot: s.slot,
        accuracy: attempted > 0 ? Math.round((s.correct / attempted) * 10000) / 100 : null,
        attempted,
        correct: s.correct,
        wrong: s.wrong,
        unattempted: s.unattempted,
        avgTimeSpent: s.visited > 0 ? Math.round(s.totalTime / s.visited) : 0
      };
    });

    // --- Speed vs accuracy quadrant (per topic) ---
    const topicsWithData = topicBreakdown.filter(t => t.attempted > 0);
    const sortedTimes = topicsWithData.map(t => t.avgTimeSpent).sort((a, b) => a - b);
    const medianTime = sortedTimes.length > 0 ? sortedTimes[Math.floor(sortedTimes.length / 2)] : 0;
    const quadrantAnalysis = topicsWithData.map(t => {
      const fast = t.avgTimeSpent <= medianTime;
      const highAccuracy = t.accuracy >= WEAK_THRESHOLD;
      let bucket;
      if (fast && highAccuracy) bucket = 'Mastered';
      else if (!fast && highAccuracy) bucket = 'Needs Speed Practice';
      else if (fast && !highAccuracy) bucket = 'Careless Mistakes';
      else bucket = 'Needs Concept Clarity';
      return { topic: t.topic, avgTimeSpent: t.avgTimeSpent, accuracy: t.accuracy, attempted: t.attempted, bucket };
    });

    // --- Negative marking impact ---
    const wrongResponses = responses.filter(r => r.selectedOption !== null && r.isCorrect === false);
    const marksLostToNegativeMarking = Math.round(wrongResponses.reduce((sum, r) => sum + r.negativeMarks, 0) * 100) / 100;
    const scoreIfWrongWereSkipped = Math.round((attempt.totalMarksObtained + marksLostToNegativeMarking) * 100) / 100;
    const unattemptedResponses = responses.filter(r => r.selectedOption === null);
    const avgMaxMarks = responses.length > 0 ? responses.reduce((s, r) => s + r.maxMarks, 0) / responses.length : 0;
    const avgNegMarks = responses.length > 0 ? responses.reduce((s, r) => s + r.negativeMarks, 0) / responses.length : 0;
    const expectedIfGuessedRandomly = Math.round((
      attempt.totalMarksObtained
      + (unattemptedResponses.length * avgMaxMarks * 0.25)
      - (unattemptedResponses.length * 0.75 * avgNegMarks)
    ) * 100) / 100;
    const negativeMarkingImpact = {
      actualScore: attempt.totalMarksObtained,
      marksLostToNegativeMarking,
      scoreIfWrongWereSkipped,
      expectedIfUnattemptedWereGuessedRandomly: expectedIfGuessedRandomly,
      totalWrong: attempt.totalWrong,
      totalUnattempted: attempt.totalUnattempted
    };

    // --- Question-by-question review ---
    const questionReview = responses.map(r => {
      const q = questionById[r.question.toString()];
      return {
        order: r.order,
        questionId: r.question,
        // Live text wins (so a corrected typo shows up in old results); the attempt's own snapshot
        // covers questions that have since been deleted.
        questionText: q?.questionText ?? r.questionText ?? '(question no longer available)',
        options: q?.options?.length ? q.options : (r.options ?? []),
        selectedOption: r.selectedOption,
        correctOption: r.correctOption,
        isCorrect: r.isCorrect,
        explanation: q?.explanation ?? '',
        difficulty: r.difficulty,
        tags: r.tags,
        examSource: q?.examSource ?? '',
        questionType: q?.questionType ?? '',
        timeSpentSeconds: r.timeSpentSeconds,
        status: r.status,
        marksAwarded: r.marksAwarded,
        answerChangedCount: r.answerChangedCount,
        flagged: flaggedIds.has(String(r.question)),
        reported: reportedIds.has(String(r.question))
      };
    });

    // --- Bonus insights ---
    const markedResponses = responses.filter(r => r.status === 'marked-for-review' || r.status === 'answered-marked-for-review');
    const markedFollowThrough = {
      totalMarked: markedResponses.length,
      changedBeforeSubmit: markedResponses.filter(r => r.answerChangedCount > 0).length,
      leftAsIsCorrectCount: markedResponses.filter(r => r.answerChangedCount === 0 && r.isCorrect === true).length
    };
    const indecisiveQuestions = responses.filter(r => r.answerChangedCount >= 2 && r.isCorrect === false).map(r => r.order);

    // --- Confidence breakdown ("Decision Confidence") ---
    const confidenceStats = {
      sure: { total: 0, correct: 0 },
      elimination: { total: 0, correct: 0 },
      guess: { total: 0, correct: 0 }
    };
    for (const r of responses) {
      if (r.confidenceTag && confidenceStats[r.confidenceTag]) {
        confidenceStats[r.confidenceTag].total += 1;
        if (r.isCorrect) confidenceStats[r.confidenceTag].correct += 1;
      }
    }

    // --- Confidence impact vs random guessing ---
    // A marks-based "boost", not just an accuracy delta: for each tag, actual marks earned vs
    // what pure random guessing (25% chance, same negative marking) would have scored on the
    // same set of questions. Only counts attempted responses - an unattempted question tagged
    // with a stale confidenceTag (e.g. answered then cleared) contributes nothing either way.
    const confidenceImpact = {};
    for (const tag of ['sure', 'elimination', 'guess']) {
      const tagged = responses.filter(r => r.confidenceTag === tag && r.selectedOption !== null);
      const actualMarks = tagged.reduce((s, r) => s + r.marksAwarded, 0);
      const expectedRandomMarks = tagged.reduce((s, r) => s + (0.25 * r.maxMarks - 0.75 * r.negativeMarks), 0);
      confidenceImpact[tag] = {
        count: tagged.length,
        actualMarks: Math.round(actualMarks * 100) / 100,
        expectedRandomMarks: Math.round(expectedRandomMarks * 100) / 100,
        marksGainedVsRandomGuessing: Math.round((actualMarks - expectedRandomMarks) * 100) / 100
      };
    }

    // --- Decision Intelligence Index ---
    // 1:1 port of the_dark_horse's formula (base 70, penalize overconfidence and easy-question
    // slips, reward correct eliminations and correct hard-question attempts), clamped 0-100.
    let diiScore = 70;
    const overconfidencePenalty = confidenceStats.sure.total - confidenceStats.sure.correct;
    diiScore -= overconfidencePenalty * 3;
    diiScore += confidenceStats.elimination.correct * 2;
    diiScore += difficultyMap.Hard.correct * 3;
    diiScore -= difficultyMap.Easy.wrong * 2;
    diiScore = Math.max(0, Math.min(100, Math.round(diiScore)));

    let diiInsight;
    if (diiScore >= 80) diiInsight = 'Your decision-making approach is strategically sound. You are able to balance risk and accuracy effectively, especially under uncertain conditions.';
    else if (diiScore >= 60) diiInsight = 'Your overall judgement is stable, but there are areas where better risk assessment can improve outcomes. Focus on refining elimination and avoiding avoidable errors.';
    else if (diiScore >= 40) diiInsight = 'Your attempt strategy shows inconsistency. Work on reducing overconfidence and improving selective attempts, particularly in easier questions.';
    else diiInsight = 'Your current decision pattern indicates high risk exposure. Strengthen question selection strategy and avoid impulsive attempts.';

    // --- Narrative commentary ---
    // Adapted (not copied) from the_dark_horse: thresholds scale off this test's own ideal pace
    // rather than a hardcoded 90s, so they generalize across tests of different lengths.
    const overallAvgTimePerQuestion = questionCount > 0 ? attempt.totalTimeSpentSeconds / questionCount : 0;
    const timePressureNote = overallAvgTimePerQuestion > idealTimePerQuestion * 1.5
      ? 'Your average time per question is well above the ideal pace for this test, suggesting time pressure or difficulty maintaining a steady rhythm.'
      : 'Your time utilisation is within an efficient range for this test\'s pacing.';

    const attemptRatePercent = questionCount > 0 ? ((attempt.totalCorrect + attempt.totalWrong) / questionCount) * 100 : 0;
    const attemptProfileNote = attemptRatePercent > 85 && attempt.accuracyPercent < 40
      ? 'A high attempt rate combined with low accuracy suggests guesswork — consider being more selective about which questions you attempt.'
      : attemptRatePercent < 60 && attempt.accuracyPercent > 70
      ? 'Strong accuracy paired with a low attempt rate indicates hesitation — you may be leaving marks on the table by skipping questions you could likely answer correctly.'
      : 'Your attempt rate and accuracy are reasonably balanced.';

    // --- Confidence insight (priority: overconfidence warning > elimination payoff > guess accuracy > neutral) ---
    const sureAccuracy = confidenceStats.sure.total > 0 ? (confidenceStats.sure.correct / confidenceStats.sure.total) * 100 : null;
    const eliminationAccuracy = confidenceStats.elimination.total > 0 ? (confidenceStats.elimination.correct / confidenceStats.elimination.total) * 100 : null;
    const guessAccuracy = confidenceStats.guess.total > 0 ? (confidenceStats.guess.correct / confidenceStats.guess.total) * 100 : null;
    const totalConfidenceTagged = confidenceStats.sure.total + confidenceStats.elimination.total + confidenceStats.guess.total;

    let confidenceInsight = null;
    if (totalConfidenceTagged === 0) {
      confidenceInsight = null;
    } else if (confidenceStats.sure.total >= 3 && sureAccuracy < 60) {
      confidenceInsight = `You marked ${confidenceStats.sure.total} questions "100% Sure" but only got ${Math.round(sureAccuracy)}% of them right — recalibrate your confidence before locking in an answer.`;
    } else if (confidenceStats.elimination.total >= 3 && confidenceImpact.elimination.marksGainedVsRandomGuessing > 0) {
      confidenceInsight = `Logical elimination earned you ${confidenceImpact.elimination.marksGainedVsRandomGuessing} extra marks over random guessing on those ${confidenceStats.elimination.total} questions (${Math.round(eliminationAccuracy)}% accuracy) — keep using it.`;
    } else if (confidenceStats.guess.total >= 3 && guessAccuracy > 40) {
      confidenceInsight = `Your "pure guesses" landed correct ${Math.round(guessAccuracy)}% of the time — well above the 25% random baseline. Trust your instincts a little more instead of over-thinking.`;
    } else if (totalConfidenceTagged < 3) {
      confidenceInsight = 'Not enough confidence-tagged questions yet to generate a reliable calibration insight — rate more questions next attempt.';
    } else {
      confidenceInsight = 'Your confidence ratings roughly matched your actual accuracy — no major calibration issues detected.';
    }

    // --- Fatigue note (first quarter vs last quarter of the exam window) ---
    const firstSlot = timeSlotBreakdown[0];
    const lastSlot = timeSlotBreakdown[timeSlotBreakdown.length - 1];
    let fatigueNote = null;
    if (firstSlot.attempted >= 2 && lastSlot.attempted >= 2) {
      const drop = firstSlot.accuracy - lastSlot.accuracy;
      if (drop >= 15) {
        fatigueNote = `Your accuracy dropped from ${firstSlot.accuracy}% in the first quarter of the exam to ${lastSlot.accuracy}% in the last quarter — a sign of fatigue or rushing near the end.`;
      } else if (drop <= -15) {
        fatigueNote = `Your accuracy improved from ${firstSlot.accuracy}% in the first quarter to ${lastSlot.accuracy}% in the last quarter — you found your rhythm as the test went on.`;
      } else {
        fatigueNote = 'Your accuracy stayed consistent from the start to the end of the exam window.';
      }
    }

    // --- Rank / percentile ---
    // Best-score-per-user aggregation (not a raw attempt sort) so a student who retakes this
    // test multiple times doesn't occupy multiple leaderboard slots.
    // Only timed Test-mode attempts are ranked: practice sessions (untimed, answers visible) would
    // otherwise let someone climb the leaderboard by peeking.
    let rankAgg = [];
    if (isRanked) {
      rankAgg = await McqAttempt.aggregate([
        { $match: { test: attempt.test, status: { $in: ['submitted', 'auto-submitted'] }, mode: { $ne: 'practice' }, source: TEST_SOURCE } },
        { $sort: { totalMarksObtained: -1, totalTimeSpentSeconds: 1 } },
        { $group: { _id: '$user', bestMarks: { $first: '$totalMarksObtained' }, bestTime: { $first: '$totalTimeSpentSeconds' } } },
        { $sort: { bestMarks: -1, bestTime: 1 } }
      ]);
    }
    const totalParticipants = rankAgg.length;
    const rankIndex = rankAgg.findIndex(r => r._id.toString() === attempt.user.toString());
    const rank = rankIndex >= 0 ? rankIndex + 1 : null;
    const percentile = (totalParticipants > 0 && rank)
      ? Math.round(((totalParticipants - rank) / totalParticipants) * 10000) / 100
      : null;

    // --- Personalized insights (compound topic x confidence x time signals) ---
    const personalizedInsights = [];

    // Complete blind spots first - highest priority.
    for (const t of topicBreakdown) {
      if (t.bucket === 'Not Attempted') {
        personalizedInsights.push(`Need to work on ${t.topic} — 0% attempted.`);
      }
    }

    // Elimination working but costing extra time, per topic.
    for (const [topic, tagMap] of Object.entries(topicConfidenceMap)) {
      const elim = tagMap.elimination;
      if (!elim || elim.total < 2) continue;
      const topicRow = topicBreakdown.find(t => t.topic === topic);
      if (!topicRow || topicRow.avgTimeSpent === 0) continue;
      const elimAccuracy = Math.round((elim.correct / elim.total) * 10000) / 100;
      const elimAvgTime = Math.round(elim.totalTime / elim.total);
      const extraSeconds = elimAvgTime - topicRow.avgTimeSpent;
      if (elimAccuracy >= 70 && extraSeconds >= 15) {
        personalizedInsights.push(`Your elimination accuracy is ${elimAccuracy}% in ${topic} but takes ${extraSeconds}s extra per question — speed it up.`);
      }
    }

    // Positive reinforcement for solid topics.
    for (const t of topicBreakdown) {
      if (t.bucket === 'Strong' && t.attempted >= 2) {
        personalizedInsights.push(`${t.topic} is solid at ${t.accuracy}%.`);
      }
    }

    res.json({
      attemptId: attempt._id,
      testId: attempt.test || null,
      testTitle: attemptLabel(attempt, test),
      subject: attempt.subject,
      mode: attempt.mode || 'test',
      source: attempt.source || 'test',
      isRanked,
      submittedAt: attempt.submittedAt,
      attempts: test ? await quotaInfo(attempt.user, test) : null,
      mistakeCount: attempt.totalWrong,
      summary,
      topicBreakdown,
      weakTopics,
      difficultyBreakdown,
      questionTypeBreakdown,
      timeAnalysis: { idealTimePerQuestion, perQuestion: timeAnalysisPerQuestion, rushedWrongQuestions, timeSinkQuestions },
      timeSlotBreakdown,
      quadrantAnalysis,
      negativeMarkingImpact,
      questionReview,
      bonusInsights: { markedFollowThrough, indecisiveQuestions },
      confidenceBreakdown: confidenceStats,
      confidenceImpact,
      decisionIntelligenceIndex: { score: diiScore, insight: diiInsight },
      narrativeInsights: { timePressureNote, attemptProfileNote, confidenceInsight, fatigueNote },
      personalizedInsights: personalizedInsights.slice(0, 6),
      rank: { value: rank, totalParticipants, percentile }
    });
  } catch (err) {
    console.error('Error computing MCQ attempt result:', err);
    res.status(500).json({ error: 'Server error computing result' });
  }
};

export const getAttemptHistory = async (req, res) => {
  const { subject, testId } = req.query;

  try {
    const filter = { user: req.userId, status: { $in: ['submitted', 'auto-submitted'] } };
    if (subject) filter.subject = subject;
    if (testId) filter.test = testId;

    const attempts = await McqAttempt.find(filter).sort({ submittedAt: 1 }).populate('test', 'title subject totalMarks');
    // Timed Test-mode attempts get their own "progress" series on the client; practice sessions are labelled.
    const history = attempts.map(a => {
      const topicMap = {};
      for (const r of a.responses) {
        const sections = r.tags.length > 0 ? r.tags.map(t => t.section) : ['Untagged'];
        for (const section of Array.from(new Set(sections))) {
          if (!topicMap[section]) topicMap[section] = { correct: 0, wrong: 0 };
          if (r.selectedOption !== null) {
            if (r.isCorrect) topicMap[section].correct += 1;
            else topicMap[section].wrong += 1;
          }
        }
      }
      const topicAccuracy = Object.entries(topicMap)
        .filter(([, v]) => v.correct + v.wrong > 0)
        .map(([topic, v]) => ({ topic, accuracy: Math.round((v.correct / (v.correct + v.wrong)) * 10000) / 100 }));

      return {
        attemptId: a._id,
        testId: a.test?._id,
        testTitle: attemptLabel(a, a.test),
        subject: a.subject,
        mode: a.mode || 'test',
        source: a.source || 'test',
        submittedAt: a.submittedAt,
        totalMarksObtained: a.totalMarksObtained,
        totalMarks: a.totalMaxMarks || a.test?.totalMarks || 0,
        accuracyPercent: a.accuracyPercent,
        totalTimeSpentSeconds: a.totalTimeSpentSeconds,
        topicAccuracy
      };
    });

    res.json({ history });
  } catch (err) {
    console.error('Error fetching MCQ attempt history:', err);
    res.status(500).json({ error: 'Server error fetching history' });
  }
};
