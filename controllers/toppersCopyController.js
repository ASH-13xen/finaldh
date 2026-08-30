// ============================================================================
// toppersCopyController.js — "Toppers Copy" section (GS / Optional)
// ----------------------------------------------------------------------------
// One ToppersCopy doc == one syllabus topic. It holds:
//   • questions[] — each with answers[] (a topper + a page range inside the one
//     compendium PDF on R2) and a per-question AI analysis
//   • the topic is grouped under a syllabusSection (e.g. "History")
//   • related previous-year questions come from the ToppersPyq collection
//
// A compendium PDF covers a whole SECTION and holds several topics, each starting
// on a divider page. Ingestion (AI vision, provider-agnostic — Gemini or Claude
// via AI_PROVIDER, see utils/aiProvider.js) splits the PDF at the dividers, then
// detects question/answer boundaries within each topic. Every pass writes to a
// ToppersCopyJob the admin reviews and edits before committing; commit upserts
// one ToppersCopy per topic.
//
// Endpoints (see routes/toppersCopyRoutes.js):
//   Admin
//     POST   /api/toppers-copy/admin/compendium/start          multipart pdf + subject/section (+ startingTopic?, fromPage?)
//     GET    /api/toppers-copy/admin/jobs/:jobId               poll job status
//     POST   /api/toppers-copy/admin/compendium/:jobId/commit  reviewed topics[] -> one ToppersCopy per topic
//     POST   /api/toppers-copy/admin/pyq/start                 multipart pdf (cross-subject compilation)
//     POST   /api/toppers-copy/admin/pyq/:jobId/commit         reviewed rows -> ToppersPyq
//     PATCH  /api/toppers-copy/admin/:id                       edit a ToppersCopy (questions, order, published…)
//     DELETE /api/toppers-copy/admin/:id
//     POST   /api/toppers-copy/admin/:id/questions/:qid/analyze  (re)generate that question's aiAnalysis
//   Student / admin
//     GET    /api/toppers-copy/subjects                        subjects that have published content
//     GET    /api/toppers-copy/topics?subject=GS-1             published topics for a subject
//     GET    /api/toppers-copy/:id                             one topic (questions + answers + analysis)
//     GET    /api/toppers-copy/:id/pdf                         Range-aware PDF stream (view, not download)
// ============================================================================

import fs from 'fs/promises';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersPyq from '../models/ToppersPyq.js';
import ToppersCopyJob from '../models/ToppersCopyJob.js';
import { requireAdmin } from './progressController.js';
import {
  runJsonExtraction,
  assertAiConfigured,
  getActiveModelLabel,
  isQuotaError,
} from '../utils/aiProvider.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const COMPENDIUM_CHUNK_SIZE = 20;   // pages per AI vision pass for topper-boundary detection
const PYQ_CHUNK_SIZE = 40;          // pages per AI pass for PYQ table extraction
const CHUNK_OVERLAP = 3;            // pages re-sent at each chunk boundary (dedup downstream)
// Pause between chunks — bump AI_INTER_CHUNK_DELAY_MS on a tight free-tier quota.
const INTER_CHUNK_DELAY_MS = Number(process.env.AI_INTER_CHUNK_DELAY_MS) || 4000;

const PYQ_MIN_YEAR = 1990;
const PYQ_MAX_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Build a base64 PDF containing only pages [startIdx0, endIdx0] (0-based, inclusive).
const makeChunkPdfBase64 = async (srcDoc, startIdx0, endIdx0) => {
  const chunk = await PDFDocument.create();
  const indices = [];
  for (let p = startIdx0; p <= endIdx0; p++) indices.push(p);
  const pages = await chunk.copyPages(srcDoc, indices);
  pages.forEach((pg) => chunk.addPage(pg));
  const bytes = await chunk.save();
  return Buffer.from(bytes).toString('base64');
};

const uploadPdfToR2 = async (localPath, key) => {
  const body = await fs.readFile(localPath);
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'application/pdf',
    })
  );
  return `r2://${key}`;
};

