import { parse } from 'csv-parse/sync';
import McqTest from '../models/McqTest.js';
import McqQuestion from '../models/McqQuestion.js';
import McqAttempt from '../models/McqAttempt.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';
import User from '../models/User.js';
import { resolveTagsCell } from '../utils/syllabusTagMatcher.js';

const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

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
  tags: ['tags', 'tag']
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

// Strips answer-revealing fields before a question reaches the client during a live (in-progress) attempt.
const stripQuestionForClient = (q) => ({
  _id: q._id,
  order: q.order,
  questionText: q.questionText,
  options: q.options
});

// Thresholds used by the analyzer (section 2 of the plan) - named constants for easy tuning.
const WEAK_THRESHOLD = 50;
const STRONG_THRESHOLD = 75;
const TOO_FAST_RATIO = 0.4;
const TOO_SLOW_RATIO = 2.0;

// Computes final score/aggregates server-side and marks the attempt submitted. Never trusts
// any score/answer data from the client - only reads what's already stored on the attempt.
async function finalizeAttempt(attempt, isAuto) {
  let totalMarksObtained = 0;
  let totalCorrect = 0;
  let totalWrong = 0;
  let totalUnattempted = 0;
  let totalMarked = 0;
  let totalTimeSpentSeconds = 0;

  for (const r of attempt.responses) {
    totalTimeSpentSeconds += r.timeSpentSeconds;
    if (r.status === 'marked-for-review' || r.status === 'answered-marked-for-review') totalMarked += 1;

    if (r.selectedOption === null) {
      r.isCorrect = null;
      r.marksAwarded = 0;
      totalUnattempted += 1;
    } else {
      r.isCorrect = r.selectedOption === r.correctOption;
      r.marksAwarded = r.isCorrect ? r.maxMarks : -r.negativeMarks;
      if (r.isCorrect) totalCorrect += 1;
      else totalWrong += 1;
      totalMarksObtained += r.marksAwarded;
    }
  }

  attempt.totalMarksObtained = Math.round(totalMarksObtained * 100) / 100;
  attempt.totalCorrect = totalCorrect;
  attempt.totalWrong = totalWrong;
  attempt.totalUnattempted = totalUnattempted;
  attempt.totalMarked = totalMarked;
  attempt.accuracyPercent = (totalCorrect + totalWrong) > 0
    ? Math.round((totalCorrect / (totalCorrect + totalWrong)) * 10000) / 100
    : 0;
  attempt.totalTimeSpentSeconds = totalTimeSpentSeconds;
  attempt.status = isAuto ? 'auto-submitted' : 'submitted';
  attempt.submittedAt = new Date();

  await attempt.save();
  return attempt;
}

// ================= Admin =================

export const createTest = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { title, subject, description, durationMinutes, marksPerQuestion, negativeMarkingRatio, instructions, requiresPurchase, price, discountedPrice, useDiscount } = req.body;

  if (!title || !subject || !durationMinutes) {
    return res.status(400).json({ error: 'title, subject and durationMinutes are required' });
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
      useDiscount: !!useDiscount
    });
    res.json({ test });
  } catch (err) {
    console.error('Error creating MCQ test:', err);
    res.status(500).json({ error: 'Server error creating test' });
  }
};

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
    const validDifficulties = ['Easy', 'Medium', 'Hard'];

    for (let i = 0; i < records.length; i++) {
      const row = mapRecord(records[i], MCQ_QUESTION_FIELD_ALIASES);
      const rowNum = i + 2;

      const orderNum = Number(row.order);
      if (!row.order || isNaN(orderNum) || orderNum <= 0) {
        skippedRows.push({ row: rowNum, reason: 'Missing or invalid order' });
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
      if (!['A', 'B', 'C', 'D'].includes(correctOption)) {
        skippedRows.push({ row: rowNum, reason: 'Correct option must be A, B, C or D' });
        continue;
      }

      const difficultyRaw = (row.difficulty || '').trim();
      const difficulty = validDifficulties.find(d => d.toLowerCase() === difficultyRaw.toLowerCase()) || 'Medium';
      const marks = row.marks && !isNaN(Number(row.marks)) ? Number(row.marks) : null;

      const { tags, rawTags } = await resolveTagsCell(test.subject, row.tags);
      tags.filter(t => !t.matched).forEach(t => unmatchedTagsSet.add(t.title));

      docs.push({
        test: test._id,
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
        rawTags
      });
    }

    // Replace semantics: this upload becomes the full source of truth for this test's questions.
    await McqQuestion.deleteMany({ test: test._id });
    const inserted = docs.length > 0 ? await McqQuestion.insertMany(docs) : [];

    const totalMarks = inserted.reduce((sum, q) => sum + (q.marks ?? test.marksPerQuestion), 0);
    test.questionCount = inserted.length;
    test.totalMarks = Math.round(totalMarks * 100) / 100;
    await test.save();

    res.json({
      message: `Replaced questions for this test with ${inserted.length} question(s).`,
      insertedCount: inserted.length,
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
    const allowedFields = ['title', 'description', 'durationMinutes', 'negativeMarkingRatio', 'marksPerQuestion', 'isPublished', 'instructions', 'requiresPurchase', 'price', 'discountedPrice', 'useDiscount'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (updates.isPublished === true) {
      const existing = await McqTest.findById(testId).select('questionCount');
      if (!existing) return res.status(404).json({ error: 'Test not found' });
      if (existing.questionCount === 0) {
        return res.status(400).json({ error: 'Add at least one question before publishing this test.' });
      }
    }

    const test = await McqTest.findByIdAndUpdate(testId, updates, { new: true });
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
    const questions = await McqQuestion.find({ test: testId }).sort({ order: 1 });
    res.json({ questions });
  } catch (err) {
    console.error('Error listing MCQ questions:', err);
    res.status(500).json({ error: 'Server error listing questions' });
  }
};

// Recomputes questionCount/totalMarks from the actual question set - shared by the
// single-question builder endpoints below and kept independent of the CSV upload path's
// own inline calculation (which replaces the whole question set atomically instead).
async function recomputeTestTotals(testId) {
  const test = await McqTest.findById(testId);
  if (!test) return;
  const questions = await McqQuestion.find({ test: testId }).select('marks');
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks ?? test.marksPerQuestion), 0);
  test.questionCount = questions.length;
  test.totalMarks = Math.round(totalMarks * 100) / 100;
  await test.save();
}

