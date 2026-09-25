import mongoose from 'mongoose';
import McqReport, { REPORT_REASONS } from '../models/McqReport.js';
import McqQuestion from '../models/McqQuestion.js';
import McqTest from '../models/McqTest.js';
import McqAttempt from '../models/McqAttempt.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { correctAnswerKey } from '../utils/mcqAnswerKey.js';

const OPTIONS = ['A', 'B', 'C', 'D'];
const MAX_REPORTS_PER_DAY = 20;

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// ---------------- student ----------------

// A student reports a question. Works during a live test (the student cannot see the key then, so the
// response never says whether their suggestion matches it) and after it. One open report per student per
// question: reporting again edits the existing one instead of stacking duplicates.
export const submitReport = async (req, res) => {
  const { questionId } = req.params;
  const { reason, suggestedOption, suggestedExplanation, comment, attemptId } = req.body || {};

  if (!mongoose.isValidObjectId(questionId)) return res.status(400).json({ error: 'Invalid question id' });
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'Please choose what is wrong with this question.' });
  if (suggestedOption !== undefined && suggestedOption !== null && suggestedOption !== '' && !OPTIONS.includes(suggestedOption)) {
    return res.status(400).json({ error: 'The suggested answer must be A, B, C or D.' });
  }

  try {
    const question = await McqQuestion.findById(questionId);
    if (!question) return res.status(404).json({ error: 'Question not found' });

    const met = await McqAttempt.exists({ user: req.userId, 'responses.question': question._id });
    if (!met) return res.status(403).json({ error: 'You can only report questions from your own attempts.' });

    const test = await McqTest.findById(question.test).select('subject');
    const fields = {
      reason,
      suggestedOption: OPTIONS.includes(suggestedOption) ? suggestedOption : null,
      suggestedExplanation: clip(suggestedExplanation, 2000),
      comment: clip(comment, 1000),
      test: question.test,
      subject: test?.subject || '',
      ...(mongoose.isValidObjectId(attemptId) ? { attempt: attemptId } : {}),
      snapshot: {
        questionText: question.questionText,
        options: question.options.map(o => ({ label: o.label, text: o.text })),
        correctOption: question.correctOption,
        explanation: question.explanation
      }
    };

    const updateOwnPending = async () => McqReport.findOneAndUpdate(
      { reporter: req.userId, question: question._id, status: 'pending' },
      { $set: fields },
      { returnDocument: 'after' }
    );

    const existing = await updateOwnPending();
    if (existing) return res.json({ ok: true, updated: true, reportId: existing._id });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await McqReport.countDocuments({ reporter: req.userId, createdAt: { $gte: since } });
    if (recent >= MAX_REPORTS_PER_DAY) {
      return res.status(429).json({ error: 'You have sent a lot of reports today. Please try again tomorrow.' });
    }

    try {
      const report = await McqReport.create({ ...fields, question: question._id, reporter: req.userId });
      res.json({ ok: true, reportId: report._id });
    } catch (err) {
      if (err.code === 11000) {
        const raced = await updateOwnPending(); // double-submit: the other request created it first
        return res.json({ ok: true, updated: true, reportId: raced?._id });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error submitting MCQ report:', err);
    res.status(500).json({ error: 'Server error sending report' });
  }
};

export const myReports = async (req, res) => {
  try {
    const reports = await McqReport.find({ reporter: req.userId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      reports: reports.map(r => ({
        _id: r._id,
        questionId: r.question,
        reason: r.reason,
        suggestedOption: r.suggestedOption,
        status: r.status,
        questionText: r.snapshot?.questionText || '',
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt
      }))
    });
  } catch (err) {
    console.error('Error listing my reports:', err);
    res.status(500).json({ error: 'Server error loading your reports' });
  }
};

// ---------------- admin ----------------

const requireAdmin = async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    res.status(403).json({ error: 'Access denied: Admin only' });
    return null;
  }
  return user;
};

const STATUS_FILTERS = ['pending', 'accepted', 'rejected'];