const safeUnlink = (p) => (p ? fs.unlink(p).catch(() => {}) : Promise.resolve());

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeForDedup = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Short stable key for the ToppersPyq unique index (questionText itself can be
// longer than Mongo's 1024-byte index-key limit).
const pyqDedupeKey = (subject, year, questionText) =>
  crypto
    .createHash('sha1')
    .update(`${String(subject).toLowerCase()}::${year}::${normalizeForDedup(questionText)}`)
    .digest('hex');

// ===========================================================================
// ADMIN — compendium ingestion (scanned toppers-copy PDF for one syllabus
// section; the AI splits it into topics at the divider pages)
// ===========================================================================

// POST /admin/compendium/start
// multipart: pdf, subject, syllabusSection, startingTopic?, fromPage?
export const startCompendiumJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { subject, syllabusSection = '', startingTopic = '' } = req.body;
  const fromPage = Math.max(1, Number(req.body.fromPage) || 1); // resume a rate-limited run
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'A PDF file is required' });
  if (!subject) {
    await safeUnlink(file.path);
    return res.status(400).json({ error: 'subject is required' });
  }

  try {
    assertAiConfigured(); // fail fast if the active provider has no key
  } catch (err) {
    await safeUnlink(file.path);
    return res.status(500).json({ error: err.message });
  }

  try {
    // Upload the source PDF to R2 up front — it's the artifact students will view,
    // regardless of how the review pans out.
    const key = `toppers-copy/${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    const pdfKey = await uploadPdfToR2(file.path, key);

    const job = await ToppersCopyJob.create({
      kind: 'compendium',
      createdBy: admin._id,
      status: 'pending',
      aiModelLabel: getActiveModelLabel(),
      subject,
      syllabusSection,
      startingTopic,
      originalFileName: file.originalname,
      sourceFilePath: file.path,
      pdfKey,
      fromPage,
    });

    processCompendiumJob(job._id.toString()).catch((err) =>
      console.error(`[ToppersCopyJob ${job._id}] unhandled:`, err)
    );

    res.status(202).json({ jobId: job._id, status: 'pending', pdfKey });
  } catch (err) {
    await safeUnlink(file.path);
    console.error('startCompendiumJob error:', err);
    res.status(500).json({ error: err.message || 'Failed to start ingestion job' });
  }
};

// Background worker — walks the topic PDF in vision chunks. The compendium is laid
// out as: printed question -> the handwritten answers several toppers wrote for
// it -> next question. Each chunk pass reports where questions begin (with their
// text) and where topper answers begin (with the header-strip metadata). After
// the walk we stitch the ordered page markers into questions[] -> answers[].
export const processCompendiumJob = async (jobId) => {
  const job = await ToppersCopyJob.findById(jobId);
  if (!job) return;

  try {
    const bytes = await fs.readFile(job.sourceFilePath);
    const srcDoc = await PDFDocument.load(bytes);
    const totalPages = srcDoc.getPageCount();
    const fromPage = Math.min(Math.max(1, job.fromPage || 1), totalPages);

    job.status = 'extracting';
    job.totalPages = totalPages;
    job.totalChunks = Math.ceil((totalPages - fromPage + 1) / COMPENDIUM_CHUNK_SIZE);
    await job.save();

    const topicStarts = [];    // { page, topic }
    const questionStarts = []; // { page, questionText, year, marks }
    const answerStarts = [];   // { page, name, rank, year, marks, source }
    const seenTPages = new Set();
    const seenQPages = new Set();
    const seenAPages = new Set();
    let quotaAbortedAtPage = null;

    for (let start = fromPage; start <= totalPages; start += COMPENDIUM_CHUNK_SIZE) {
      const end = Math.min(start + COMPENDIUM_CHUNK_SIZE - 1, totalPages);
      const effStart = start === 1 ? 1 : Math.max(1, start - CHUNK_OVERLAP);

      job.currentChunkRange = `pages ${effStart}-${end}`;
      await job.save();

      const pdfBase64 = await makeChunkPdfBase64(srcDoc, effStart - 1, end - 1);

      const prompt = `
You are looking at pages ${effStart} to ${end} of a scanned PDF: a compendium of UPSC Mains toppers' handwritten answer copies, covering SEVERAL syllabus topics. This chunk is NOT the whole document.

Structure:
- Each topic begins on a TOPIC-DIVIDER page: a page with the series title "Toppers Copy Compass", a single prominent topic name (often highlighted in green), and almost no other content.
- After a divider come the topic's questions. Each is a PRINTED question (English, often with a Hindi translation and its marks, sometimes numbered "Q.4)" / "3."), followed by ONE OR MORE toppers' HANDWRITTEN answers to it, then the next printed question.
- A topper's answer begins on a page with a printed header strip naming them, e.g. "Harshita Goyal - AIR-2 (2024) | GS-1 - 102" or "Animesh Pradhan - AIR-2 (2023)".
- Ignore pure front/back-cover pages (series title only, or just Telegram / contact details).

For THIS chunk only, report three lists of absolute page numbers (each between ${effStart} and ${end}):

A) "topicStarts" — every TOPIC-DIVIDER page:
   - "page": integer
   - "topic": the topic name printed on that divider page

B) "questionStarts" — every page where a NEW printed question begins:
   - "page": integer
   - "questionText": the full English question text, leading numbering removed
   - "year": 4-digit exam year printed with the question, else null
   - "marks": marks as an integer if printed (treat 12.5 as 12), else null

C) "answerStarts" — every page where a NEW topper's handwritten answer begins:
   - "page": integer
   - "name": topper name from the header strip
   - "rank": AIR/rank as an integer if shown, else null
   - "year": 4-digit year if shown, else null
   - "marks": marks for this answer as a string if shown ("109", "12.5/15"), else ""
   - "source": coaching institute named on the strip if any, else ""

Also: "detectedSubject" — e.g. "GS-1" if visible on a cover page, else "".

