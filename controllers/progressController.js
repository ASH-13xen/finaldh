import mongoose from 'mongoose';
import { parse } from 'csv-parse/sync';
import Topic from '../models/Topic.js';
import ProgressQuestion from '../models/ProgressQuestion.js';
import QuestionProgress from '../models/QuestionProgress.js';
import ProgressPyq from '../models/ProgressPyq.js';
import PyqProgress from '../models/PyqProgress.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import { findMatchingPyqsForTagCells } from '../utils/tagMatcher.js';

const isAdminEmail = (email) => {
  return [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .includes((email || '').toLowerCase());
};

export const requireAdmin = async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Access denied: Admin only' });
    return null;
  }
  return user;
};

// Admin, or (course has Progress enabled AND user has it in purchasedCourses/interestedCourses).
const hasCourseAccess = (user, course) => {
  if (isAdminEmail(user.email)) return true;
  if (!course.progressEnabled) return false;
  const hasPurchased = user.purchasedCourses.some(id => id.toString() === course._id.toString());
  const hasInterest = user.interestedCourses.some(cId => cId.toLowerCase() === course.courseId.toLowerCase());
  return hasPurchased || hasInterest;
};

const normalizeHeader = (key) => key.toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');

const TOPIC_QUESTION_FIELD_ALIASES = {
  topicName: ['topic name', 'topicname', 'topic', 'section name', 'section'],
  questionText: ['question text', 'questiontext', 'text', 'question'],
  tag: ['tag', 'tags'],
  pageNumber: ['page number', 'pagenumber', 'page']
};

const PYQ_FIELD_ALIASES = {
  questionText: ['question text', 'questiontext', 'text', 'question'],
  section: ['section', 'topic', 'tag', 'tags'],
  year: ['year']
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

// ================= Admin: Topic/Question CSV upload (additive/upsert) =================

// Shared additive/upsert logic — used by BOTH the CSV upload path and the Gemini-extraction
// commit path (extractionController.js). Finds-or-creates Topics by name within
// (course, fileIndex); always inserts new Questions (never updates/dedups existing ones).
// rows: [{ topicName, questionText, pageNumber, tag }]
export const upsertTopicsAndQuestions = async (course, fileIndex, rows) => {
  const existingTopics = await Topic.find({ course: course._id, fileIndex }).sort({ order: 1 });
  const topicByName = new Map();
  let maxTopicOrder = 0;
  for (const t of existingTopics) {
    topicByName.set(t.name.toLowerCase(), { _id: t._id, order: t.order });
    if (t.order > maxTopicOrder) maxTopicOrder = t.order;
  }

  const existingQuestions = await ProgressQuestion.find({ course: course._id, fileIndex });
  const maxQuestionOrderByTopic = new Map();
  for (const q of existingQuestions) {
    const key = q.topic.toString();
    maxQuestionOrderByTopic.set(key, Math.max(maxQuestionOrderByTopic.get(key) || 0, q.order));
  }

  const newTopicDocs = [];
  const questionDocs = [];
  const skippedRows = [];
  const touchedTopicKeys = new Set();
  let newTopicsCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    const topicName = (row.topicName || '').trim();
    if (!topicName) {
      skippedRows.push({ row: rowNum, reason: 'Missing topic name' });
      continue;
    }
    if (!row.questionText || !row.questionText.trim()) {
      skippedRows.push({ row: rowNum, reason: 'Missing question text' });
      continue;
    }
    const pageNum = Number(row.pageNumber);
    if (!row.pageNumber || isNaN(pageNum) || pageNum <= 0) {
      skippedRows.push({ row: rowNum, reason: 'Missing or invalid page number' });
      continue;
    }

    const nameKey = topicName.toLowerCase();
    let topicRef = topicByName.get(nameKey);
    if (!topicRef) {
      maxTopicOrder += 1;
      topicRef = { _id: new mongoose.Types.ObjectId(), order: maxTopicOrder };
      topicByName.set(nameKey, topicRef);
      newTopicDocs.push({ _id: topicRef._id, course: course._id, fileIndex, name: topicName, order: topicRef.order });
      newTopicsCount += 1;
    }
    touchedTopicKeys.add(topicRef._id.toString());

    const topicKey = topicRef._id.toString();
    const nextOrder = (maxQuestionOrderByTopic.get(topicKey) || 0) + 1;
    maxQuestionOrderByTopic.set(topicKey, nextOrder);

    questionDocs.push({
      topic: topicRef._id,
      course: course._id,
      fileIndex,
      questionText: row.questionText.trim(),
      tag: (row.tag || '').trim(),
      pageNumber: pageNum,
      order: nextOrder
    });
  }

  if (newTopicDocs.length > 0) await Topic.insertMany(newTopicDocs);
  const insertedQuestions = questionDocs.length > 0 ? await ProgressQuestion.insertMany(questionDocs) : [];

  return {
    insertedCount: insertedQuestions.length,
    newTopicsCount,
    touchedTopicCount: touchedTopicKeys.size,
    skippedRows
  };
};

