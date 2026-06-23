import fs from "fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PDFDocument } from "pdf-lib";
import Course from "../models/Course.js";
import Topic from "../models/Topic.js";
import ProgressPyq from "../models/ProgressPyq.js";
import ExtractionJob from "../models/ExtractionJob.js";
import PyqExtractionJob from "../models/PyqExtractionJob.js";
import {
  requireAdmin,
  upsertTopicsAndQuestions,
} from "./progressController.js";

const GEMINI_MODEL = "gemini-3.5-flash";
const CHUNK_SIZE = 100;
const CHUNK_OVERLAP = 5;
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 3000;
const INTER_CHUNK_DELAY_MS = 2500;

const callGeminiWithRetry = async (model, prompt, pdfPart) => {
  let delayMs = INITIAL_DELAY_MS;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await model.generateContent([prompt, pdfPart]);
      return response.response.text();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(
        `[Extraction] Gemini call failed (attempt ${attempt}/${MAX_RETRIES}):`,
        err.message || err,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
};

const makeChunkPdfBase64 = async (pdfDoc, startPageIdx0, endPageIdx0) => {
  const chunkDoc = await PDFDocument.create();
  const pageIndices = [];
  for (let p = startPageIdx0; p <= endPageIdx0; p++) pageIndices.push(p);
  const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
  copiedPages.forEach((p) => chunkDoc.addPage(p));
  const bytes = await chunkDoc.save();
  return Buffer.from(bytes).toString("base64");
};

const findSuggestedTopic = (pageNumber, topicRanges) => {
  const match = topicRanges.find(
    (t) => pageNumber >= t.startPage && pageNumber <= t.endPage,
  );
  return match ? match.name : null;
};

// Start a new extraction job (Admin only). Multipart: courseId, fileIndex, pdf file.
export const startExtractionJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId } = req.body;
  const fileIndex = Number(req.body.fileIndex) || 0;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "PDF file is required" });
  if (!courseId) return res.status(400).json({ error: "courseId is required" });

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const fileCount = course.fileUrls?.length > 0 ? course.fileUrls.length : 1;
    if (fileIndex < 0 || fileIndex >= fileCount) {
      return res
        .status(400)
        .json({ error: "Invalid fileIndex for this course" });
    }

    const job = await ExtractionJob.create({
      course: course._id,
      fileIndex,
      createdBy: admin._id,
      status: "pending",
      sourceFilePath: file.path,
    });

    // Fire-and-forget: do not await. The admin polls /status instead of blocking on this request.
    processExtractionJob(job._id.toString()).catch((err) => {
      console.error(`[ExtractionJob ${job._id}] Unhandled error:`, err);
    });

    res.status(202).json({ jobId: job._id, status: "pending" });
  } catch (err) {
    console.error("Error starting extraction job:", err);
    res
      .status(500)
      .json({ error: err.message || "Server error starting extraction job" });
  }
};

// Poll the status of an extraction job (Admin only).
export const getExtractionJobStatus = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const job = await ExtractionJob.findById(req.params.jobId);
    if (!job)
      return res.status(404).json({ error: "Extraction job not found" });

    res.json({
      jobId: job._id,
      status: job.status,
      totalPages: job.totalPages,
      totalChunks: job.totalChunks,
      chunksCompleted: job.chunksCompleted,
      chunksFailed: job.chunksFailed,
      failedChunkRanges: job.failedChunkRanges,
      currentChunkRange: job.currentChunkRange,
      questionsFoundSoFar: job.extractedQuestions.length,
      extractedTopicsFromIndex: job.extractedTopicsFromIndex,
      extractedQuestions:
        job.status === "done" ? job.extractedQuestions : undefined,
      error: job.error,
    });
  } catch (err) {
    console.error("Error fetching extraction job status:", err);
    res.status(500).json({ error: "Server error fetching job status" });
  }
};

