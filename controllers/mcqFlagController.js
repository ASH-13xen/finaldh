import mongoose from 'mongoose';
import McqFlag from '../models/McqFlag.js';
import McqQuestion from '../models/McqQuestion.js';
import McqTest from '../models/McqTest.js';
import McqAttempt from '../models/McqAttempt.js';

// Flags are a student's personal bookmarks ("show me this again"), kept across attempts. Flagging is only
// allowed for a question the student has actually met in one of their own attempts - otherwise flags
// could be used to pull questions (and, below, their answers) out of tests they never took.

export const flagQuestion = async (req, res) => {
  const { questionId } = req.params;
  if (!mongoose.isValidObjectId(questionId)) return res.status(400).json({ error: 'Invalid question id' });

  try {
    const question = await McqQuestion.findById(questionId).select('test');
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const met = await McqAttempt.exists({ user: req.userId, 'responses.question': question._id });
    if (!met) return res.status(403).json({ error: 'You can only flag questions from your own attempts.' });

    const test = await McqTest.findById(question.test).select('subject');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : undefined;

    await McqFlag.findOneAndUpdate(
      { user: req.userId, question: question._id },
      { $set: { test: question.test, subject: test?.subject || '', ...(note !== undefined ? { note } : {}) } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    res.json({ flagged: true });
  } catch (err) {
    console.error('Error flagging question:', err);
    res.status(500).json({ error: 'Server error flagging question' });
  }
};

export const unflagQuestion = async (req, res) => {
  try {
    await McqFlag.deleteOne({ user: req.userId, question: req.params.questionId });
    res.json({ flagged: false });
  } catch (err) {
    console.error('Error unflagging question:', err);
    res.status(500).json({ error: 'Server error removing flag' });
  }
};

// The Flagged Questions page: everything the student bookmarked, newest first, optionally for one subject.
// A question's answer + explanation are included only once the student is entitled to see it: they have
// finished an attempt containing it, or revealed it in practice mode.
export const listFlags = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.userId);
    const subjectRows = await McqFlag.aggregate([
      { $match: { user: userId } },
      { $group: { _id: '$subject', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    const filter = { user: userId };
    if (req.query.subject) filter.subject = String(req.query.subject);
    const flags = await McqFlag.find(filter).sort({ createdAt: -1 }).limit(300);
    if (flags.length === 0) {
      return res.json({ flags: [], subjects: subjectRows.map(r => ({ subject: r._id, count: r.count })) });
    }

    const ids = flags.map(f => f.question);
    const questions = await McqQuestion.find({ _id: { $in: ids } });
    const questionById = new Map(questions.map(q => [String(q._id), q]));
    const tests = await McqTest.find({ _id: { $in: [...new Set(questions.map(q => String(q.test)))] } }).select('title');
    const testTitle = new Map(tests.map(t => [String(t._id), t.title]));

    const visibleRows = await McqAttempt.aggregate([
      { $match: { user: userId, 'responses.question': { $in: ids } } },
      { $unwind: '$responses' },
      { $match: { 'responses.question': { $in: ids } } },
      { $project: { qid: '$responses.question', visible: { $or: [{ $in: ['$status', ['submitted', 'auto-submitted']] }, { $eq: ['$responses.revealed', true] }] } } },
      { $group: { _id: '$qid', visible: { $max: '$visible' } } }
    ]);
    const visible = new Set(visibleRows.filter(r => r.visible).map(r => String(r._id)));

    res.json({
      subjects: subjectRows.map(r => ({ subject: r._id, count: r.count })),
      flags: flags
        .map(f => {
          const q = questionById.get(String(f.question));
          if (!q) return null;
          const answerVisible = visible.has(String(q._id));
          return {
            questionId: q._id,
            testId: q.test,
            testTitle: testTitle.get(String(q.test)) || '',
            subject: f.subject,
            order: q.order,
            questionText: q.questionText,
            options: q.options,
            difficulty: q.difficulty,
            tags: q.tags.map(t => ({ section: t.section, title: t.title })),
            examSource: q.examSource,
            note: f.note,
            flaggedAt: f.createdAt,
            isActive: q.isActive !== false,
            answerVisible,
            ...(answerVisible ? { correctOption: q.correctOption, explanation: q.explanation } : {})
          };
        })
        .filter(Boolean)
    });
  } catch (err) {
    console.error('Error listing flags:', err);
    res.status(500).json({ error: 'Server error loading flagged questions' });
  }
};