const validateQuestionPayload = (body) => {
  const { questionText, options, correctOption } = body;
  if (!questionText || !questionText.trim()) return 'Question text is required';
  if (!Array.isArray(options) || options.length !== 4) return 'Exactly 4 options are required';
  const labels = options.map(o => o.label);
  if (!['A', 'B', 'C', 'D'].every(l => labels.includes(l))) return 'Options must be labeled A, B, C and D';
  if (options.some(o => !o.text || !o.text.trim())) return 'All 4 options must have text';
  if (!['A', 'B', 'C', 'D'].includes(correctOption)) return 'Correct option must be A, B, C or D';
  return null;
};

// Builder: add one question to a test at a time (as opposed to the CSV path, which replaces
// the whole question set atomically). Appends at the end - order is always questionCount+1.
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
    const nextOrder = (await McqQuestion.countDocuments({ test: testId })) + 1;
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

    const allowedFields = ['questionText', 'options', 'correctOption', 'explanation', 'difficulty', 'marks', 'examSource', 'questionType'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) question[field] = req.body[field];
    }
    if (req.body.tags !== undefined) {
      const test = await McqTest.findById(testId);
      const { tags: resolvedTags, rawTags } = await resolveTagsCell(test.subject, req.body.tags);
      question.tags = resolvedTags;
      question.rawTags = rawTags;
    }

    await question.save();
    await recomputeTestTotals(testId);
    res.json({ question });
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
    const deleted = await McqQuestion.findOneAndDelete({ _id: questionId, test: testId });
    if (!deleted) return res.status(404).json({ error: 'Question not found' });

    // Renumber remaining questions sequentially so order stays gap-free (1..N).
    const remaining = await McqQuestion.find({ test: testId }).sort({ order: 1 });
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