Return strictly this JSON shape:
{
  "detectedSubject": "string",
  "topicStarts": [ { "page": integer, "topic": "string" } ],
  "questionStarts": [ { "page": integer, "questionText": "string", "year": integer|null, "marks": integer|null } ],
  "answerStarts": [ { "page": integer, "name": "string", "rank": integer|null, "year": integer|null, "marks": "string", "source": "string" } ]
}
Use [] for any list with nothing in this chunk.
`.trim();

      try {
        const parsed = await runJsonExtraction({ prompt, pdfBase64 });

        if (parsed && !job.detectedSubject && parsed.detectedSubject) {
          job.detectedSubject = String(parsed.detectedSubject).trim();
        }

        const tList = Array.isArray(parsed?.topicStarts) ? parsed.topicStarts : [];
        for (const t of tList) {
          const page = Number(t.page);
          if (!Number.isFinite(page) || page < effStart || page > end || seenTPages.has(page)) continue;
          seenTPages.add(page);
          topicStarts.push({ page, topic: String(t.topic || '').trim() });
        }

        const qList = Array.isArray(parsed?.questionStarts) ? parsed.questionStarts : [];
        for (const q of qList) {
          const page = Number(q.page);
          if (!Number.isFinite(page) || page < effStart || page > end || seenQPages.has(page)) continue;
          seenQPages.add(page);
          questionStarts.push({
            page,
            questionText: String(q.questionText || '').trim(),
            year: Number.isFinite(Number(q.year)) ? Number(q.year) : null,
            marks: Number.isFinite(Number(q.marks)) ? Math.floor(Number(q.marks)) : null,
          });
        }

        const aList = Array.isArray(parsed?.answerStarts) ? parsed.answerStarts : [];
        for (const a of aList) {
          const page = Number(a.page);
          if (!Number.isFinite(page) || page < effStart || page > end || seenAPages.has(page)) continue;
          seenAPages.add(page);
          answerStarts.push({
            page,
            name: String(a.name || '').trim() || 'Unknown Topper',
            rank: Number.isFinite(Number(a.rank)) ? Number(a.rank) : null,
            year: Number.isFinite(Number(a.year)) ? Number(a.year) : null,
            marks: String(a.marks || '').trim(),
            source: String(a.source || '').trim(),
          });
        }
        job.chunksCompleted += 1;
      } catch (err) {
        console.error(`[ToppersCopyJob ${jobId}] chunk ${job.currentChunkRange} failed:`, err.message || err);
        job.chunksFailed += 1;
        job.failedChunkRanges.push(job.currentChunkRange);
        if (isQuotaError(err)) {
          // Stop hammering a rate-limited provider — but keep every chunk we DID
          // get. The review UI still opens on the partial result; the admin can
          // commit it and run a follow-up job from the first un-done page.
          quotaAbortedAtPage = effStart;
          await job.save();
          break;
        }
        job.error = `Chunk ${job.currentChunkRange} failed: ${err.message || err}. Other chunks still attempted.`;
      }
      await job.save();

      if (end < totalPages) await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }

    job.detectedTopics = stitchTopics(
      topicStarts, questionStarts, answerStarts, totalPages, job.startingTopic, job.detectedSubject
    );
    job.currentChunkRange = '';
    const topicCount = job.detectedTopics.length;
    if (job.chunksCompleted === 0) {
      job.status = 'error';
      job.error =
        quotaAbortedAtPage != null
          ? `AI rate limit hit before any pages were read. Wait for the quota to reset (or raise AI_INTER_CHUNK_DELAY_MS) and start a fresh job.`
          : job.error || 'No pages could be read from this PDF.';
    } else {
      job.status = 'done';
      if (quotaAbortedAtPage != null) {
        job.error = `Rate limit hit at page ${quotaAbortedAtPage} — read ${job.chunksCompleted}/${job.totalChunks} chunks. Review & commit the ${topicCount} topic(s) found, then run a follow-up job from page ${quotaAbortedAtPage} with that topic as the "starting topic" and Append ticked.`;
      } else if (job.chunksFailed > 0) {
        job.error = `${job.chunksFailed} chunk(s) failed (${job.failedChunkRanges.join(', ')}). Review what was extracted; re-run a job for the failed pages if needed.`;
      }
    }
    await job.save();
  } catch (err) {
    console.error(`[ToppersCopyJob ${jobId}] fatal:`, err);
    job.status = 'error';
    job.error = err.message || 'Compendium ingestion failed';
    await job.save();
  } finally {
    await safeUnlink(job.sourceFilePath);
    job.sourceFilePath = '';
    await job.save().catch(() => {});
  }
};

// Within one topic's page span [lo, hi], turn the ordered question/answer page
// markers into questions[] with nested answers[]. A question runs until the next
// question (or hi); a topper's answer runs until the next answer within the same
// question (or that question's end). If no printed question was detected, fall
// back to one blank question spanning the whole span for the admin to label.
const stitchQuestions = (questionStarts, answerStarts, lo, hi) => {
  const qs = questionStarts.filter((q) => q.page >= lo && q.page <= hi).sort((a, b) => a.page - b.page);
  const as = answerStarts.filter((a) => a.page >= lo && a.page <= hi).sort((a, b) => a.page - b.page);

  const spans = qs.length
    ? qs.map((q, i) => ({ ...q, start: q.page, end: i + 1 < qs.length ? qs[i + 1].page - 1 : hi }))
    : [{ questionText: '', year: null, marks: null, start: lo, end: hi }];

  return spans.map((q) => {
    const mine = as.filter((a) => a.page >= q.start && a.page <= q.end);
    return {
      questionText: q.questionText,
      year: q.year,
      marks: q.marks,
      startPage: q.start,
      endPage: q.end,
      answers: mine.map((a, j) => ({
        name: a.name, rank: a.rank, year: a.year, marks: a.marks, source: a.source,
        startPage: a.page,
        endPage: j + 1 < mine.length ? mine[j + 1].page - 1 : q.end,
      })),
    };
  });
};

// Split the whole PDF into topics at the divider pages, then stitch each topic's
// questions/answers. `startingTopic` (optional) claims the pages before the first
// divider — for a chunk that begins mid-topic, or a PDF with no dividers at all.
const stitchTopics = (topicStarts, questionStarts, answerStarts, totalPages, startingTopic, detectedSubject) => {
  const dividers = [...topicStarts].sort((a, b) => a.page - b.page);

  const markers = [];
  const lead = String(startingTopic || '').trim();
  if (lead && (!dividers.length || dividers[0].page > 1)) {
    markers.push({ page: 1, topic: lead });
  }
  for (const d of dividers) {
    if (!markers.some((m) => m.page === d.page)) markers.push({ page: d.page, topic: d.topic });
  }
  markers.sort((a, b) => a.page - b.page);

  // No dividers and no starting topic: treat the whole PDF as one unnamed topic.
  if (markers.length === 0) {
    markers.push({ page: 1, topic: '' });
  }

  return markers.map((m, i) => {
    const start = m.page;
    const end = i + 1 < markers.length ? markers[i + 1].page - 1 : totalPages;
    return {
      topic: m.topic || (detectedSubject ? `${detectedSubject} — untitled topic ${i + 1}` : `Untitled topic ${i + 1}`),
      startPage: start,
      endPage: end,
      questions: stitchQuestions(questionStarts, answerStarts, start, end),
    };
  });
};

// Normalise one reviewed answer row -> ToppersCopy answer subdoc, or null if invalid.
const cleanAnswer = (a) => {
  const name = String(a.name || '').trim();
  const startPage = Number(a.startPage);
  const endPage = Number(a.endPage);
  if (!name || !Number.isFinite(startPage) || !Number.isFinite(endPage) || endPage < startPage) return null;
  return {
    name,
    rank: Number.isFinite(Number(a.rank)) ? Number(a.rank) : null,
    year: Number.isFinite(Number(a.year)) ? Number(a.year) : null,
    marks: String(a.marks || '').trim(),
    source: String(a.source || '').trim(),
    curatorNote: String(a.curatorNote || '').trim(),
    startPage,
    endPage,
  };
};

// Normalise one reviewed question -> { questionText, year, marks, answers[] }, or
// null if it has no title / no valid answer.
const cleanQuestion = (q) => {
  const questionText = String(q.questionText || '').trim();
  const answers = (Array.isArray(q.answers) ? q.answers : []).map(cleanAnswer).filter(Boolean);
  if (!questionText || answers.length === 0) return null;
  return {
    questionText,
    year: Number.isFinite(Number(q.year)) ? Number(q.year) : null,
    marks: Number.isFinite(Number(q.marks)) ? Math.floor(Number(q.marks)) : null,
    answers,
  };
};

// POST /admin/compendium/:jobId/commit
// Body: { subject, syllabusSection, published, appendToExisting?,
//         topics: [ { topic, questions: [ { questionText, year, marks, answers: [...] } ] } ] }
// Upserts ONE ToppersCopy doc per topic, keyed by (subject, syllabusSection, topic).
// All topics from one job share that job's uploaded PDF (page numbers are absolute
// within it). appendToExisting=true adds each topic's questions to what's already
// there — for a multi-chunk section — and keeps the existing PDF.
export const commitCompendiumJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const job = await ToppersCopyJob.findById(req.params.jobId);
    if (!job || job.kind !== 'compendium') return res.status(404).json({ error: 'Job not found' });

    const {
      subject = job.subject,
      syllabusSection = job.syllabusSection,
      published = false,
      appendToExisting = false,
    } = req.body;

    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const topicRows = Array.isArray(req.body.topics) ? req.body.topics : job.detectedTopics;

    const cleanedTopics = topicRows
      .map((t) => ({
        topic: String(t.topic || '').trim(),
        questions: (Array.isArray(t.questions) ? t.questions : []).map(cleanQuestion).filter(Boolean),
      }))
      .filter((t) => t.topic && t.questions.length > 0);

    if (cleanedTopics.length === 0) {
      return res.status(400).json({ error: 'No topic has a name plus at least one question with a valid answer range.' });
    }

    const saved = [];
    for (let i = 0; i < cleanedTopics.length; i++) {
      const { topic, questions } = cleanedTopics[i];
      const existing = await ToppersCopy.findOne({ subject, syllabusSection, topic });

      const base = appendToExisting && existing ? (existing.questions || []).map((q) => q.toObject()) : [];
      const merged = [...base, ...questions].map((q, idx) => ({ ...q, order: idx }));

      const doc = await ToppersCopy.findOneAndUpdate(
        { subject, syllabusSection, topic },
        {
          subject,
          syllabusSection,
          topic,
          order: existing ? existing.order : i,
          // On append, keep the PDF already attached; otherwise this job's upload.
          pdfKey: appendToExisting && existing ? existing.pdfKey : job.pdfKey,
          pdfPageCount:
            appendToExisting && existing
              ? Math.max(existing.pdfPageCount || 0, job.totalPages)
              : job.totalPages,
          originalFileName: appendToExisting && existing ? existing.originalFileName : job.originalFileName,
          questions: merged,
          published: !!published,
          createdBy: admin._id,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      saved.push({ topic: doc.topic, questions: merged.length, answers: merged.reduce((n, q) => n + q.answers.length, 0) });
    }

    const totalQ = saved.reduce((n, s) => n + s.questions, 0);
    const totalA = saved.reduce((n, s) => n + s.answers, 0);
    res.json({
      message: `Saved ${saved.length} topic(s), ${totalQ} question(s), ${totalA} answer(s): ${saved.map((s) => `"${s.topic}"`).join(', ')}.`,
      saved,
    });
  } catch (err) {
    console.error('commitCompendiumJob error:', err);
    res.status(500).json({ error: err.message || 'Failed to commit' });
  }
};

// ===========================================================================
// ADMIN — PYQ ingestion (cross-subject compilation PDF -> ToppersPyq rows)
// ===========================================================================

// POST /admin/pyq/start   (multipart: pdf, sourceLabel?)
export const startPyqJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'A PDF file is required' });

  try {
    assertAiConfigured();
  } catch (err) {
    await safeUnlink(file.path);
    return res.status(500).json({ error: err.message });
  }

  try {
    const job = await ToppersCopyJob.create({
      kind: 'pyq',
      createdBy: admin._id,
      status: 'pending',
      aiModelLabel: getActiveModelLabel(),
      originalFileName: file.originalname,
      sourceFilePath: file.path,
    });

    processPyqJob(job._id.toString()).catch((err) =>
      console.error(`[ToppersCopyJob ${job._id}] unhandled:`, err)
    );

    res.status(202).json({ jobId: job._id, status: 'pending' });
  } catch (err) {
    await safeUnlink(file.path);
    console.error('startPyqJob error:', err);
    res.status(500).json({ error: err.message || 'Failed to start PYQ job' });
  }
};

// Background worker — extracts question rows from each ~40-page chunk. The PDF is
// digital text, so a text-only PDF chunk is enough for the model.
export const processPyqJob = async (jobId) => {
  const job = await ToppersCopyJob.findById(jobId);
  if (!job) return;

  try {
    const bytes = await fs.readFile(job.sourceFilePath);
    const srcDoc = await PDFDocument.load(bytes);
    const totalPages = srcDoc.getPageCount();

    job.status = 'extracting';
    job.totalPages = totalPages;
    job.totalChunks = Math.ceil(totalPages / PYQ_CHUNK_SIZE);
    await job.save();

    const all = [];
    const seen = new Set();
    let quotaAbortedAtPage = null;

    // Headings run DOWN the page: a question belongs to the last subject / section
    // / topic heading printed above it, which is often on an earlier page — or in
    // an earlier chunk. We thread the "heading in effect" through every chunk and
    // fill blanks as questions stream in, so a topic set once sticks to every
    // question below it until the next heading replaces it.
    const carry = { subject: '', section: '', topic: '' };

    for (let start = 1; start <= totalPages; start += PYQ_CHUNK_SIZE) {
      const end = Math.min(start + PYQ_CHUNK_SIZE - 1, totalPages);
      const effStart = start === 1 ? 1 : Math.max(1, start - CHUNK_OVERLAP);

      job.currentChunkRange = `pages ${effStart}-${end}`;
      await job.save();

      const pdfBase64 = await makeChunkPdfBase64(srcDoc, effStart - 1, end - 1);

      const prompt = `