export const uploadTopicQuestionsCsv = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId } = req.body;
  const fileIndex = Number(req.body.fileIndex) || 0;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'CSV file is required' });
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const fileCount = course.fileUrls?.length > 0 ? course.fileUrls.length : 1;
    if (fileIndex < 0 || fileIndex >= fileCount) {
      return res.status(400).json({ error: 'Invalid fileIndex for this course' });
    }

    const records = parseCsvBuffer(file.buffer);
    if (records.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty or could not be parsed' });
    }

    const rows = records.map((record) => mapRecord(record, TOPIC_QUESTION_FIELD_ALIASES));
    const result = await upsertTopicsAndQuestions(course, fileIndex, rows);
    // Shift skipped-row numbers by 1 so they still refer to spreadsheet row numbers
    // (row 1 = CSV header), matching this endpoint's original row-numbering behavior.
    const skippedRows = result.skippedRows.map((s) => ({ ...s, row: s.row + 1 }));

    res.json({
      message: `Added ${result.insertedCount} new question(s) across ${result.touchedTopicCount} topic(s) (${result.newTopicsCount} new topic(s) created).`,
      insertedCount: result.insertedCount,
      newTopicsCount: result.newTopicsCount,
      skippedRows
    });
  } catch (err) {
    console.error('Error uploading topic/question CSV:', err);
    res.status(500).json({ error: err.message || 'Server error processing CSV' });
  }
};

// ================= Admin: direct CRUD + reorder =================

export const renameTopic = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const topic = await Topic.findByIdAndUpdate(req.params.topicId, { name: name.trim() }, { new: true });
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    res.json({ topic });
  } catch (err) {
    console.error('Error renaming topic:', err);
    res.status(500).json({ error: 'Server error renaming topic' });
  }
};

export const updateQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const allowedFields = ['questionText', 'tag', 'pageNumber'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = field === 'pageNumber' ? Number(req.body[field]) : req.body[field];
      }
    }
    const question = await ProgressQuestion.findByIdAndUpdate(req.params.questionId, updates, { new: true });
    if (!question) return res.status(404).json({ error: 'Question not found' });
    res.json({ question });
  } catch (err) {
    console.error('Error updating question:', err);
    res.status(500).json({ error: 'Server error updating question' });
  }
};

export const deleteTopic = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { topicId } = req.params;
    const questions = await ProgressQuestion.find({ topic: topicId });
    const questionIds = questions.map(q => q._id);
    const progressResult = await QuestionProgress.deleteMany({ question: { $in: questionIds } });
    await ProgressQuestion.deleteMany({ topic: topicId });
    const deleted = await Topic.findByIdAndDelete(topicId);
    if (!deleted) return res.status(404).json({ error: 'Topic not found' });
    res.json({
      message: `Deleted topic, ${questionIds.length} question(s), and ${progressResult.deletedCount} progress record(s).`,
      deletedQuestions: questionIds.length,
      deletedProgressRecords: progressResult.deletedCount
    });
  } catch (err) {
    console.error('Error deleting topic:', err);
    res.status(500).json({ error: 'Server error deleting topic' });
  }
};

export const deleteQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { questionId } = req.params;
    const progressResult = await QuestionProgress.deleteMany({ question: questionId });
    const deleted = await ProgressQuestion.findByIdAndDelete(questionId);
    if (!deleted) return res.status(404).json({ error: 'Question not found' });
    res.json({
      message: `Deleted question and ${progressResult.deletedCount} progress record(s).`,
      deletedProgressRecords: progressResult.deletedCount
    });
  } catch (err) {
    console.error('Error deleting question:', err);
    res.status(500).json({ error: 'Server error deleting question' });
  }
};