// Background worker — not a request handler. Processes the uploaded PDF in two passes:
// (1) extract the topic index/TOC, (2) extract per-page question headers in overlapping chunks.
export const processExtractionJob = async (jobId) => {
  const job = await ExtractionJob.findById(jobId);
  if (!job) return;

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      throw new Error("Gemini API key is not configured in backend .env");
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: "application/json" },
    });

    const pdfBytes = await fs.readFile(job.sourceFilePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    job.totalPages = totalPages;
    job.status = "extracting_index";
    await job.save();

    // ---------- PASS 1: index/table-of-contents extraction ----------
    const indexPagesToScan = Math.min(25, totalPages);
    const indexBase64 = await makeChunkPdfBase64(
      pdfDoc,
      0,
      indexPagesToScan - 1,
    );
    const indexPdfPart = {
      inlineData: { data: indexBase64, mimeType: "application/pdf" },
    };

    const indexPrompt = `
You are analyzing the first ${indexPagesToScan} pages of a compiled exam answer-copy PDF for an index/table-of-contents.
These pages may include an index page (sometimes titled "Index", "Contents", or similar) that lists topic/section names together with page numbers.

The index may be NESTED: a numbered main topic (e.g. "9. System of Kinship") followed by lettered sub-items (e.g. "a) Family, household, marriage", "b) Types and forms of family"), where the PAGE NUMBER or page RANGE is often printed only next to each sub-item, not next to the main topic heading itself.

Instructions:
1. Locate the index/table-of-contents page(s) only. Ignore all other content (cover pages, instructions, handwritten content).
2. Extract ONE entry per line that has an explicit page number or page range printed next to it. If that line is a lettered sub-item under a numbered main topic, name the entry "<main topic text> - <sub-item text>" (e.g. "9. System of Kinship - a) Family, household, marriage") so it stays self-describing.
3. If a main topic heading itself has its own page number printed directly next to it, extract it as its own entry using just its own name.
4. For each entry, extract the exact page number(s) printed next to it. If a RANGE is printed (e.g. "850-859"), extract both numbers as startPage and endPage. If only a single page number is printed, extract it as startPage and leave endPage null.
5. If no index page exists in this excerpt, return an empty array.
6. Do not guess any page number or range — only extract numbers explicitly printed next to each entry.

Return strictly as a JSON array, ordered as listed in the index:
[
  { "topicName": "string, exact entry name as printed (combined with its parent topic name if it is a sub-item)", "startPage": integer, "endPage": integer or null (only when an explicit end-of-range page is printed next to this entry) }
]
`;

    let topicStarts = [];
    try {
      const indexResponseText = await callGeminiWithRetry(
        model,
        indexPrompt,
        indexPdfPart,
      );
      const parsed = JSON.parse(indexResponseText.trim());
      if (Array.isArray(parsed)) {
        topicStarts = parsed
          .filter(
            (t) => t && t.topicName && Number.isFinite(Number(t.startPage)),
          )
          .map((t) => ({
            topicName: String(t.topicName).trim(),
            startPage: Number(t.startPage),
            endPage: Number.isFinite(Number(t.endPage))
              ? Number(t.endPage)
              : null,
          }));
      }
    } catch (err) {
      console.error(
        `[ExtractionJob ${jobId}] Index extraction failed (continuing without topic suggestions):`,
        err.message || err,
      );
    }

    topicStarts.sort((a, b) => a.startPage - b.startPage);
    const extractedTopicsFromIndex = topicStarts.map((t, idx) => ({
      name: t.topicName,
      startPage: t.startPage,
      endPage:
        t.endPage !== null
          ? t.endPage
          : idx + 1 < topicStarts.length
            ? topicStarts[idx + 1].startPage - 1
            : totalPages,
    }));

    job.extractedTopicsFromIndex = extractedTopicsFromIndex;
    job.status = "extracting_questions";
    job.totalChunks = Math.ceil(totalPages / CHUNK_SIZE);
    await job.save();

    // ---------- PASS 2: question extraction in overlapping chunks ----------
    const allQuestions = [];
    const seenStartPages = new Set();

    let chunkIndex = 0;
    for (let startPage = 1; startPage <= totalPages; startPage += CHUNK_SIZE) {
      chunkIndex += 1;
      const endPage = Math.min(startPage + CHUNK_SIZE - 1, totalPages);
      const effectiveStartPage =
        startPage === 1 ? 1 : Math.max(1, startPage - CHUNK_OVERLAP);
      const overlapPageCount =
        startPage === 1 ? 0 : startPage - effectiveStartPage;

      job.currentChunkRange = `pages ${effectiveStartPage}-${endPage}`;
      await job.save();

      const chunkBase64 = await makeChunkPdfBase64(
        pdfDoc,
        effectiveStartPage - 1,
        endPage - 1,
      );
      const pdfPart = {
        inlineData: { data: chunkBase64, mimeType: "application/pdf" },
      };

      const questionPrompt = `
You are an expert exam-answer-booklet analyzer. This PDF chunk contains pages ${effectiveStartPage} to ${endPage} of a much larger compiled answer-copy document (this chunk is NOT the whole document).

Each page may contain a HANDWRITTEN answer (ignore all handwritten content completely — it is irrelevant).

Many pages also have a PRINTED/TYPED "branding strip" near the very top, usually highlighted or colored, containing some combination of: a candidate's name, an exam rank (e.g. "AIR-161"), an exam year, a subject/paper code (e.g. "Sociology - 309"), a coaching-institute logo or watermark, and/or an instructional note such as "(Don't Write anything in this Area)". This branding strip is page-identification metadata added by whoever compiled the booklet — it is NEVER the question header, even when it restates the current question's text for the reader's convenience. CRITICALLY: this branding strip, including any restated question text inside it, can appear IDENTICALLY on every page of a multi-page answer, not just the page where the question starts. You must completely ignore this branding strip when deciding whether a new question starts on a page.

The ONLY reliable signal that a NEW question starts on a page is an OFFICIAL numbered question block: a question-number label (e.g. "Q.3) (a)", "Q5)", "5.") immediately followed by the actual question text, typically also followed by a marks indicator like "(10 marks)" or "(20 marks)". This official block sits within the original scanned answer-sheet area, below any branding strip.

Critical rule about multi-page answers:
- A single question's handwritten answer can span MULTIPLE consecutive pages.
- The official numbered question block appears ONLY on the page where that question STARTS.
- Every subsequent page, until a new official numbered question block appears, is a CONTINUATION of the same question's answer and must be IGNORED — do not emit an entry for it, even if its branding strip restates the same question text, and even if it has page furniture (page numbers, margins, topper info strips, etc.) that looks similar to a question page.
- Only emit one entry per question, on the exact page where its official numbered question block first appears.

Critical rule about this being a chunk, not the whole document:
- This chunk starts at absolute page ${effectiveStartPage}, NOT page 1 of the document.
${
  overlapPageCount > 0
    ? `- The first ${overlapPageCount} pages of this chunk (absolute pages ${effectiveStartPage}-${startPage - 1}) are OVERLAP pages already analyzed in the previous chunk. Still analyze them and report any official numbered question block you find on them (so duplicates can be removed downstream) — do not skip them, but do not assume the very first page of this chunk is automatically a new question just because it is the first page you are seeing.`
    : "- This is the first chunk of the document, starting at page 1."
}
- Do NOT assume any page is a new question's start merely because it is the first page of this excerpt, or because its branding strip shows question-like text. Base your decision only on whether an OFFICIAL numbered question block (number + text, usually + marks) is printed on that specific page, separate from any branding strip.

For each page in this chunk (absolute page numbers ${effectiveStartPage} to ${endPage}):
1. Determine if an OFFICIAL numbered question block begins on this page (ignore the branding strip entirely; ignore handwritten text; strip numbering prefixes like "Q5)", "5.", "(a)" from the extracted text).
2. If yes, extract the full official question text (prefix removed, branding-strip text excluded).
3. If no official numbered question block begins on this page (i.e. it is a continuation page, even if the branding strip shows question-like text), do NOT include it in the output.

Return strictly as a JSON array, one entry per page that STARTS a new question:
[
  { "pageNumber": integer (absolute page number in the original document, between ${effectiveStartPage} and ${endPage}), "questionText": "string, cleaned official question text" }
]
If no new questions start in this chunk, return an empty array.
`;

      let chunkQuestions = [];
      let chunkSucceeded = false;
      let quotaExceeded = false;
      try {
        const responseText = await callGeminiWithRetry(
          model,
          questionPrompt,
          pdfPart,
        );
        const parsed = JSON.parse(responseText.trim());
        if (Array.isArray(parsed)) {
          chunkQuestions = parsed.filter(
            (q) =>
              q &&
              q.questionText &&
              Number.isFinite(Number(q.pageNumber)) &&
              Number(q.pageNumber) >= effectiveStartPage &&
              Number(q.pageNumber) <= endPage,
          );
        }
        chunkSucceeded = true;
      } catch (err) {
        const message = err.message || String(err);
        console.error(
          `[ExtractionJob ${jobId}] Chunk ${chunkIndex} (pages ${effectiveStartPage}-${endPage}) failed:`,
          message,
        );
        quotaExceeded = /quota|429|too many requests/i.test(message);
        job.chunksFailed += 1;
        job.failedChunkRanges.push(`pages ${effectiveStartPage}-${endPage}`);
        job.error = quotaExceeded
          ? `Stopped at chunk ${chunkIndex} of ${job.totalChunks} (pages ${effectiveStartPage}-${endPage}): Gemini API quota exceeded. This document needs ~${job.totalChunks + 1} Gemini calls (1 index pass + ${job.totalChunks} chunks) and your API key ran out of quota first (Google reports this as a free-tier daily limit). ${job.chunksCompleted} of ${job.totalChunks} chunks were analyzed before this happened; the rest were NOT analyzed. Fix your API key's billing/quota, then start a fresh extraction.`
          : `Chunk ${chunkIndex} (pages ${effectiveStartPage}-${endPage}) failed: ${message}. Other chunks were still attempted; you may review partial results or start over.`;
      }

      for (const q of chunkQuestions) {
        const pageNum = Number(q.pageNumber);
        if (seenStartPages.has(pageNum)) continue;
        seenStartPages.add(pageNum);
        allQuestions.push({
          pageNumber: pageNum,
          questionText: String(q.questionText).trim(),
        });
      }

      allQuestions.sort((a, b) => a.pageNumber - b.pageNumber);
      job.extractedQuestions = allQuestions.map((q) => ({
        ...q,
        suggestedTopicName: findSuggestedTopic(
          q.pageNumber,
          extractedTopicsFromIndex,
        ),
      }));
      if (chunkSucceeded) job.chunksCompleted += 1;
      await job.save();

      if (quotaExceeded) {
        job.status = "error";
        await job.save();
        break; // further chunks would just fail the same way - stop burning retries/time.
      }

      if (chunkIndex < job.totalChunks) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
      }
    }

    if (job.status !== "error") {
      job.status = "done";
      job.currentChunkRange = "";
      await job.save();
    }
  } catch (err) {
    console.error(`[ExtractionJob ${jobId}] Fatal error:`, err);
    job.status = "error";
    job.error = err.message || "Extraction failed";
    await job.save();
  } finally {
    if (job.sourceFilePath) {
      await fs.unlink(job.sourceFilePath).catch(() => {});
    }
  }
};