You are reading pages ${effStart} to ${end} of a compiled UPSC Mains "Previous Year Questions" (PYQ) book. It groups questions by subject (GS-1..GS-4, Essay, or an optional subject), then by a broad section, then by a "topic" heading, optionally then by a fine "microtheme" tag, and lists each question with its exam year and marks. This chunk is NOT the whole book.

IMPORTANT — headings run DOWN the page. A subject / section / topic heading applies to EVERY question printed below it until the next heading of the same level appears. The heading is usually NOT repeated above each question, and it is often on an earlier page. For questions that appear before the first heading in this chunk, use the headings already in effect (given below).

Headings in effect at the start of this chunk (carried from earlier pages):
- subject: ${carry.subject ? `"${carry.subject}"` : '(unknown — read it from the page)'}
- section: ${carry.section ? `"${carry.section}"` : '(unknown — read it from the page)'}
- topic: ${carry.topic ? `"${carry.topic}"` : '(unknown — read it from the page)'}

Extract EVERY distinct question in this chunk, individually, IN THE ORDER THEY APPEAR. For each:
1. "subject": one of "GS-1","GS-2","GS-3","GS-4","Essay", or the optional subject name as printed. Use the running subject heading.
2. "section": the broad section heading in effect for this question (e.g. "Society", "Polity", "Post Independence").
3. "topic": the topic heading in effect for this question (e.g. "Effects of Globalisation on Indian Society", "Federalism", "Modern Indian History"). This is the heading between the section and the individual question. Carry it forward — do not leave it blank just because it is not reprinted next to the question.
4. "microtheme": the fine tag for the question if one is shown, else "".
5. "questionText": the full question text, with any leading numbering removed.
6. "year": the 4-digit exam year printed for the question. If none is identifiable, OMIT that question entirely — do not guess.
7. "marks": the marks as an integer if shown (e.g. 10, 15), else null. (Treat "12.5" as 12 — round down.)

