// Subject syllabus + placing questions under it. Admin only. See utils/syllabusTagging.js.
//
//   GET    /api/syllabus/admin                         every syllabus + its bank's PYQ counts
//   POST   /api/syllabus/admin                         multipart: subject, file (.docx) — create or replace
//   DELETE /api/syllabus/admin/:subject                remove a syllabus (placements stay on the questions)
//   GET    /api/syllabus/admin/placement?kind=&ref=    questions of a test / bank with their placement
//   POST   /api/syllabus/admin/placement/run           { kind, ref, retag?, limit? } background AI job
//   POST   /api/syllabus/admin/placement/stop          { kind, ref }
//   PATCH  /api/syllabus/admin/placement/:kind/:id     { chapter, subtopic } admin correction
//
// kind = 'test' (ref = test id) | 'bank' (ref = subject).

import McqQuestion from '../models/McqQuestion.js';
import QuizQuestion from '../models/QuizQuestion.js';
import SubjectSyllabus from '../models/SubjectSyllabus.js';
import { requireAdmin } from './progressController.js';
import { parseSyllabusDocx } from '../utils/syllabusDocx.js';
import {
  getPlacementJob, placementSet, startPlacementJob, stopPlacementJob, subjectOf, syllabusFor,
} from '../utils/syllabusTagging.js';

const KINDS = ['test', 'bank'];
const fail = (res, err, fallback) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${fallback}:`, err);
  return res.status(500).json({ error: fallback });
};

export const listSyllabi = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const syllabi = await SubjectSyllabus.find({}).sort({ subject: 1 }).lean();
    const counts = await QuizQuestion.aggregate([
      { $match: { subject: { $in: syllabi.map((s) => s.subject) } } },
      { $group: { _id: '$subject', total: { $sum: 1 } } },
    ]);
    res.json({
      syllabi: syllabi.map((s) => ({ ...s, bankQuestions: counts.find((c) => c._id === s.subject)?.total || 0 })),
    });
  } catch (err) {
    fail(res, err, 'Failed to load syllabi');
  }
};

export const uploadSyllabus = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const subject = String(req.body.subject || '').trim().slice(0, 120);
  if (!subject) return res.status(400).json({ error: 'A subject is required' });
  if (!req.file) return res.status(400).json({ error: 'A Word (.docx) file is required' });
  try {
    let parsed;
    try {
      parsed = parseSyllabusDocx(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: `Could not read the Word file: ${e.message}` });
    }
    if (parsed.chapters.length < 2) {
      return res.status(400).json({ error: 'No chapters found. Use a numbered Heading for each chapter, e.g. "1. Basic Concepts", with bullets under it for its sub-topics.' });
    }
    const syllabus = await SubjectSyllabus.findOneAndUpdate(
      { subject },
      { $set: { subject, chapters: parsed.chapters, studyOrder: parsed.studyOrder, fileName: req.file.originalname } },
      { upsert: true, new: true, runValidators: true },
    );
    res.json({ syllabus });
  } catch (err) {
    fail(res, err, 'Failed to save the syllabus');
  }
};

export const deleteSyllabus = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await SubjectSyllabus.deleteOne({ subject: req.params.subject });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Failed to delete the syllabus');
  }
};

export const getPlacement = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { kind, ref } = req.query;
    if (!KINDS.includes(kind) || !ref) return res.status(400).json({ error: 'kind and ref are required' });
    const subject = await subjectOf(kind, ref);
    const syllabus = subject && await syllabusFor(subject);
    if (!syllabus) return res.status(400).json({ error: `No syllabus uploaded for ${subject || 'this subject'}` });
    const fields = 'questionText syllabusTag';
    const rows = kind === 'bank'
      ? await QuizQuestion.find({ subject }).sort({ seq: 1 }).select(`${fields} seq`).lean()
      : await McqQuestion.find({ test: ref, isActive: { $ne: false } }).sort({ order: 1 }).select(`${fields} order`).lean();
    res.json({
      subject,
      chapters: syllabus.chapters,
      job: getPlacementJob(kind, ref) || null,
      questions: rows.map((q, i) => ({
        _id: q._id,
        no: kind === 'bank' ? i + 1 : q.order,
        text: q.questionText,
        chapter: q.syllabusTag?.chapter || '',
        subtopic: q.syllabusTag?.subtopic || '',
        by: q.syllabusTag?.by || null,
        confidence: q.syllabusTag?.confidence ?? null,
      })),
    });
  } catch (err) {
    fail(res, err, 'Failed to load placements');
  }
};

export const runPlacement = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { kind, ref, retag, limit } = req.body || {};
    if (!KINDS.includes(kind) || !ref) return res.status(400).json({ error: 'kind and ref are required' });
    res.json({ job: await startPlacementJob(kind, String(ref), { retag: retag === true, limit: Number(limit) || 0 }) });
  } catch (err) {
    fail(res, err, 'Failed to start placement');
  }
};

export const stopPlacement = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { kind, ref } = req.body || {};
  res.json({ stopping: stopPlacementJob(kind, String(ref)) });
};

export const correctPlacement = async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { kind, id } = req.params;
    if (!KINDS.includes(kind)) return res.status(404).json({ error: 'Not found' });
    const Model = kind === 'bank' ? QuizQuestion : McqQuestion;
    const q = await Model.findById(id).select('test subject topic sourceTopic').lean();
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const subject = await subjectOf(kind, kind === 'bank' ? q.subject : q.test);
    const syllabus = subject && await syllabusFor(subject);
    if (!syllabus) return res.status(400).json({ error: 'No syllabus for this subject' });

    const chapter = syllabus.chapters.find((c) => c.key === req.body?.chapter) || null;
    if (req.body?.chapter && !chapter) return res.status(400).json({ error: 'Unknown chapter' });
    const subtopic = chapter?.subtopics.includes(req.body?.subtopic) ? req.body.subtopic : '';
    await Model.updateOne({ _id: id }, { $set: placementSet(kind, q, chapter, { subtopic, by: 'admin', confidence: null }) });
    res.json({ chapter: chapter?.key || '', subtopic, by: 'admin' });
  } catch (err) {
    fail(res, err, 'Failed to save the placement');
  }
};