// Commit reviewed extraction results into real Topic/ProgressQuestion documents (Admin only).
export const bulkCreateTopicQuestions = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId, fileIndex, questions } = req.body;
  if (!courseId) return res.status(400).json({ error: "courseId is required" });
  if (!Array.isArray(questions) || questions.length === 0) {
    return res
      .status(400)
      .json({ error: "questions array is required and must be non-empty" });
  }

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const fileIdxNum = Number(fileIndex) || 0;
    const fileCount = course.fileUrls?.length > 0 ? course.fileUrls.length : 1;
    if (fileIdxNum < 0 || fileIdxNum >= fileCount) {
      return res
        .status(400)
        .json({ error: "Invalid fileIndex for this course" });
    }

    const rows = questions.map((q) => ({
      topicName: (q.topicName || "").trim(),
      questionText: (q.questionText || "").trim(),
      pageNumber: q.pageNumber,
      tag: "",
    }));

    const result = await upsertTopicsAndQuestions(course, fileIdxNum, rows);

    res.json({
      message: `Added ${result.insertedCount} new question(s) across ${result.touchedTopicCount} topic(s) (${result.newTopicsCount} new topic(s) created).`,
      insertedCount: result.insertedCount,
      newTopicsCount: result.newTopicsCount,
      skippedRows: result.skippedRows,
    });
  } catch (err) {
    console.error("Error bulk-creating topics/questions:", err);
    res
      .status(500)
      .json({ error: err.message || "Server error saving questions" });
  }
};