Return strictly a JSON array, in reading order:
[
  { "subject": "string", "section": "string", "topic": "string", "microtheme": "string", "questionText": "string", "year": integer, "marks": integer|null }
]
Return [] if this chunk has no questions.
`.trim();

      try {
        const parsed = await runJsonExtraction({ prompt, pdfBase64 });
        const list = Array.isArray(parsed) ? parsed : [];
        for (const q of list) {
          // Resolve this question's headings against what's carried, then advance
          // the carry. A new subject clears the section+topic below it; a new
          // section clears the topic below it.
          const rawSubject = String(q.subject || '').trim();
          const rawSection = String(q.section || '').trim();
          const rawTopic = String(q.topic || '').trim();
          if (rawSubject && normalizeForDedup(rawSubject) !== normalizeForDedup(carry.subject)) {
            carry.subject = rawSubject;
            carry.section = '';
            carry.topic = '';
          }
          if (rawSection && normalizeForDedup(rawSection) !== normalizeForDedup(carry.section)) {
            carry.section = rawSection;
            carry.topic = '';
          }
          if (rawTopic) carry.topic = rawTopic;

          const subject = rawSubject || carry.subject;
          const section = rawSection || carry.section;
          const topic = rawTopic || carry.topic;

          const year = Number(q.year);
          const questionText = String(q.questionText || '').trim();
          if (!questionText || !Number.isFinite(year) || year < PYQ_MIN_YEAR || year > PYQ_MAX_YEAR) continue;

          const key = `${subject}::${year}::${normalizeForDedup(questionText)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          all.push({
            subject,
            section,
            topic,
            microtheme: String(q.microtheme || '').trim(),
            questionText,
            year,
            marks: Number.isFinite(Number(q.marks)) ? Number(q.marks) : null,
          });
        }
        job.chunksCompleted += 1;
      } catch (err) {
        console.error(`[ToppersCopyJob ${jobId}] chunk ${job.currentChunkRange} failed:`, err.message || err);
        job.chunksFailed += 1;
        job.failedChunkRanges.push(job.currentChunkRange);
        if (isQuotaError(err)) {
          // Stop hammering a rate-limited provider, but keep every row extracted
          // so far — the review UI still opens and the admin can commit them
          // (commit is an additive insert, so a later fresh job just adds more).
          quotaAbortedAtPage = effStart;
          await job.save();
          break;
        }
        job.error = `Chunk ${job.currentChunkRange} failed: ${err.message || err}. Other chunks still attempted.`;
      }

      job.extractedPyqs = all;
      await job.save();

      if (end < totalPages) await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }

    job.currentChunkRange = '';
    if (job.chunksCompleted === 0) {
      job.status = 'error';
      job.error =
        quotaAbortedAtPage != null
          ? 'AI rate limit hit before any pages were read. Wait for the quota to reset and start a fresh job.'
          : job.error || 'No questions could be read from this PDF.';
    } else {
      job.status = 'done';
      if (quotaAbortedAtPage != null) {
        job.error = `Rate limit hit at page ${quotaAbortedAtPage} — read ${job.chunksCompleted}/${job.totalChunks} chunks. Commit the ${all.length} question(s) found, then run another job on the same PDF later (commit is additive, dupes are skipped).`;
      } else if (job.chunksFailed > 0) {
        job.error = `${job.chunksFailed} chunk(s) failed (${job.failedChunkRanges.join(', ')}). Review what was extracted.`;
      }
    }
    await job.save();
  } catch (err) {
    console.error(`[ToppersCopyJob ${jobId}] fatal:`, err);
    job.status = 'error';
    job.error = err.message || 'PYQ extraction failed';
    await job.save();
  } finally {
    await safeUnlink(job.sourceFilePath);
    job.sourceFilePath = '';
    await job.save().catch(() => {});
  }
};