// ================= Student =================

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

    res.json({
      subjects: results.map(r => {
        const pricing = pricingBySubject[r._id];
        return {
          subject: r._id,
          testCount: r.testCount,
          lockedCount: r.lockedCount,
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

export const getTests = async (req, res) => {
  const { subject } = req.query;
  if (!subject) return res.status(400).json({ error: 'subject query param is required' });

  try {
    const tests = await McqTest.find({ subject, isPublished: true }).sort({ createdAt: -1 });
    const testIds = tests.map(t => t._id);

    const attempts = await McqAttempt.find({
      user: req.userId,
      test: { $in: testIds },
      status: { $in: ['submitted', 'auto-submitted'] }
    }).sort({ submittedAt: -1 });

    const lastAttemptByTest = {};
    for (const a of attempts) {
      const key = a.test.toString();
      if (!lastAttemptByTest[key]) {
        lastAttemptByTest[key] = {
          score: a.totalMarksObtained,
          accuracyPercent: a.accuracyPercent,
          submittedAt: a.submittedAt
        };
      }
    }

    const requester = await User.findById(req.userId).select('purchasedMcqTests purchasedMcqSubjects');
    const ownedTestIds = new Set((requester?.purchasedMcqTests || []).map(id => id.toString()));
    const ownedSubjects = new Set(requester?.purchasedMcqSubjects || []);
    const subjectOwned = ownedSubjects.has(subject);

    const pricing = await McqSubjectPricing.findOne({ subject });

    res.json({
      tests: tests.map(t => ({
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
        isOwned: !t.requiresPurchase || ownedTestIds.has(t._id.toString()) || subjectOwned,
        lastAttempt: lastAttemptByTest[t._id.toString()] || null
      })),
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

export const startTest = async (req, res) => {
  const { testId } = req.params;

  try {
    const test = await McqTest.findById(testId);
    if (!test || !test.isPublished) return res.status(404).json({ error: 'Test not found' });

    if (test.requiresPurchase) {
      const requester = await User.findById(req.userId).select('purchasedMcqTests purchasedMcqSubjects');
      const ownedTest = (requester?.purchasedMcqTests || []).some(id => id.equals(test._id));
      const ownedSubject = (requester?.purchasedMcqSubjects || []).includes(test.subject);
      if (!ownedTest && !ownedSubject) return res.status(403).json({ error: 'This test requires purchase. Please buy the subject first.' });
    }

    // Idempotent: resume an existing in-progress attempt rather than creating a duplicate.
    let attempt = await McqAttempt.findOne({ user: req.userId, test: testId, status: 'in-progress' });

    if (attempt) {
      if (new Date() > attempt.serverDeadline) {
        await finalizeAttempt(attempt, true);
        attempt = null;
      } else {
        const questions = await McqQuestion.find({ test: testId }).sort({ order: 1 });
        return res.json({
          attemptId: attempt._id,
          serverDeadline: attempt.serverDeadline,
          durationMinutes: attempt.durationMinutes,
          lastActiveQuestionOrder: attempt.lastActiveQuestionOrder,
          responses: attempt.responses.map(r => ({ order: r.order, status: r.status, selectedOption: r.selectedOption, confidenceTag: r.confidenceTag })),
          questions: questions.map(stripQuestionForClient)
        });
      }
    }

    const questions = await McqQuestion.find({ test: testId }).sort({ order: 1 });
    if (questions.length === 0) return res.status(400).json({ error: 'This test has no questions yet' });

    const startedAt = new Date();
    const serverDeadline = new Date(startedAt.getTime() + test.durationMinutes * 60 * 1000);

    const responses = questions.map(q => {
      const maxMarks = q.marks ?? test.marksPerQuestion;
      return {
        question: q._id,
        order: q.order,
        difficulty: q.difficulty,
        tags: q.tags.map(t => ({ section: t.section, title: t.title })),
        maxMarks,
        negativeMarks: Math.round(maxMarks * test.negativeMarkingRatio * 100) / 100,
        correctOption: q.correctOption,
        status: 'not-visited'
      };
    });

    attempt = await McqAttempt.create({
      user: req.userId,
      test: test._id,
      subject: test.subject,
      startedAt,
      durationMinutes: test.durationMinutes,
      serverDeadline,
      responses,
      lastActiveQuestionOrder: 1
    });

    res.json({
      attemptId: attempt._id,
      serverDeadline: attempt.serverDeadline,
      durationMinutes: attempt.durationMinutes,
      lastActiveQuestionOrder: attempt.lastActiveQuestionOrder,
      responses: attempt.responses.map(r => ({ order: r.order, status: r.status, selectedOption: r.selectedOption, confidenceTag: r.confidenceTag })),
      questions: questions.map(stripQuestionForClient)
    });
  } catch (err) {
    console.error('Error starting MCQ test:', err);
    res.status(500).json({ error: 'Server error starting test' });
  }
};

export const getAttempt = async (req, res) => {
  const { attemptId } = req.params;
  try {
    const attempt = await McqAttempt.findById(attemptId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt.user.toString() !== req.userId) return res.status(403).json({ error: 'Access denied' });

    if (attempt.status === 'in-progress' && new Date() > attempt.serverDeadline) {
      await finalizeAttempt(attempt, true);
      return res.json({ deadlineExpired: true, attemptId: attempt._id });
    }

    if (attempt.status !== 'in-progress') {
      return res.json({ deadlineExpired: false, status: attempt.status, attemptId: attempt._id });
    }

    const questions = await McqQuestion.find({ test: attempt.test }).sort({ order: 1 });
    res.json({
      attemptId: attempt._id,
      serverDeadline: attempt.serverDeadline,
      durationMinutes: attempt.durationMinutes,
      lastActiveQuestionOrder: attempt.lastActiveQuestionOrder,
      responses: attempt.responses.map(r => ({ order: r.order, status: r.status, selectedOption: r.selectedOption, confidenceTag: r.confidenceTag })),
      questions: questions.map(stripQuestionForClient)
    });
  } catch (err) {
    console.error('Error fetching MCQ attempt:', err);
    res.status(500).json({ error: 'Server error fetching attempt' });
  }
};

export const saveResponse = async (req, res) => {
  const { attemptId, order } = req.params;
  const { selectedOption, status, deltaTimeSpentSeconds, isVisit, confidenceTag } = req.body;
  const orderNum = Number(order);

  try {
    const attempt = await McqAttempt.findById(attemptId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt.user.toString() !== req.userId) return res.status(403).json({ error: 'Access denied' });

    if (attempt.status !== 'in-progress') {
      return res.status(409).json({ error: 'This attempt is no longer in progress' });
    }

    if (new Date() > attempt.serverDeadline) {
      await finalizeAttempt(attempt, true);
      return res.json({ ok: true, deadlineExpired: true, attemptId: attempt._id });
    }

    const response = attempt.responses.find(r => r.order === orderNum);
    if (!response) return res.status(404).json({ error: 'Question not found in this attempt' });

    if (selectedOption !== undefined) {
      if (response.selectedOption !== null && selectedOption !== response.selectedOption) {
        response.answerChangedCount += 1;
      }
      response.selectedOption = selectedOption;
    }
    if (status !== undefined) response.status = status;
    if (confidenceTag !== undefined) {
      if (confidenceTag === null || ['sure', 'elimination', 'guess'].includes(confidenceTag)) {
        response.confidenceTag = confidenceTag;
      }
    }
    if (typeof deltaTimeSpentSeconds === 'number' && deltaTimeSpentSeconds > 0) {
      response.timeSpentSeconds += deltaTimeSpentSeconds;
    }
    if (isVisit) {
      response.visitCount += 1;
      if (!response.firstVisitedAt) response.firstVisitedAt = new Date();
      response.lastVisitedAt = new Date();
      if (response.status === 'not-visited') response.status = 'not-answered';
    }

    attempt.lastActiveQuestionOrder = orderNum;
    await attempt.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving MCQ response:', err);
    res.status(500).json({ error: 'Server error saving response' });
  }
};

export const submitAttempt = async (req, res) => {
  const { attemptId } = req.params;
  const { autoSubmit } = req.body;

  try {
    const attempt = await McqAttempt.findById(attemptId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (attempt.user.toString() !== req.userId) return res.status(403).json({ error: 'Access denied' });

    if (attempt.status !== 'in-progress') {
      return res.json({ attemptId: attempt._id, redirectToResult: true });
    }

    await finalizeAttempt(attempt, !!autoSubmit);
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

    const test = await McqTest.findById(attempt.test);
    const questions = await McqQuestion.find({ test: attempt.test }).sort({ order: 1 });
    const questionById = {};
    questions.forEach(q => { questionById[q._id.toString()] = q; });

    const responses = attempt.responses;
    const questionCount = responses.length;
    const idealTimePerQuestion = questionCount > 0 ? (attempt.durationMinutes * 60) / questionCount : 0;

    // --- Summary ---
    const summary = {
      totalMarksObtained: attempt.totalMarksObtained,
      totalMarks: test?.totalMarks ?? 0,
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
    if (totalDurationSeconds > 0) {
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
        questionText: q?.questionText ?? '(question no longer available)',
        options: q?.options ?? [],
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
        answerChangedCount: r.answerChangedCount
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
    const rankAgg = await McqAttempt.aggregate([
      { $match: { test: attempt.test, status: { $in: ['submitted', 'auto-submitted'] } } },
      { $sort: { totalMarksObtained: -1, totalTimeSpentSeconds: 1 } },
      { $group: { _id: '$user', bestMarks: { $first: '$totalMarksObtained' }, bestTime: { $first: '$totalTimeSpentSeconds' } } },
      { $sort: { bestMarks: -1, bestTime: 1 } }
    ]);
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
      testTitle: test?.title ?? '',
      subject: attempt.subject,
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
        testTitle: a.test?.title ?? '',
        subject: a.subject,
        submittedAt: a.submittedAt,
        totalMarksObtained: a.totalMarksObtained,
        totalMarks: a.test?.totalMarks ?? 0,
        accuracyPercent: a.accuracyPercent,
        topicAccuracy
      };
    });

    res.json({ history });
  } catch (err) {
    console.error('Error fetching MCQ attempt history:', err);
    res.status(500).json({ error: 'Server error fetching history' });
  }
};