export const moveTopic = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { topicId } = req.params;
    const { direction } = req.body;
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'direction must be up or down' });

    const topic = await Topic.findById(topicId);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    const sibling = direction === 'up'
      ? await Topic.findOne({ course: topic.course, fileIndex: topic.fileIndex, order: { $lt: topic.order } }).sort({ order: -1 })
      : await Topic.findOne({ course: topic.course, fileIndex: topic.fileIndex, order: { $gt: topic.order } }).sort({ order: 1 });

    if (!sibling) return res.json({ message: `Already at the ${direction === 'up' ? 'top' : 'bottom'}`, moved: false });

    const topicOrder = topic.order;
    topic.order = sibling.order;
    sibling.order = topicOrder;
    await topic.save();
    await sibling.save();

    res.json({ moved: true });
  } catch (err) {
    console.error('Error moving topic:', err);
    res.status(500).json({ error: 'Server error moving topic' });
  }
};

export const moveQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { questionId } = req.params;
    const { direction } = req.body;
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'direction must be up or down' });

    const question = await ProgressQuestion.findById(questionId);
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const sibling = direction === 'up'
      ? await ProgressQuestion.findOne({ topic: question.topic, order: { $lt: question.order } }).sort({ order: -1 })
      : await ProgressQuestion.findOne({ topic: question.topic, order: { $gt: question.order } }).sort({ order: 1 });

    if (!sibling) return res.json({ message: `Already at the ${direction === 'up' ? 'top' : 'bottom'}`, moved: false });

    const questionOrder = question.order;
    question.order = sibling.order;
    sibling.order = questionOrder;
    await question.save();
    await sibling.save();

    res.json({ moved: true });
  } catch (err) {
    console.error('Error moving question:', err);
    res.status(500).json({ error: 'Server error moving question' });
  }
};

// ================= Admin: PYQ CSV upload (replace-all-for-subject) =================

export const uploadProgressPyqsCsv = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { subject } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'CSV file is required' });
  if (!subject) return res.status(400).json({ error: 'subject is required' });

  try {
    const records = parseCsvBuffer(file.buffer);
    if (records.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty or could not be parsed' });
    }

    const docs = [];
    const skippedRows = [];

    for (let i = 0; i < records.length; i++) {
      const row = mapRecord(records[i], PYQ_FIELD_ALIASES);
      const rowNum = i + 2;

      if (!row.questionText || !row.questionText.trim()) {
        skippedRows.push({ row: rowNum, reason: 'Missing question text' });
        continue;
      }
      if (!row.section || !row.section.trim()) {
        skippedRows.push({ row: rowNum, reason: 'Missing section' });
        continue;
      }
      const year = Number(row.year);
      if (!row.year || isNaN(year)) {
        skippedRows.push({ row: rowNum, reason: 'Missing or invalid year' });
        continue;
      }

      docs.push({
        questionText: row.questionText.trim(),
        subject,
        section: row.section.trim(),
        year
      });
    }

    await ProgressPyq.deleteMany({ subject });
    const inserted = docs.length > 0 ? await ProgressPyq.insertMany(docs) : [];

    res.json({
      message: `Replaced PYQs for this subject with ${inserted.length} row(s).`,
      insertedCount: inserted.length,
      skippedRows
    });
  } catch (err) {
    console.error('Error uploading PYQ CSV:', err);
    res.status(500).json({ error: err.message || 'Server error processing CSV' });
  }
};

export const listProgressPyqsAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { subject, courseId, fileIndex } = req.query;
    let filter = {};
    if (courseId) {
      const course = await Course.findById(courseId);
      const fileIdxNum = Number(fileIndex) || 0;
      // Include legacy subject-only rows (course: null) so admins still see/manage
      // pre-existing CSV-uploaded PYQs after switching this view to course+file scoping.
      filter = {
        $or: [
          { course: courseId, fileIndex: fileIdxNum },
          { course: null, subject: course?.subject }
        ]
      };
    } else if (subject) {
      filter.subject = subject;
    }
    const pyqs = await ProgressPyq.find(filter).sort({ year: -1 });
    res.json({ pyqs });
  } catch (err) {
    console.error('Error listing PYQs:', err);
    res.status(500).json({ error: 'Server error listing PYQs' });
  }
};

export const deleteProgressPyq = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const deleted = await ProgressPyq.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'PYQ not found' });
    res.json({ message: 'PYQ deleted' });
  } catch (err) {
    console.error('Error deleting PYQ:', err);
    res.status(500).json({ error: 'Server error deleting PYQ' });
  }
};

