import { parse } from 'csv-parse/sync';
import McqTest from '../models/McqTest.js';
import McqQuestion from '../models/McqQuestion.js';
import McqAttempt from '../models/McqAttempt.js';
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

  const { title, subject, description, durationMinutes, marksPerQuestion, negativeMarkingRatio, instructions } = req.body;

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
      instructions: Array.isArray(instructions) ? instructions : []
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
    const allowedFields = ['title', 'description', 'durationMinutes', 'negativeMarkingRatio', 'marksPerQuestion', 'isPublished', 'instructions'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
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

// ================= Student =================

export const getSubjects = async (req, res) => {
  try {
    const results = await McqTest.aggregate([
      { $match: { isPublished: true } },
      { $group: { _id: '$subject', testCount: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    res.json({ subjects: results.map(r => ({ subject: r._id, testCount: r.testCount })) });
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

    res.json({
      tests: tests.map(t => ({
        _id: t._id,
        title: t.title,
        description: t.description,
        durationMinutes: t.durationMinutes,
        totalMarks: t.totalMarks,
        questionCount: t.questionCount,
        negativeMarkingRatio: t.negativeMarkingRatio,
        lastAttempt: lastAttemptByTest[t._id.toString()] || null
      }))
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
          responses: attempt.responses.map(r => ({ order: r.order, status: r.status, selectedOption: r.selectedOption })),
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
      responses: attempt.responses.map(r => ({ order: r.order, status: r.status, selectedOption: r.selectedOption })),
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
      responses: attempt.responses.map(r => ({ order: r.order, status: r.status, selectedOption: r.selectedOption })),
      questions: questions.map(stripQuestionForClient)
    });
  } catch (err) {
    console.error('Error fetching MCQ attempt:', err);
    res.status(500).json({ error: 'Server error fetching attempt' });
  }
};

export const saveResponse = async (req, res) => {
  const { attemptId, order } = req.params;
  const { selectedOption, status, deltaTimeSpentSeconds, isVisit } = req.body;
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

    res.json({
      attemptId: attempt._id,
      testTitle: test?.title ?? '',
      subject: attempt.subject,
      summary,
      topicBreakdown,
      weakTopics,
      difficultyBreakdown,
      timeAnalysis: { idealTimePerQuestion, perQuestion: timeAnalysisPerQuestion, rushedWrongQuestions, timeSinkQuestions },
      quadrantAnalysis,
      negativeMarkingImpact,
      questionReview,
      bonusInsights: { markedFollowThrough, indecisiveQuestions }
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