// POST /admin/pyq/:jobId/commit
// Body: { sourceLabel?, pyqs?: [ ...reviewed rows... ] }
// Additive insert into ToppersPyq; duplicates (same subject+year+text) are skipped.
export const commitPyqJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const job = await ToppersCopyJob.findById(req.params.jobId);
    if (!job || job.kind !== 'pyq') return res.status(404).json({ error: 'Job not found' });

    const { sourceLabel = '', pyqs } = req.body;
    const rows = Array.isArray(pyqs) ? pyqs : job.extractedPyqs;

    const docs = [];
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const questionText = String(r.questionText || '').trim();
      const year = Number(r.year);
      const subject = String(r.subject || '').trim();
      if (!questionText || !subject || !Number.isFinite(year) || year < PYQ_MIN_YEAR || year > PYQ_MAX_YEAR) {
        skipped.push({ row: i + 1, reason: 'missing subject / question / valid year' });
        continue;
      }
      docs.push({
        subject,
        section: String(r.section || '').trim(),
        topic: String(r.topic || '').trim(),
        microtheme: String(r.microtheme || '').trim(),
        questionText,
        year,
        marks: Number.isFinite(Number(r.marks)) ? Number(r.marks) : null,
        sourceLabel,
        dedupeKey: pyqDedupeKey(subject, year, questionText),
        createdBy: admin._id,
      });
    }

    // insertMany with ordered:false so unique-index collisions (dupes) are skipped,
    // not fatal. The thrown BulkWriteError still carries the successful count.
    let insertedCount = 0;
    if (docs.length) {
      try {
        const inserted = await ToppersPyq.insertMany(docs, { ordered: false });
        insertedCount = inserted.length;
      } catch (bulkErr) {
        insertedCount = bulkErr.result?.insertedCount ?? bulkErr.insertedDocs?.length ?? 0;
        const dupes = (bulkErr.writeErrors || []).filter((e) => e.code === 11000).length;
        if (dupes) skipped.push({ row: '-', reason: `${dupes} duplicate(s) already in DB` });
      }
    }

    res.json({ message: `Inserted ${insertedCount} PYQ(s).`, insertedCount, skipped });
  } catch (err) {
    console.error('commitPyqJob error:', err);
    res.status(500).json({ error: err.message || 'Failed to commit PYQs' });
  }
};

// ===========================================================================
// ADMIN — committed PYQ browse / edit / delete (ToppersPyq collection)
// ===========================================================================

// GET /admin/pyqs?subject=&year=&q=&limit=&skip=
export const listToppersPyqs = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const { subject = '', year = '', q = '' } = req.query;
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const skip = Math.max(0, Number(req.query.skip) || 0);

    const filter = {};
    if (subject) filter.subject = subject;
    if (year && Number.isFinite(Number(year))) filter.year = Number(year);
    if (q.trim()) {
      const rx = { $regex: escapeRegex(q.trim()), $options: 'i' };
      filter.$or = [{ questionText: rx }, { topic: rx }, { section: rx }, { microtheme: rx }, { sourceLabel: rx }];
    }

    const [pyqs, total, subjects] = await Promise.all([
      ToppersPyq.find(filter).sort({ subject: 1, year: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ToppersPyq.countDocuments(filter),
      ToppersPyq.distinct('subject'),
    ]);

    res.json({ pyqs, total, returned: pyqs.length, skip, limit, subjects: subjects.filter(Boolean).sort() });
  } catch (err) {
    console.error('listToppersPyqs error:', err);
    res.status(500).json({ error: 'Server error listing PYQs' });
  }
};

// PATCH /admin/pyqs/:id   — edit one committed PYQ
export const updateToppersPyq = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const doc = await ToppersPyq.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    if ('subject' in req.body) doc.subject = String(req.body.subject || '').trim();
    if ('section' in req.body) doc.section = String(req.body.section || '').trim();
    if ('topic' in req.body) doc.topic = String(req.body.topic || '').trim();
    if ('microtheme' in req.body) doc.microtheme = String(req.body.microtheme || '').trim();
    if ('sourceLabel' in req.body) doc.sourceLabel = String(req.body.sourceLabel || '').trim();
    if ('questionText' in req.body) doc.questionText = String(req.body.questionText || '').trim();
    if ('year' in req.body) doc.year = Number(req.body.year);
    if ('marks' in req.body) {
      doc.marks = req.body.marks === '' || req.body.marks == null ? null : Number(req.body.marks);
    }

    if (!doc.subject || !doc.questionText || !Number.isFinite(doc.year) || doc.year < PYQ_MIN_YEAR || doc.year > PYQ_MAX_YEAR) {
      return res.status(400).json({ error: 'Subject, question text and a valid year are required.' });
    }

    doc.dedupeKey = pyqDedupeKey(doc.subject, doc.year, doc.questionText);
    try {
      await doc.save();
    } catch (e) {
      if (e.code === 11000) {
        return res.status(409).json({ error: 'Another PYQ with the same subject + year + question already exists.' });
      }
      throw e;
    }
    res.json({ pyq: doc });
  } catch (err) {
    console.error('updateToppersPyq error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
};

// DELETE /admin/pyqs/:id
export const deleteToppersPyq = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const doc = await ToppersPyq.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    console.error('deleteToppersPyq error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
};

// GET /admin/jobs/:jobId  — poll status (both kinds)
export const getJobStatus = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const job = await ToppersCopyJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json({
      jobId: job._id,
      kind: job.kind,
      status: job.status,
      aiModelLabel: job.aiModelLabel,
      totalPages: job.totalPages,
      totalChunks: job.totalChunks,
      chunksCompleted: job.chunksCompleted,
      chunksFailed: job.chunksFailed,
      failedChunkRanges: job.failedChunkRanges,
      currentChunkRange: job.currentChunkRange,
      error: job.error,
      // Inputs / results (returned always so the review UI can populate live)
      subject: job.subject,
      syllabusSection: job.syllabusSection,
      startingTopic: job.startingTopic,
      pdfKey: job.pdfKey,
      detectedSubject: job.detectedSubject,
      detectedTopics: job.detectedTopics,
      pyqsFoundSoFar: job.extractedPyqs.length,
      extractedPyqs: job.status === 'done' ? job.extractedPyqs : undefined,
    });
  } catch (err) {
    console.error('getJobStatus error:', err);
    res.status(500).json({ error: 'Server error fetching job status' });
  }
};

// ===========================================================================
// ADMIN — direct CRUD + AI analysis
// ===========================================================================