// ================= Gemini-powered PYQ extraction (course+file scoped, no index pass) =================

const PYQ_MIN_YEAR = 2001;
const PYQ_MAX_YEAR = 2025;

// Start a new PYQ extraction job (Admin only). Multipart: courseId, fileIndex, pdf file.
export const startPyqExtractionJob = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId } = req.body;
  const fileIndex = Number(req.body.fileIndex) || 0;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "PDF file is required" });
  if (!courseId) return res.status(400).json({ error: "courseId is required" });

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const fileCount = course.fileUrls?.length > 0 ? course.fileUrls.length : 1;
    if (fileIndex < 0 || fileIndex >= fileCount) {
      return res
        .status(400)
        .json({ error: "Invalid fileIndex for this course" });
    }

    // Fetch the existing Topic names for this course+file BEFORE starting the job - this is
    // the fixed classification vocabulary handed to every chunk prompt. Plain Mongo query,
    // no Gemini call (unlike the index/TOC pass in the question-extraction flow above).
    const topics = await Topic.find({ course: course._id, fileIndex }).sort({
      order: 1,
    });
    if (topics.length === 0) {
      return res.status(400).json({
        error:
          "This course+file has no existing topics. Upload/extract Topics & Questions for it first.",
      });
    }
    const topicNames = topics.map((t) => t.name);

    const job = await PyqExtractionJob.create({
      course: course._id,
      fileIndex,
      createdBy: admin._id,
      status: "pending",
      sourceFilePath: file.path,
      topicNames,
    });

    processPyqExtractionJob(job._id.toString()).catch((err) => {
      console.error(`[PyqExtractionJob ${job._id}] Unhandled error:`, err);
    });

    res.status(202).json({ jobId: job._id, status: "pending" });
  } catch (err) {
    console.error("Error starting PYQ extraction job:", err);
    res.status(500).json({
      error: err.message || "Server error starting PYQ extraction job",
    });
  }
};