// ================= Admin: course+file combos that already have progress data =================

// Returns, for every Course, which fileIndex values have at least one Topic
// (Topics are only created once a question is upserted into them, so Topic
// existence is equivalent to "has progress data uploaded" for that course+file).
// Used to scope the PYQ-extraction course/file picker to courses that already
// have a Topic taxonomy to tag extracted PYQs against.
export const listProgressEnabledCourses = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const distinctPairs = await Topic.aggregate([
      { $group: { _id: { course: '$course', fileIndex: '$fileIndex' } } }
    ]);
    const fileIndexesByCourse = new Map();
    for (const row of distinctPairs) {
      const courseId = row._id.course.toString();
      if (!fileIndexesByCourse.has(courseId)) fileIndexesByCourse.set(courseId, new Set());
      fileIndexesByCourse.get(courseId).add(row._id.fileIndex);
    }

    const courseIds = Array.from(fileIndexesByCourse.keys());
    const courses = await Course.find({ _id: { $in: courseIds } });

    const result = courses.map((c) => ({
      _id: c._id,
      name: c.name,
      subject: c.subject,
      fileUrls: c.fileUrls,
      fileNames: c.fileNames,
      progressFileIndexes: Array.from(fileIndexesByCourse.get(c._id.toString())).sort((a, b) => a - b)
    }));

    res.json({ courses: result });
  } catch (err) {
    console.error('Error listing progress-enabled courses:', err);
    res.status(500).json({ error: 'Server error listing progress-enabled courses' });
  }
};

// ================= Student: list Progress-enabled courses (locked if not purchased) =================

export const listVisibleCourses = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const courses = await Course.find({ progressEnabled: true }).sort({ createdAt: -1 });
    const result = courses.map((c) => ({
      _id: c._id,
      name: c.name,
      subject: c.subject,
      fileUrl: c.fileUrl,
      fileUrls: c.fileUrls,
      fileNames: c.fileNames,
      fileName: c.fileName,
      unlocked: hasCourseAccess(user, c)
    }));

    res.json({ courses: result });
  } catch (err) {
    console.error('Error listing visible progress courses:', err);
    res.status(500).json({ error: 'Server error listing progress courses' });
  }
};

// ================= Shared: list topics+questions (student view + admin manage tab) =================

export const listTopicsWithQuestions = async (req, res) => {
  const { courseId, fileIndex } = req.query;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const fileIdxNum = Number(fileIndex) || 0;

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (!hasCourseAccess(user, course)) {
      return res.status(403).json({ error: 'Access denied: this course is not in your purchased courses' });
    }

    const topics = await Topic.find({ course: courseId, fileIndex: fileIdxNum }).sort({ order: 1 });
    const questions = await ProgressQuestion.find({ course: courseId, fileIndex: fileIdxNum }).sort({ order: 1 });

    const progressRecords = await QuestionProgress.find({
      user: req.userId,
      question: { $in: questions.map(q => q._id) },
      completed: true
    });
    const completedSet = new Set(progressRecords.map(p => p.question.toString()));

    const questionsByTopic = {};
    for (const q of questions) {
      const key = q.topic.toString();
      if (!questionsByTopic[key]) questionsByTopic[key] = [];
      questionsByTopic[key].push({
        _id: q._id,
        questionText: q.questionText,
        tag: q.tag,
        pageNumber: q.pageNumber,
        order: q.order,
        completed: completedSet.has(q._id.toString())
      });
    }

    const topicsWithQuestions = topics.map(t => ({
      _id: t._id,
      name: t.name,
      order: t.order,
      questions: questionsByTopic[t._id.toString()] || []
    }));

    res.json({
      topics: topicsWithQuestions,
      totalQuestions: questions.length,
      totalCompleted: completedSet.size
    });
  } catch (err) {
    console.error('Error listing topics/questions:', err);
    res.status(500).json({ error: 'Server error listing topics/questions' });
  }
};

// ================= Student: toggle completion + matched PYQs =================