export const reportsCountAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const pending = await McqReport.countDocuments({ status: 'pending' });
    const questions = (await McqReport.distinct('question', { status: 'pending' })).length;
    res.json({ pending, questions });
  } catch (err) {
    console.error('Error counting reports:', err);
    res.status(500).json({ error: 'Server error counting reports' });
  }
};

// Reports grouped per question, so several students reporting the same question read as one item with a
// vote tally ("3 say C, 1 says B") instead of a pile of separate rows.
export const listReportsAdmin = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const status = STATUS_FILTERS.includes(req.query.status) ? req.query.status : req.query.status === 'all' ? null : 'pending';
    const filter = status ? { status } : {};
    if (req.query.subject) filter.subject = String(req.query.subject);

    const reports = await McqReport.find(filter).sort({ createdAt: -1 }).limit(600).populate({ path: 'reporter', select: 'name fullName email', model: User }).lean();
    const questionIds = [...new Set(reports.map(r => String(r.question)))];
    const questions = await McqQuestion.find({ _id: { $in: questionIds } }).lean();
    const questionById = new Map(questions.map(q => [String(q._id), q]));
    const tests = await McqTest.find({ _id: { $in: [...new Set(questions.map(q => String(q.test)))] } }).select('title subject').lean();
    const testById = new Map(tests.map(t => [String(t._id), t]));

    const groups = new Map();
    for (const r of reports) {
      const key = String(r.question);
      const q = questionById.get(key);
      if (!groups.has(key)) {
        const test = q ? testById.get(String(q.test)) : null;
        groups.set(key, {
          question: q ? {
            _id: q._id,
            testId: q.test,
            testTitle: test?.title || '',
            subject: test?.subject || r.subject || '',
            order: q.order,
            questionText: q.questionText,
            options: q.options,
            correctOption: q.correctOption,
            explanation: q.explanation,
            isActive: q.isActive !== false
          } : { _id: r.question, questionText: r.snapshot?.questionText || '(question deleted)', options: r.snapshot?.options || [], deleted: true },
          reports: [],
          pendingCount: 0,
          tally: { A: 0, B: 0, C: 0, D: 0 },
          latestAt: r.createdAt
        });
      }
      const g = groups.get(key);
      g.reports.push({
        _id: r._id,
        reason: r.reason,
        suggestedOption: r.suggestedOption,
        suggestedExplanation: r.suggestedExplanation,
        comment: r.comment,
        status: r.status,
        adminNote: r.adminNote,
        appliedChange: r.appliedChange,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        reporter: r.reporter ? { name: r.reporter.fullName || r.reporter.name, email: r.reporter.email } : null
      });
      if (r.status === 'pending') {
        g.pendingCount += 1;
        if (r.suggestedOption) g.tally[r.suggestedOption] += 1;
      }
      if (r.createdAt > g.latestAt) g.latestAt = r.createdAt;
    }

    const list = [...groups.values()].sort((a, b) => (b.pendingCount - a.pendingCount) || (new Date(b.latestAt) - new Date(a.latestAt)));
    res.json({ groups: list });
  } catch (err) {
    console.error('Error listing reports:', err);
    res.status(500).json({ error: 'Server error loading reports' });
  }
};

const notify = async (reports, textFor) => {
  try {
    const docs = reports.map(r => ({ recipientId: r.reporter, text: textFor(r) }));
    if (docs.length) await Message.insertMany(docs);
  } catch (err) {
    console.error('Could not send report notifications:', err.message); // never fail a resolution over this
  }
};

