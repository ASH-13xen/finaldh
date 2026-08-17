import { GoogleGenerativeAI } from '@google/generative-ai';
import Course from '../models/Course.js';
import Topic from '../models/Topic.js';
import ProgressPyq from '../models/ProgressPyq.js';
import ProgressDraft from '../models/ProgressDraft.js';
import ProgressPyqSortJob from '../models/ProgressPyqSortJob.js';
import { requireAdmin, upsertTopicsAndQuestions } from './progressController.js';

const GEMINI_MODEL = 'gemini-3.5-flash';
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 3000;
const INTER_CHUNK_DELAY_MS = 2500;
const PYQ_MIN_YEAR = 2001;
// Dynamic (not hardcoded like the PDF extraction pipeline's PYQ_MAX_YEAR = 2025) so this
// doesn't silently start rejecting valid PYQs the moment a new exam year begins.
const getPyqMaxYear = () => new Date().getFullYear();
// Safety sub-split for a single oversized pasted block, so one huge paste can't blow past
// a reasonable prompt size. Each pasted block is otherwise its own natural chunk boundary.
const MAX_BLOCK_CHARS = 40000;

const getFileCount = (course) => (course.fileUrls?.length > 0 ? course.fileUrls.length : 1);
const validFileIndex = (course, fileIndex) => fileIndex >= 0 && fileIndex < getFileCount(course);
const normalizeForDedup = (text) => (text || '').trim().toLowerCase().replace(/\s+/g, ' ');

const callGeminiWithRetry = async (model, contentParts) => {
  let delayMs = INITIAL_DELAY_MS;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await model.generateContent(contentParts);
      return response.response.text();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`[ProgressPyqSort] Gemini call failed (attempt ${attempt}/${MAX_RETRIES}):`, err.message || err);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
};

// Splits an oversized pasted block into smaller pieces on paragraph boundaries where
// possible, falling back to a hard character cut. Each piece becomes its own chunk.
const splitOversizedBlock = (text) => {
  if (text.length <= MAX_BLOCK_CHARS) return [text];
  const pieces = [];
  let remaining = text;
  while (remaining.length > MAX_BLOCK_CHARS) {
    let cut = remaining.lastIndexOf('\n\n', MAX_BLOCK_CHARS);
    if (cut < MAX_BLOCK_CHARS * 0.5) cut = MAX_BLOCK_CHARS; // paragraph break too far back, just hard-cut
    pieces.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) pieces.push(remaining);
  return pieces;
};

// ================= Overview: classify every course x fileIndex for the builder picker =================

export const getBuilderOverview = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const topicPairs = await Topic.aggregate([
      { $group: { _id: { course: '$course', fileIndex: '$fileIndex' } } }
    ]);
    const topicKeySet = new Set(topicPairs.map((r) => `${r._id.course}:${r._id.fileIndex}`));

    const pyqPairs = await ProgressPyq.aggregate([
      { $match: { course: { $ne: null }, fileIndex: { $ne: null } } },
      { $group: { _id: { course: '$course', fileIndex: '$fileIndex' } } }
    ]);
    const pyqKeySet = new Set(pyqPairs.map((r) => `${r._id.course}:${r._id.fileIndex}`));

    const drafts = await ProgressDraft.find({}, 'course fileIndex updatedAt');
    const draftByKey = new Map(drafts.map((d) => [`${d.course}:${d.fileIndex}`, { id: d._id, updatedAt: d.updatedAt }]));

    const courses = await Course.find({}, 'name subject fileUrls fileNames fileName progressEnabled').sort({ createdAt: -1 });

    const result = courses.map((c) => {
      const fileCount = getFileCount(c);
      const files = [];
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
        const key = `${c._id}:${fileIndex}`;
        let state = 'not_started';
        let draftId = null;
        let draftUpdatedAt = null;
        if (draftByKey.has(key)) {
          state = 'draft';
          draftId = draftByKey.get(key).id;
          draftUpdatedAt = draftByKey.get(key).updatedAt;
        } else if (topicKeySet.has(key)) {
          state = pyqKeySet.has(key) ? 'complete' : 'pyqs_pending';
        }
        files.push({ fileIndex, state, draftId, draftUpdatedAt });
      }
      return {
        _id: c._id,
        name: c.name,
        subject: c.subject,
        fileUrls: c.fileUrls,
        fileNames: c.fileNames,
        fileName: c.fileName,
        progressEnabled: c.progressEnabled,
        files
      };
    });

    res.json({ courses: result });
  } catch (err) {
    console.error('Error fetching progress builder overview:', err);
    res.status(500).json({ error: 'Server error fetching builder overview' });
  }
};