// Poll the status of a PYQ extraction job (Admin only).
export const getPyqExtractionJobStatus = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const job = await PyqExtractionJob.findById(req.params.jobId);
    if (!job)
      return res.status(404).json({ error: "PYQ extraction job not found" });

    res.json({
      jobId: job._id,
      status: job.status,
      totalPages: job.totalPages,
      totalChunks: job.totalChunks,
      chunksCompleted: job.chunksCompleted,
      chunksFailed: job.chunksFailed,
      failedChunkRanges: job.failedChunkRanges,
      currentChunkRange: job.currentChunkRange,
      pyqsFoundSoFar: job.extractedPyqs.length,
      extractedPyqs: job.status === "done" ? job.extractedPyqs : undefined,
      error: job.error,
    });
  } catch (err) {
    console.error("Error fetching PYQ extraction job status:", err);
    res.status(500).json({ error: "Server error fetching job status" });
  }
};

// Background worker - not a request handler. No index/TOC pass (a PYQ compilation has no
// per-topic page index); instead classifies each extracted PYQ against the fixed topicNames
// vocabulary fetched before the job started.
export const processPyqExtractionJob = async (jobId) => {
  const job = await PyqExtractionJob.findById(jobId);
  if (!job) return;

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      throw new Error("Gemini API key is not configured in backend .env");
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: "application/json" },
    });

    const pdfBytes = await fs.readFile(job.sourceFilePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    job.totalPages = totalPages;
    job.status = "extracting_pyqs";
    job.totalChunks = Math.ceil(totalPages / CHUNK_SIZE);
    await job.save();

    const topicListForPrompt = job.topicNames
      .map((n, i) => `${i + 1}. ${n}`)
      .join("\n");

    const allPyqs = [];
    // Dedup key is pageNumber + normalized questionText, NOT pageNumber alone - a PYQ
    // compilation can legitimately have multiple distinct questions on one page (unlike the
    // answer-booklet extraction above, where at most one new question starts per page).
    const seenKeys = new Set();
    const normalizeForDedup = (text) =>
      text.trim().toLowerCase().replace(/\s+/g, " ");

    let chunkIndex = 0;
    for (let startPage = 1; startPage <= totalPages; startPage += CHUNK_SIZE) {
      chunkIndex += 1;
      const endPage = Math.min(startPage + CHUNK_SIZE - 1, totalPages);
      const effectiveStartPage =
        startPage === 1 ? 1 : Math.max(1, startPage - CHUNK_OVERLAP);
      const overlapPageCount =
        startPage === 1 ? 0 : startPage - effectiveStartPage;

      job.currentChunkRange = `pages ${effectiveStartPage}-${endPage}`;
      await job.save();

      const chunkBase64 = await makeChunkPdfBase64(
        pdfDoc,
        effectiveStartPage - 1,
        endPage - 1,
      );
      const pdfPart = {
        inlineData: { data: chunkBase64, mimeType: "application/pdf" },
      };

      const pyqPrompt = `
You are analyzing pages ${effectiveStartPage} to ${endPage} of a much larger compiled "Previous Year Questions" (PYQ) PDF spanning many exam years (this chunk is NOT the whole document).

This PDF is a plain compilation of exam questions as printed across years - it is NOT an answer-copy, there is no handwriting to ignore. Multiple distinct questions can appear on the SAME page (e.g. a page may list several years' questions on one topic, or several questions from one year). Extract EVERY distinct question you find, individually.

${
  overlapPageCount > 0
    ? `The first ${overlapPageCount} pages of this chunk (absolute pages ${effectiveStartPage}-${startPage - 1}) are OVERLAP pages already analyzed in the previous chunk. Still extract every question on them (duplicates will be removed downstream automatically) - do not skip them.`
    : "This is the first chunk of the document, starting at page 1."
}

For each distinct question found, extract:
1. "year": the 4-digit exam year printed for that question (e.g. from a header like "UPSC 2014" or "(2009)"). If no year is identifiable for a question, omit that question entirely - do not guess.
2. "questionText": the full question text, with any numbering prefix (e.g. "Q5)", "5.") stripped.
3. "pageNumber": the absolute page number (between ${effectiveStartPage} and ${endPage}) where this question appears.
4. "suggestedTag": classify this question into the SINGLE existing topic name below that fits BEST. Always pick one, even if the fit is imperfect — never return null and never leave it unclassified. Do not invent new topic names; it must be an exact match to one of the names listed.
Topics:
${topicListForPrompt}

Return strictly as a JSON array:
[
  { "year": integer, "questionText": "string", "pageNumber": integer (between ${effectiveStartPage} and ${endPage}), "suggestedTag": "string (exact match to one of the topic names above - always pick the closest one, never null)" }
]
If no questions are found in this chunk, return an empty array.
`;

      let chunkPyqs = [];
      let chunkSucceeded = false;
      let quotaExceeded = false;
      try {
        const responseText = await callGeminiWithRetry(
          model,
          pyqPrompt,
          pdfPart,
        );
        const parsed = JSON.parse(responseText.trim());
        if (Array.isArray(parsed)) {
          chunkPyqs = parsed.filter(
            (q) =>
              q &&
              q.questionText &&
              Number.isFinite(Number(q.pageNumber)) &&
              Number.isFinite(Number(q.year)) &&
              Number(q.pageNumber) >= effectiveStartPage &&
              Number(q.pageNumber) <= endPage,
          );
        }
        chunkSucceeded = true;
      } catch (err) {
        const message = err.message || String(err);
        console.error(
          `[PyqExtractionJob ${jobId}] Chunk ${chunkIndex} (pages ${effectiveStartPage}-${endPage}) failed:`,
          message,
        );
        quotaExceeded = /quota|429|too many requests/i.test(message);
        job.chunksFailed += 1;
        job.failedChunkRanges.push(`pages ${effectiveStartPage}-${endPage}`);
        job.error = quotaExceeded
          ? `Stopped at chunk ${chunkIndex} of ${job.totalChunks} (pages ${effectiveStartPage}-${endPage}): Gemini API quota exceeded. ${job.chunksCompleted} of ${job.totalChunks} chunks were analyzed before this happened; the rest were NOT analyzed. Fix your API key's billing/quota, then start a fresh extraction.`
          : `Chunk ${chunkIndex} (pages ${effectiveStartPage}-${endPage}) failed: ${message}. Other chunks were still attempted; you may review partial results or start over.`;
      }

      for (const q of chunkPyqs) {
        const year = Number(q.year);
        // Server-side numeric filter - do NOT trust Gemini to range-filter reliably.
        if (year < PYQ_MIN_YEAR || year > PYQ_MAX_YEAR) continue;

        const pageNum = Number(q.pageNumber);
        const questionText = String(q.questionText).trim();
        const dedupKey = `${pageNum}::${normalizeForDedup(questionText)}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);

        // Always carry a real topic, even on the rare occasion Gemini ignores the
        // "never null" instruction or hallucinates a name outside the given list -
        // fall back to the first topic in the vocabulary rather than leaving it unclassified.
        const suggestedTag =
          q.suggestedTag && job.topicNames.includes(q.suggestedTag)
            ? q.suggestedTag
            : job.topicNames[0];
        allPyqs.push({ pageNumber: pageNum, year, questionText, suggestedTag });
      }

      allPyqs.sort((a, b) => a.pageNumber - b.pageNumber || a.year - b.year);
      job.extractedPyqs = allPyqs;
      if (chunkSucceeded) job.chunksCompleted += 1;
      await job.save();

      if (quotaExceeded) {
        job.status = "error";
        await job.save();
        break;
      }

      if (chunkIndex < job.totalChunks) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
      }
    }

    if (job.status !== "error") {
      job.status = "done";
      job.currentChunkRange = "";
      await job.save();
    }
  } catch (err) {
    console.error(`[PyqExtractionJob ${jobId}] Fatal error:`, err);
    job.status = "error";
    job.error = err.message || "PYQ extraction failed";
    await job.save();
  } finally {
    if (job.sourceFilePath) {
      await fs.unlink(job.sourceFilePath).catch(() => {});
    }
  }
};

// Commit reviewed PYQ extraction results into real ProgressPyq documents (Admin only).
// Purely additive (insertMany, never deleteMany) - unlike the legacy CSV upload's
// replace-all-for-subject behavior, re-running extraction never destroys prior results.
export const bulkCreatePyqs = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { courseId, fileIndex, pyqs } = req.body;
  if (!courseId) return res.status(400).json({ error: "courseId is required" });
  if (!Array.isArray(pyqs) || pyqs.length === 0) {
    return res
      .status(400)
      .json({ error: "pyqs array is required and must be non-empty" });
  }

  try {
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const fileIdxNum = Number(fileIndex) || 0;
    const fileCount = course.fileUrls?.length > 0 ? course.fileUrls.length : 1;
    if (fileIdxNum < 0 || fileIdxNum >= fileCount) {
      return res
        .status(400)
        .json({ error: "Invalid fileIndex for this course" });
    }

    const skippedRows = [];
    const docs = [];
    for (let i = 0; i < pyqs.length; i++) {
      const row = pyqs[i];
      const rowNum = i + 1;
      const questionText = (row.questionText || "").trim();
      const year = Number(row.year);
      const section = (row.section || "").trim();

      if (!questionText) {
        skippedRows.push({ row: rowNum, reason: "Missing question text" });
        continue;
      }
      if (
        !Number.isFinite(year) ||
        year < PYQ_MIN_YEAR ||
        year > PYQ_MAX_YEAR
      ) {
        skippedRows.push({
          row: rowNum,
          reason: `Missing or out-of-range year (must be ${PYQ_MIN_YEAR}-${PYQ_MAX_YEAR})`,
        });
        continue;
      }
      if (!section) {
        skippedRows.push({ row: rowNum, reason: "Missing tag/section" });
        continue;
      }

      docs.push({
        questionText,
        subject: course.subject, // always denormalized for backward-compat lookups
        course: course._id,
        fileIndex: fileIdxNum,
        section,
        year,
      });
    }

    const inserted = docs.length > 0 ? await ProgressPyq.insertMany(docs) : [];

    res.json({
      message: `Added ${inserted.length} new PYQ(s).`,
      insertedCount: inserted.length,
      skippedRows,
    });
  } catch (err) {
    console.error("Error bulk-creating PYQs:", err);
    res.status(500).json({ error: err.message || "Server error saving PYQs" });
  }
};