// Accept (one click: apply the suggested answer, optionally the explanation too) or reject one report.
export const resolveReport = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { action, applyAnswer, applyExplanation, overrideOption, overrideExplanation, rescore, adminNote } = req.body || {};

  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: "action must be 'accept' or 'reject'" });
  if (overrideOption !== undefined && overrideOption !== null && overrideOption !== '' && !OPTIONS.includes(overrideOption)) {
    return res.status(400).json({ error: 'overrideOption must be A, B, C or D' });
  }

  try {
    const report = await McqReport.findById(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status !== 'pending') return res.status(409).json({ error: `Already ${report.status}` });

    const question = await McqQuestion.findById(report.question);
    const test = question ? await McqTest.findById(question.test).select('title') : null;
    const label = `${test?.title || 'a test'} - Q${question?.order ?? '?'}`;
    const note = clip(adminNote, 500);

    if (action === 'reject') {
      report.status = 'rejected';
      report.resolvedBy = admin._id;
      report.resolvedAt = new Date();
      report.adminNote = note;
      await report.save();
      await notify([report], () => `Thanks for reporting ${label}. We reviewed it and the current answer stands.`);
      return res.json({ ok: true, status: 'rejected' });
    }

    if (!question) return res.status(404).json({ error: 'The question no longer exists' });

    const option = OPTIONS.includes(overrideOption) ? overrideOption : report.suggestedOption;
    const explanation = clip(overrideExplanation, 2000) || report.suggestedExplanation;
    const wantsAnswer = applyAnswer !== false && !!option;
    const wantsExplanation = !!applyExplanation && !!explanation;

    const result = await correctAnswerKey({
      question,
      correctOption: wantsAnswer ? option : undefined,
      explanation: wantsExplanation ? explanation : undefined,
      changedBy: admin._id,
      report: report._id,
      note,
      rescore: rescore !== false
    });

    report.status = 'accepted';
    report.resolvedBy = admin._id;
    report.resolvedAt = new Date();
    report.adminNote = note;
    report.appliedChange = {
      previousOption: result.previousOption,
      newOption: question.correctOption,
      explanationChanged: result.explanationChanged,
      rescoredAttempts: result.rescoredAttempts
    };
    await report.save();

    // Every other open report that asked for the same answer is now satisfied - close it too.
    let alsoClosed = [];
    if (result.optionChanged) {
      const siblings = await McqReport.find({ question: question._id, status: 'pending', suggestedOption: question.correctOption });
      for (const s of siblings) {
        s.status = 'accepted';
        s.resolvedBy = admin._id;
        s.resolvedAt = new Date();
        s.autoResolvedBy = report._id;
        s.appliedChange = report.appliedChange;
        await s.save();
      }
      alsoClosed = siblings;
    }

    await notify([report, ...alsoClosed], () =>
      result.optionChanged
        ? `Thanks! Your report on ${label} was accepted - the answer key has been corrected.`
        : `Thanks! Your report on ${label} was accepted and the question has been updated.`
    );

    res.json({
      ok: true,
      status: 'accepted',
      optionChanged: result.optionChanged,
      explanationChanged: result.explanationChanged,
      rescoredAttempts: result.rescoredAttempts,
      alsoClosed: alsoClosed.length
    });
  } catch (err) {
    console.error('Error resolving report:', err);
    res.status(500).json({ error: 'Server error resolving report' });
  }
};

// "Ignore all": reject every open report on one question in one go.
export const rejectAllForQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const pending = await McqReport.find({ question: req.params.questionId, status: 'pending' });
    if (pending.length === 0) return res.json({ ok: true, closed: 0 });

    const question = await McqQuestion.findById(req.params.questionId).select('order test');
    const test = question ? await McqTest.findById(question.test).select('title') : null;
    const label = `${test?.title || 'a test'} - Q${question?.order ?? '?'}`;
    const note = clip(req.body?.adminNote, 500);

    for (const r of pending) {
      r.status = 'rejected';
      r.resolvedBy = admin._id;
      r.resolvedAt = new Date();
      r.adminNote = note;
      await r.save();
    }
    await notify(pending, () => `Thanks for reporting ${label}. We reviewed it and the current answer stands.`);
    res.json({ ok: true, closed: pending.length });
  } catch (err) {
    console.error('Error rejecting reports:', err);
    res.status(500).json({ error: 'Server error closing reports' });
  }
};