// ================= Draft CRUD (manual topic/question authoring, autosaved) =================

export const upsertDraft = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId, fileIndex, topics } = req.body;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const fileIdxNum = Number(fileIndex) || 0;

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (!validFileIndex(course, fileIdxNum)) {
      return res.status(400).json({ error: 'Invalid fileIndex for this course' });
    }

    const draft = await ProgressDraft.findOneAndUpdate(
      { course: course._id, fileIndex: fileIdxNum },
      { $set: { topics: Array.isArray(topics) ? topics : [], createdBy: admin._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ draftId: draft._id, updatedAt: draft.updatedAt });
  } catch (err) {
    console.error('Error autosaving progress draft:', err);
    res.status(500).json({ error: 'Server error autosaving draft' });
  }
};

export const listDrafts = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const drafts = await ProgressDraft.find({}).sort({ updatedAt: -1 }).populate('course', 'name subject fileNames fileUrls');
    const result = drafts
      .filter((d) => d.course)
      .map((d) => ({
        _id: d._id,
        courseId: d.course._id,
        courseName: d.course.name,
        subject: d.course.subject,
        fileIndex: d.fileIndex,
        fileName: d.course.fileNames?.[d.fileIndex] || `Part ${d.fileIndex + 1}`,
        topicCount: d.topics.length,
        questionCount: d.topics.reduce((sum, t) => sum + t.questions.length, 0),
        updatedAt: d.updatedAt
      }));
    res.json({ drafts: result });
  } catch (err) {
    console.error('Error listing progress drafts:', err);
    res.status(500).json({ error: 'Server error listing drafts' });
  }
};

export const getDraft = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId, fileIndex } = req.query;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const fileIdxNum = Number(fileIndex) || 0;

  try {
    const draft = await ProgressDraft.findOne({ course: courseId, fileIndex: fileIdxNum });
    if (!draft) return res.json({ draft: null });
    res.json({ draft: { _id: draft._id, courseId: draft.course, fileIndex: draft.fileIndex, topics: draft.topics, updatedAt: draft.updatedAt } });
  } catch (err) {
    console.error('Error fetching progress draft:', err);
    res.status(500).json({ error: 'Server error fetching draft' });
  }
};

export const deleteDraft = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const draft = await ProgressDraft.findByIdAndDelete(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    res.json({ message: 'Draft deleted.' });
  } catch (err) {
    console.error('Error deleting progress draft:', err);
    res.status(500).json({ error: 'Server error deleting draft' });
  }
};

// Commits a draft's manually-entered topics/questions into the real Topic/ProgressQuestion
// collections via the same upsertTopicsAndQuestions helper the CSV-upload and PDF-extraction
// paths already use, then deletes the draft. From this point on the file behaves exactly like
// any other progress-section source and is fully editable via the existing Progress Data admin tool.
export const commitDraft = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const draft = await ProgressDraft.findById(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const course = await Course.findById(draft.course);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    if (draft.topics.length === 0) {
      return res.status(400).json({ error: 'Add at least one topic before saving.' });
    }

    const seenTopicNames = new Set();
    const rows = [];
    for (const topic of draft.topics) {
      const topicName = (topic.name || '').trim();
      if (!topicName) return res.status(400).json({ error: 'Every topic needs a name.' });
      const nameKey = topicName.toLowerCase();
      if (seenTopicNames.has(nameKey)) {
        return res.status(400).json({ error: `Duplicate topic name: "${topicName}". Topic names must be unique within this file.` });
      }
      seenTopicNames.add(nameKey);

      if (topic.questions.length === 0) {
        return res.status(400).json({ error: `Topic "${topicName}" has no questions. Add at least one question, or delete the topic.` });
      }

      const maxPage = course.partPageCounts?.[draft.fileIndex];
      for (const q of topic.questions) {
        if (!q.questionText || !q.questionText.trim()) {
          return res.status(400).json({ error: `Topic "${topicName}" has a question with no text.` });
        }
        const pageNum = Number(q.pageNumber);
        if (!Number.isFinite(pageNum) || pageNum <= 0) {
          return res.status(400).json({ error: `Topic "${topicName}" has a question with a missing/invalid page number.` });
        }
        if (maxPage && pageNum > maxPage) {
          return res.status(400).json({ error: `Topic "${topicName}": page ${pageNum} is beyond this PDF's ${maxPage} pages. Double-check it.` });
        }
        rows.push({ topicName, questionText: q.questionText.trim(), pageNumber: pageNum, tag: '' });
      }
    }

    const result = await upsertTopicsAndQuestions(course, draft.fileIndex, rows);
    await ProgressDraft.findByIdAndDelete(draft._id);

    res.json({
      message: `Saved ${result.insertedCount} question(s) across ${result.newTopicsCount} topic(s).`,
      courseId: course._id,
      fileIndex: draft.fileIndex,
      ...result
    });
  } catch (err) {
    console.error('Error committing progress draft:', err);
    res.status(500).json({ error: err.message || 'Server error committing draft' });
  }
};