export const toggleQuestionProgress = async (req, res) => {
  const { questionId } = req.params;
  const { completed } = req.body;
  if (typeof completed !== 'boolean') return res.status(400).json({ error: 'completed (boolean) is required' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const question = await ProgressQuestion.findById(questionId);
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const course = await Course.findById(question.course);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (!hasCourseAccess(user, course)) {
      return res.status(403).json({ error: 'Access denied: this course is not in your purchased courses' });
    }

    await QuestionProgress.findOneAndUpdate(
      { user: req.userId, question: questionId },
      {
        completed,
        completedAt: completed ? new Date() : null,
        course: question.course,
        fileIndex: question.fileIndex
      },
      { upsert: true, new: true }
    );

    const totalQuestions = await ProgressQuestion.countDocuments({ course: question.course, fileIndex: question.fileIndex });
    const totalCompleted = await QuestionProgress.countDocuments({
      user: req.userId,
      course: question.course,
      fileIndex: question.fileIndex,
      completed: true
    });

    res.json({ completed, totalQuestions, totalCompleted });
  } catch (err) {
    console.error('Error toggling question progress:', err);
    res.status(500).json({ error: 'Server error toggling progress' });
  }
};

// ================= Student: file-scoped PYQ panel =================

// Aggregates PYQs matched from every question the user has completed in this course+file,
// annotated with whether the user has separately marked each PYQ itself as completed.
export const listFilePyqs = async (req, res) => {
  const { courseId, fileIndex } = req.query;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const fileIdxNum = Number(fileIndex) || 0;

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (!hasCourseAccess(user, course)) {
      return res.status(403).json({ error: 'Access denied: this course is not in your purchased courses' });
    }

    const questions = await ProgressQuestion.find({ course: courseId, fileIndex: fileIdxNum });
    const completedProgress = await QuestionProgress.find({
      user: req.userId,
      question: { $in: questions.map(q => q._id) },
      completed: true
    });
    const completedQuestionIds = new Set(completedProgress.map(p => p.question.toString()));
    const completedQuestions = questions.filter(q => completedQuestionIds.has(q._id.toString()));

    // tagCells = union of each completed question's legacy free-text tag (often blank) and its
    // Topic name (populated by default for the extraction flow) - lets PYQs tagged with a Topic
    // name surface without requiring admins to manually re-tag every ProgressQuestion.
    const completedTopicIds = [...new Set(completedQuestions.map(q => q.topic.toString()))];
    const completedTopics = await Topic.find({ _id: { $in: completedTopicIds } });
    const topicNameById = new Map(completedTopics.map(t => [t._id.toString(), t.name]));
    const completedTagCells = completedQuestions.map(q =>
      [q.tag, topicNameById.get(q.topic.toString())].filter(Boolean).join(';')
    );

    // course+fileIndex-scoped PYQs (new extraction flow) plus legacy subject-only rows
    // (course: null) that pre-date this scoping, for backward compatibility.
    const pyqs = await ProgressPyq.find({
      $or: [
        { course: courseId, fileIndex: fileIdxNum },
        { course: null, subject: course.subject }
      ]
    });
    const matched = findMatchingPyqsForTagCells(completedTagCells, pyqs);

    const pyqProgress = await PyqProgress.find({
      user: req.userId,
      pyq: { $in: matched.map(p => p._id) },
      completed: true
    });
    const pyqCompletedSet = new Set(pyqProgress.map(p => p.pyq.toString()));

    res.json({
      pyqs: matched.map(p => ({
        _id: p._id,
        questionText: p.questionText,
        section: p.section,
        year: p.year,
        completed: pyqCompletedSet.has(p._id.toString())
      }))
    });
  } catch (err) {
    console.error('Error listing file PYQs:', err);
    res.status(500).json({ error: 'Server error listing file PYQs' });
  }
};

export const togglePyqProgress = async (req, res) => {
  const { pyqId } = req.params;
  const { completed } = req.body;
  if (typeof completed !== 'boolean') return res.status(400).json({ error: 'completed (boolean) is required' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const pyq = await ProgressPyq.findById(pyqId);
    if (!pyq) return res.status(404).json({ error: 'PYQ not found' });

    const coursesWithSubject = await Course.find({ subject: pyq.subject });
    const hasAccess = coursesWithSubject.some(c => hasCourseAccess(user, c));
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: no purchased course matches this PYQ\'s subject' });
    }

    await PyqProgress.findOneAndUpdate(
      { user: req.userId, pyq: pyqId },
      { completed, completedAt: completed ? new Date() : null },
      { upsert: true, new: true }
    );

    res.json({ completed });
  } catch (err) {
    console.error('Error toggling PYQ progress:', err);
    res.status(500).json({ error: 'Server error toggling PYQ progress' });
  }
};