// PATCH /admin/:id   — edit questions[], order, published, section/topic, etc.
export const updateToppersCopy = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const allowed = ['subject', 'syllabusSection', 'topic', 'order', 'published', 'questions'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

    const doc = await ToppersCopy.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ toppersCopy: doc });
  } catch (err) {
    console.error('updateToppersCopy error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
};

// DELETE /admin/:id  (leaves the R2 object in place — cheap, and avoids orphaning
// a shared PDF; purge R2 separately if storage matters)
export const deleteToppersCopy = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const doc = await ToppersCopy.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ message: `Deleted "${doc.topic}".` });
  } catch (err) {
    console.error('deleteToppersCopy error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
};

const asStr = (v) => String(v ?? '').trim();
const asArr = (v) => (Array.isArray(v) ? v : []);
const asStrArr = (v) => asArr(v).map(asStr).filter(Boolean);
const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Coerce the model's JSON into the aiAnalysis subdoc shape, tolerating missing /
// malformed fields.
const shapeAnalysis = (parsed) => ({
  modelSkeleton: asStr(parsed.modelSkeleton),
  intros: asArr(parsed.intros).map((x) => ({
    text: asStr(x.text),
    type: asStr(x.type),
    topper: asStr(x.topper),
    curatorNote: asStr(x.curatorNote),
    wordCount: asNum(x.wordCount),
  })).filter((x) => x.text),
  bodyThemes: asArr(parsed.bodyThemes).map((t) => ({
    title: asStr(t.title),
    gloss: asStr(t.gloss),
    points: asArr(t.points).map((p) => ({
      text: asStr(p.text),
      example: asStr(p.example),
      toppers: asStrArr(p.toppers),
    })).filter((p) => p.text),
  })).filter((t) => t.title && t.points.length),
  conclusions: asArr(parsed.conclusions).map((x) => ({
    text: asStr(x.text),
    type: asStr(x.type),
    topper: asStr(x.topper),
    wordCount: asNum(x.wordCount),
  })).filter((x) => x.text),
  keywords: asStrArr(parsed.keywords),
  techniques: asStrArr(parsed.techniques),
  diagrams: asArr(parsed.diagrams).map((d) => ({
    topper: asStr(d.topper),
    description: asStr(d.description),
    mermaid: asStr(d.mermaid),
  })).filter((d) => d.description || d.mermaid),
  aiModel: getActiveModelLabel(),
  generatedAt: new Date(),
});

// POST /admin/:id/questions/:qid/analyze  — (re)generate the AI analysis for ONE
// question: slice that question's answer pages out of the compendium PDF and ask
// the active provider for an annotation-style teardown of the 2-3 curated copies.
export const analyzeQuestion = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    assertAiConfigured();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const doc = await ToppersCopy.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.pdfKey?.startsWith('r2://')) {
      return res.status(400).json({ error: 'This topic has no source PDF to analyze' });
    }

    const question = doc.questions.id(req.params.qid);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    if (!question.answers?.length) {
      return res.status(400).json({ error: 'This question has no answer page ranges to analyze' });
    }

    // Pull the compendium PDF from R2, then slice out just this question's span.
    const r2Key = doc.pdfKey.replace('r2://', '');
    const obj = await r2Client.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key })
    );
    const pdfBuf = Buffer.from(await obj.Body.transformToByteArray());
    const srcDoc = await PDFDocument.load(pdfBuf);
    const pageCount = srcDoc.getPageCount();

    const spanStart = Math.max(1, Math.min(...question.answers.map((a) => a.startPage)));
    const spanEnd = Math.min(pageCount, Math.max(...question.answers.map((a) => a.endPage)));
    const pdfBase64 = await makeChunkPdfBase64(srcDoc, spanStart - 1, spanEnd - 1);

    // Answer page ranges re-based to the sliced PDF (page 1 == spanStart).
    const answerLines = question.answers
      .map((a) => {
        const s = a.startPage - spanStart + 1;
        const e = a.endPage - spanStart + 1;
        const who = `${a.name}${a.rank ? ` (AIR ${a.rank}${a.year ? `, ${a.year}` : ''})` : ''}${a.marks ? `, ${a.marks} marks` : ''}`;
        const note = a.curatorNote ? `\n   Curator note: ${a.curatorNote}` : '';
        return `- ${who} — pages ${s}-${e}.${note}`;
      })
      .join('\n');

    const prompt = `
You are a senior UPSC Mains mentor doing a close teardown of a SMALL SET of hand-picked topper answers (usually 2-3) to ONE question. These copies were curated for quality — your job is to ANNOTATE what makes them good and pull out transferable technique, NOT to find majority consensus or vote.

QUESTION
Subject: ${doc.subject}
Topic: ${doc.topic}
Question: ${question.questionText || '(read it from the first page of the PDF)'}
${question.marks ? `Marks: ${question.marks}` : ''}

ANSWERS IN THE ATTACHED PDF (page numbers are within THIS PDF, which starts at page 1):
${answerLines}

Read every page. Work only from what is actually written in these copies — do not add facts, examples or data that no topper wrote. If handwriting is unclear on a name or figure, transcribe your best reading; never invent one.

Produce a study breakdown for an aspirant about to write THIS question.

Return ONE JSON object, no markdown fences, exactly this shape:

{
  "modelSkeleton": "approx 150 words. The ideal answer's shape for this question: what the intro should do, how to split the body (name the 3-5 headings), what the conclusion should land. Written as guidance, not a full answer.",
  "intros": [
    { "text": "the topper's actual opening, lightly cleaned to readable prose", "type": "definition | context | data | quote | anecdote", "topper": "Kunal Rastogi, AIR 16", "curatorNote": "copy the curator note for this topper, else \\"\\"", "wordCount": 34 }
  ],
  "bodyThemes": [
    { "title": "Territorial extent and administration", "gloss": "one line: what this theme covers and why it earns marks",
      "points": [ { "text": "the point, with the load-bearing phrase kept prominent", "example": "the specific edict / place / person / data the topper cited, else \\"\\"", "toppers": ["Kunal Rastogi"] } ] }
  ],
  "conclusions": [
    { "text": "the topper's actual closing, lightly cleaned", "type": "summary | wayforward | balanced | quote", "topper": "Harshita Goyal, AIR 2", "wordCount": 22 }
  ],
  "keywords": ["8-15 high-value terms, names, reports, edicts, data points the toppers actually used"],
  "techniques": ["4-7 transferable 'how to write' lessons a student can apply to OTHER questions too"],
  "diagrams": [
    { "topper": "Kunal Rastogi", "description": "plain-text description of the diagram this topper drew and what it communicates", "mermaid": "valid Mermaid (flowchart/mindmap/graph) IF the diagram maps cleanly to one, else \\"\\"" }
  ]
}

Rules:
- 2-3 copies only: annotate each, don't average them.
- intros[] and conclusions[] = one entry PER topper (their real opening/closing).
- Every bodyThemes point must name which topper(s) made it in "toppers".
- Cluster ALL the body points across the copies into 3-6 themes.
- No content that isn't in the copies. Approximate word counts are fine.
`.trim();

    const parsed = await runJsonExtraction({ prompt, pdfBase64, maxOutputTokens: 8000 });

    question.aiAnalysis = shapeAnalysis(parsed || {});
    doc.markModified('questions');
    await doc.save();

    res.json({ message: 'Analysis generated.', aiAnalysis: question.aiAnalysis });
  } catch (err) {
    console.error('analyzeQuestion error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
};

// ===========================================================================
// STUDENT / ADMIN — read + stream
// ===========================================================================

const isAdminReq = async (req) => {
  // requireAdmin writes the response on failure; here we just want a boolean and
  // must not touch res. Re-implement the light check.
  try {
    const { default: User } = await import('../models/User.js');
    const user = await User.findById(req.userId);
    const admins = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
      .filter(Boolean)
      .map((e) => e.toLowerCase());
    return !!user && admins.includes((user.email || '').toLowerCase());
  } catch {
    return false;
  }
};

// GET /subjects  — list of subjects that have at least one published topic (admins see all)
export const listSubjects = async (req, res) => {
  try {
    const filter = (await isAdminReq(req)) ? {} : { published: true };
    const rows = await ToppersCopy.aggregate([
      { $match: filter },
      { $group: { _id: '$subject', topicCount: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ subjects: rows.map((r) => ({ subject: r._id, topicCount: r.topicCount })) });
  } catch (err) {
    console.error('listSubjects error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /topics?subject=GS-1
export const listTopics = async (req, res) => {
  try {
    const { subject } = req.query;
    if (!subject) return res.status(400).json({ error: 'subject query param is required' });

    const filter = { subject };
    if (!(await isAdminReq(req))) filter.published = true;

    const docs = await ToppersCopy.find(filter)
      .sort({ order: 1, topic: 1 })
      .select('subject syllabusSection topic order published pdfPageCount questions')
      .lean();

    res.json({
      topics: docs.map((d) => {
        const questions = d.questions || [];
        const answerCount = questions.reduce((n, q) => n + (q.answers?.length || 0), 0);
        const analyzedCount = questions.filter((q) => q.aiAnalysis?.generatedAt).length;
        return {
          _id: d._id,
          subject: d.subject,
          syllabusSection: d.syllabusSection,
          topic: d.topic,
          order: d.order,
          published: d.published,
          pdfPageCount: d.pdfPageCount,
          questionCount: questions.length,
          answerCount,
          analyzedCount,
          hasAnalysis: analyzedCount > 0,
        };
      }),
    });
  } catch (err) {
    console.error('listTopics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /:id  — one topic: its questions[] (each with answers[] + per-question
// analysis), plus related PYQs matched by topic.
export const getToppersCopy = async (req, res) => {
  try {
    const doc = await ToppersCopy.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.published && !(await isAdminReq(req))) {
      return res.status(403).json({ error: 'Not available' });
    }

    // PYQs for this topic: match on section, fall back to subject-wide.
    const norm = normalizeForDedup;
    const subjectPyqs = await ToppersPyq.find({ subject: doc.subject }).sort({ year: -1 }).lean();
    const docTopic = norm(doc.topic);
    const topicPyqs = subjectPyqs.filter((q) => {
      const qt = norm(q.topic);
      return (
        (docTopic && qt && (qt === docTopic || qt.includes(docTopic) || docTopic.includes(qt))) ||
        (doc.syllabusSection && norm(q.section) === norm(doc.syllabusSection)) ||
        (docTopic && q.microtheme && docTopic.includes(norm(q.microtheme)))
      );
    });

    const questions = (doc.questions || [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((q) => ({
        _id: q._id,
        questionText: q.questionText,
        year: q.year,
        marks: q.marks,
        answers: (q.answers || []).map((a) => ({
          name: a.name,
          rank: a.rank,
          year: a.year,
          marks: a.marks,
          source: a.source,
          curatorNote: a.curatorNote,
          startPage: a.startPage,
          endPage: a.endPage,
        })),
        aiAnalysis: q.aiAnalysis?.generatedAt ? q.aiAnalysis : null,
      }));

    res.json({
      toppersCopy: {
        _id: doc._id,
        subject: doc.subject,
        syllabusSection: doc.syllabusSection,
        topic: doc.topic,
        pdfPageCount: doc.pdfPageCount,
        published: doc.published,
        questions,
      },
      relatedPyqs: (topicPyqs.length ? topicPyqs : []).map((q) => ({
        questionText: q.questionText,
        year: q.year,
        marks: q.marks,
        section: q.section,
        topic: q.topic,
        microtheme: q.microtheme,
      })),
    });
  } catch (err) {
    console.error('getToppersCopy error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /:id/pdf  — Range-aware stream of the compendium PDF straight from R2.
// Served inline so it renders in an <iframe>/pdf.js without a download prompt.
// (Same technique as courseController.js getRawCoursePdf.)
export const streamToppersCopyPdf = async (req, res) => {
  try {
    const doc = await ToppersCopy.findById(req.params.id).select('pdfKey published').lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.published && !(await isAdminReq(req))) return res.status(403).json({ error: 'Not available' });
    if (!doc.pdfKey?.startsWith('r2://')) return res.status(404).json({ error: 'No PDF for this topic' });

    const r2Key = doc.pdfKey.replace('r2://', '');
    const rangeHeader = req.headers.range;

    const params = { Bucket: process.env.R2_BUCKET_NAME, Key: r2Key };
    if (rangeHeader) params.Range = rangeHeader;

    const r2Response = await r2Client.send(new GetObjectCommand(params));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    if (r2Response.ContentLength != null) res.setHeader('Content-Length', r2Response.ContentLength);
    if (rangeHeader && r2Response.ContentRange) {
      res.status(206);
      res.setHeader('Content-Range', r2Response.ContentRange);
    }
    r2Response.Body.pipe(res);
  } catch (err) {
    console.error('streamToppersCopyPdf error:', err);
    res.status(500).json({ error: 'Server error streaming PDF' });
  }
};