// ================= PYQ paste-and-sort (Gemini-powered, auto-commits, auto-enables progress) =================

export const startPyqSortJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId, fileIndex, textBlocks } = req.body;
  if (!courseId) return res.status(400).json({ error: 'courseId is required' });
  const fileIdxNum = Number(fileIndex) || 0;
  const blocks = (Array.isArray(textBlocks) ? textBlocks : []).map((b) => (b || '').trim()).filter(Boolean);
  if (blocks.length === 0) return res.status(400).json({ error: 'At least one non-empty PYQ text block is required' });

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (!validFileIndex(course, fileIdxNum)) {
      return res.status(400).json({ error: 'Invalid fileIndex for this course' });
    }

    const topics = await Topic.find({ course: course._id, fileIndex: fileIdxNum }).sort({ order: 1 });
    if (topics.length === 0) {
      return res.status(400).json({ error: 'This course+file has no topics yet. Add topics & questions for it first.' });
    }
    const topicNames = topics.map((t) => t.name);

    const chunks = blocks.flatMap((b) => splitOversizedBlock(b));

    const job = await ProgressPyqSortJob.create({
      course: course._id,
      fileIndex: fileIdxNum,
      createdBy: admin._id,
      status: 'pending',
      textBlocks: chunks,
      topicNames
    });

    processPyqSortJob(job._id.toString()).catch((err) => {
      console.error(`[ProgressPyqSortJob ${job._id}] Unhandled error:`, err);
    });

    res.status(202).json({ jobId: job._id, status: 'pending' });
  } catch (err) {
    console.error('Error starting PYQ sort job:', err);
    res.status(500).json({ error: err.message || 'Server error starting PYQ sort job' });
  }
};

export const getPyqSortJobStatus = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const job = await ProgressPyqSortJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'PYQ sort job not found' });

    res.json({
      jobId: job._id,
      status: job.status,
      totalChunks: job.totalChunks,
      chunksCompleted: job.chunksCompleted,
      chunksFailed: job.chunksFailed,
      failedChunkRanges: job.failedChunkRanges,
      currentChunkRange: job.currentChunkRange,
      pyqsFoundSoFar: job.sortedPyqs.length,
      sortedPyqs: job.status === 'done' ? job.sortedPyqs : undefined,
      insertedCount: job.insertedCount,
      skippedCount: job.skippedCount,
      error: job.error
    });
  } catch (err) {
    console.error('Error fetching PYQ sort job status:', err);
    res.status(500).json({ error: 'Server error fetching job status' });
  }
};

// Background worker - not a request handler. Classifies pasted PYQ text against the fixed
// topicNames vocabulary and auto-commits directly to ProgressPyq (no separate review step).
export const processPyqSortJob = async (jobId) => {
  const job = await ProgressPyqSortJob.findById(jobId);
  if (!job) return;

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      throw new Error('Gemini API key is not configured in backend .env');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: 'application/json' }
    });

    job.status = 'sorting';
    job.totalChunks = job.textBlocks.length;
    await job.save();

    // Seed dedup with PYQs already saved for this course+file, so re-running this step later
    // (e.g. adding a new year's block on top of a previously-sorted PDF) never duplicates.
    const existing = await ProgressPyq.find({ course: job.course, fileIndex: job.fileIndex }, 'questionText year');
    const seenKeys = new Set(existing.map((p) => `${p.year}::${normalizeForDedup(p.questionText)}`));

    const topicListForPrompt = job.topicNames.map((n, i) => `${i + 1}. ${n}`).join('\n');
    const pyqMaxYear = getPyqMaxYear();
    const allPyqs = [];

    for (let chunkIndex = 0; chunkIndex < job.textBlocks.length; chunkIndex++) {
      job.currentChunkRange = `block ${chunkIndex + 1} of ${job.textBlocks.length}`;
      await job.save();

      const prompt = `
You are given a block of pasted "Previous Year Questions" (PYQ) text (block ${chunkIndex + 1} of ${job.textBlocks.length} an admin pasted; this may be only part of a larger set, and may contain messy copy-paste artifacts like stray page numbers, headers, or line breaks mid-sentence - reconstruct clean question text).

Each distinct question in this text has an exam year associated with it, typically noted near the end of the question (e.g. "(2019)", "[UPSC 2014]", "CSE 2020"). Extract EVERY distinct question you find, individually.

For each distinct question found, extract:
1. "year": the 4-digit exam year associated with that question. If no year is identifiable for a question, omit that question entirely - do not guess.
2. "questionText": the full question text, cleaned of numbering prefixes (e.g. "Q5)", "5.") and the trailing year annotation itself.
3. "suggestedTag": classify this question into the SINGLE existing topic name below that fits BEST. Always pick one, even if the fit is imperfect - never return null and never leave it unclassified. Do not invent new topic names; it must be an exact match to one of the names listed.
Topics:
${topicListForPrompt}

Return strictly as a JSON array:
[
  { "year": integer, "questionText": "string", "suggestedTag": "string (exact match to one of the topic names above - always pick the closest one, never null)" }
]
If no questions are found in this block, return an empty array.

Text block:
"""
${job.textBlocks[chunkIndex]}
"""
`;

      let chunkPyqs = [];
      let chunkSucceeded = false;
      let quotaExceeded = false;
      try {
        const responseText = await callGeminiWithRetry(model, [prompt]);
        const parsed = JSON.parse(responseText.trim());
        if (Array.isArray(parsed)) {
          chunkPyqs = parsed.filter((q) => q && q.questionText && Number.isFinite(Number(q.year)));
        }
        chunkSucceeded = true;
      } catch (err) {
        const message = err.message || String(err);
        console.error(`[ProgressPyqSortJob ${jobId}] Chunk ${chunkIndex + 1} failed:`, message);
        quotaExceeded = /quota|429|too many requests/i.test(message);
        job.chunksFailed += 1;
        job.failedChunkRanges.push(`block ${chunkIndex + 1}`);
        job.error = quotaExceeded
          ? `Stopped at block ${chunkIndex + 1} of ${job.totalChunks}: Gemini API quota exceeded. ${job.chunksCompleted} of ${job.totalChunks} blocks were analyzed before this happened. Fix your API key's billing/quota, then re-run for the remaining text.`
          : `Block ${chunkIndex + 1} failed: ${message}. Other blocks were still attempted; you may re-run for just the failed portion.`;
      }

      for (const q of chunkPyqs) {
        const year = Number(q.year);
        if (year < PYQ_MIN_YEAR || year > pyqMaxYear) continue;

        const questionText = String(q.questionText).trim();
        const dedupKey = `${year}::${normalizeForDedup(questionText)}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);

        const suggestedTag = q.suggestedTag && job.topicNames.includes(q.suggestedTag) ? q.suggestedTag : job.topicNames[0];
        allPyqs.push({ year, questionText, suggestedTag });
      }

      job.sortedPyqs = allPyqs;
      if (chunkSucceeded) job.chunksCompleted += 1;
      await job.save();

      if (quotaExceeded) {
        job.status = 'error';
        await job.save();
        return;
      }

      if (chunkIndex < job.textBlocks.length - 1) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
      }
    }

    // Auto-commit directly - no separate review/bulk-create step for this flow.
    const docs = allPyqs.map((p) => ({
      questionText: p.questionText,
      subject: '',
      course: job.course,
      fileIndex: job.fileIndex,
      section: p.suggestedTag,
      year: p.year
    }));
    const inserted = docs.length > 0 ? await ProgressPyq.insertMany(docs) : [];
    job.insertedCount = inserted.length;
    job.skippedCount = 0;

    if (inserted.length > 0) {
      const course = await Course.findById(job.course);
      if (course && !course.progressEnabled) {
        course.progressEnabled = true;
        await course.save();
      }
    }

    job.status = 'done';
    job.currentChunkRange = '';
    await job.save();
  } catch (err) {
    console.error(`[ProgressPyqSortJob ${jobId}] Fatal error:`, err);
    job.status = 'error';
    job.error = err.message || 'PYQ sorting failed';
    await job.save();
  }
};
