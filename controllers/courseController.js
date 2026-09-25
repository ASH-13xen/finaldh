import fs from "fs/promises";
import { createReadStream } from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");
import { GoogleGenerativeAI } from "@google/generative-ai";
import { encryptPDF } from "@pdfsmaller/pdf-encrypt-lite";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { r2Client } from "../config/r2.js";
import Course from "../models/Course.js";
import User from "../models/User.js";
import DownloadSession from "../models/DownloadSession.js";
import DownloadLog from "../models/DownloadLog.js";
import { userHasCourseAccess } from "../utils/courseAccess.js";
import { escapeRegExp } from "../utils/sanitize.js";
import { buildSecuredPdf, generateLicenseId, fingerprintOf } from "../lib/pdfStamp.js";
import SiteContent from "../models/SiteContent.js";
import mongoose from "mongoose";
import { exec } from "child_process";
import { promisify } from "util";
import { pipeline } from "stream/promises";

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global cache to track real-time download progress steps (kept for backward-compatibility)
export const downloadProgressCache = {};

// If a DownloadSession sits in "queued"/"processing" without a progress update
// for this long, treat it as crashed (e.g. the GitHub Actions job was
// OOM-killed or cancelled before it could report failure) rather than leaving
// students staring at a frozen progress bar.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export const setSessionProgress = async (
  userId,
  courseId,
  step,
  status = "processing",
  error = null,
) => {
  try {
    await DownloadSession.findOneAndUpdate(
      { userId, courseId },
      { step, status, error },
      { upsert: true },
    );
  } catch (err) {
    console.error(`[DownloadSession] Error updating progress:`, err);
  }
};

// The download credit for a file is pre-emptively incremented before dispatching
// the GitHub Actions job (see downloadSecuredCoursePdf), so a double-click/two-tab
// race couldn't both start a generation. When that generation never produces a
// usable PDF - whether reported via the callback or detected as a stale/stuck
// session - refund it here, otherwise a single transient failure permanently
// burns the student's one-time allowance for this file with nothing to show for it.
const refundDownloadCredit = async (userId, courseId) => {
  try {
    const refundUser = await User.findById(userId);
    if (!refundUser) return;
    const entry = refundUser.downloadLimits.find(
      (d) => d.courseId.toLowerCase() === String(courseId).toLowerCase(),
    );
    if (entry && entry.downloadedCount > 0) {
      entry.downloadedCount -= 1;
      await refundUser.save();
      console.log(
        `[DownloadSession] Refunded download credit for user ${userId}, courseId ${courseId}.`,
      );
    }
  } catch (refundErr) {
    console.error(
      `[DownloadSession] Failed to refund download credit:`,
      refundErr,
    );
  }
};

// Page count extractor that never loads the full file into memory.
// Reads head (512 KB) + tail (2 MB) — ~2.5 MB max regardless of PDF size.
// Single-part courses don't use the page count at all, so 0 is a safe fallback.
const getPdfPageCount = async (filePath, originalname = "PDF") => {
  try {
    // Try qpdf first — zero memory, perfectly reliable if installed
    try {
      const { stdout } = await execPromise(`qpdf --show-npages "${filePath}"`);
      const count = parseInt(stdout.trim(), 10);
      if (count > 0) {
        console.log(
          `[PDF Pages] qpdf count for ${originalname}: ${count} pages`,
        );
        return count;
      }
    } catch {
      // qpdf not available on this host; continue
    }

    const stat = await fs.stat(filePath);
    const fileSize = stat.size;

    // Read first 512 KB (catalog/root Pages often near start in linearized PDFs)
    const HEAD_SIZE = Math.min(512 * 1024, fileSize);
    // Read last 2 MB (xref + trailer usually at end, root Pages nearby)
    const tailOffset = Math.max(HEAD_SIZE, fileSize - 2 * 1024 * 1024);
    const TAIL_SIZE = fileSize - tailOffset;

    const fh = await fs.open(filePath, "r");
    const headBuf = Buffer.alloc(HEAD_SIZE);
    const tailBuf = Buffer.alloc(TAIL_SIZE);
    await fh.read(headBuf, 0, HEAD_SIZE, 0);
    await fh.read(tailBuf, 0, TAIL_SIZE, tailOffset);
    await fh.close();

    // Search both regions concatenated (~2.5 MB max)
    const searchStr = Buffer.concat([headBuf, tailBuf]).toString("binary");
    let match;
    let maxCount = 0;

    // Attempt 1: root Page tree node — /Type /Pages ... /Count N
    const pagesRegex = /\/Type\s*\/Pages[\s\S]*?\/Count\s*(\d+)/g;
    while ((match = pagesRegex.exec(searchStr)) !== null) {
      const count = parseInt(match[1], 10);
      if (count > maxCount) maxCount = count;
    }
    if (maxCount > 0) {
      console.log(
        `[PDF Pages] Head+Tail parse for ${originalname}: ${maxCount} pages`,
      );
      return maxCount;
    }

    // Attempt 2: any /Count entry (catches split trees)
    const countRegex = /\/Count\s*(\d+)/g;
    while ((match = countRegex.exec(searchStr)) !== null) {
      const count = parseInt(match[1], 10);
      if (count > maxCount) maxCount = count;
    }
    if (maxCount > 0) {
      console.log(
        `[PDF Pages] Head+Tail /Count search for ${originalname}: ${maxCount} pages`,
      );
      return maxCount;
    }

    // No count found in head+tail — /Pages root is in the middle of this PDF.
    // Returning 0 is safe: single-part courses ignore page count entirely,
    // and multi-part mapping will fall back to showing all parts.
    console.warn(
      `[PDF Pages] Could not find page count for ${originalname} without full load — defaulting to 0.`,
    );
    return 0;
  } catch (pdfErr) {
    console.warn(
      `[PDF Warning] Could not parse page count for ${originalname}:`,
      pdfErr.message,
    );
    return 0;
  }
};

// Sample PDFs are small (a few preview pages), so unlike the multi-hundred-MB master
// course files above, it's cheap to fully load them and get an exact page count instead
// of relying on the head+tail heuristic (which can miss files whose /Pages root sits
// outside the scanned regions and silently fall back to 0).
const getSamplePdfPageCount = async (filePath, originalname = "Sample PDF") => {
  try {
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo();
    await parser.destroy();
    if (info.total > 0) return info.total;
  } catch (err) {
    console.warn(
      `[Sample PDF Pages] Accurate parse failed for ${originalname}, falling back to heuristic:`,
      err.message,
    );
  }
  return getPdfPageCount(filePath, originalname);
};

// Upload a new Course PDF
export const uploadCourse = async (req, res) => {
  const {
    courseId,
    name,
    subject,
    price,
    discountedPrice,
    useDiscount,
    discountLimitTag,
    telegramGroupLink,
    examStage,
  } = req.body;
  const files = req.files || [];

  if (!courseId) {
    return res.status(400).json({ error: "Course ID is required" });
  }
  if (!name) {
    return res.status(400).json({ error: "Course name is required" });
  }
  if (!subject) {
    return res.status(400).json({ error: "Subject is required" });
  }
  if (!price) {
    return res.status(400).json({ error: "Price is required" });
  }

  try {
    // Check if courseId is unique
    const existing = await Course.findOne({ courseId });
    if (existing) {
      return res.status(400).json({ error: "Course ID must be unique" });
    }

    let filesConfig = [];
    if (req.body.filesConfig) {
      try {
        filesConfig = JSON.parse(req.body.filesConfig);
      } catch (e) {
        console.warn("Failed to parse filesConfig:", e);
      }
    }

    const fileUrls = [];
    const fileNames = [];
    const partPageCounts = [];

    let fileIndex = 0;
    if (filesConfig.length > 0) {
      for (const config of filesConfig) {
        if (config.type === "existing") {
          fileUrls.push(config.url);
          fileNames.push(config.name);
          partPageCounts.push(config.pageCount || 0);
        } else {
          const file = files[fileIndex++];
          if (!file) continue;

          console.log(
            `[R2 Upload] Uploading ${file.filename} to Cloudflare R2...`,
          );
          const fileStream = createReadStream(file.path);
          const uploadParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: file.filename,
            Body: fileStream,
            ContentType: file.mimetype || "application/pdf",
          };

          await r2Client.send(new PutObjectCommand(uploadParams));
          console.log(
            `[R2 Upload] File uploaded successfully to R2: ${file.filename}`,
          );

          // Count pages of this PDF file
          const pageCount = await getPdfPageCount(file.path, file.originalname);

          fileUrls.push(`r2://${file.filename}`);
          fileNames.push(config.name || file.originalname);
          partPageCounts.push(pageCount);
        }
      }
    } else {
      if (files.length === 0) {
        return res
          .status(400)
          .json({ error: "Course PDF file(s) are required" });
      }

      for (const file of files) {
        console.log(
          `[R2 Upload] Uploading ${file.filename} to Cloudflare R2...`,
        );
        const fileStream = createReadStream(file.path);
        const uploadParams = {
          Bucket: process.env.R2_BUCKET_NAME,
          Key: file.filename,
          Body: fileStream,
          ContentType: file.mimetype || "application/pdf",
        };

        await r2Client.send(new PutObjectCommand(uploadParams));
        console.log(
          `[R2 Upload] File uploaded successfully to R2: ${file.filename}`,
        );

        const pageCount = await getPdfPageCount(file.path, file.originalname);

        fileUrls.push(`r2://${file.filename}`);
        fileNames.push(file.originalname);
        partPageCounts.push(pageCount);
      }
    }

    if (fileUrls.length === 0) {
      return res
        .status(400)
        .json({ error: "At least one PDF file must be uploaded." });
    }

    const newCourse = await Course.create({
      courseId: courseId.trim(),
      name,
      subject,
      fileName: fileNames[0],
      fileUrl: fileUrls[0],
      fileUrls,
      fileNames,
      partPageCounts,
      price: Number(price),
      discountedPrice:
        discountedPrice !== undefined ? Number(discountedPrice) : Number(price),
      useDiscount: useDiscount === "true" || useDiscount === true,
      discountLimitTag:
        discountLimitTag === "true" || discountLimitTag === true,
      telegramGroupLink: telegramGroupLink ? telegramGroupLink.trim() : "",
      examStage: examStage === "Prelims" ? "Prelims" : "Mains",
    });

    res.json({
      message: "Course PDF uploaded successfully!",
      course: newCourse,
    });
  } catch (err) {
    console.error("Error uploading course:", err);
    res.status(500).json({ error: "Server error uploading course PDF" });
  } finally {
    // Delete temp files
    for (const file of files) {
      if (file && file.path) {
        try {
          await fs.unlink(file.path);
          console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
        } catch (unlinkErr) {
          console.warn(
            `[Cleanup] Failed to delete temp file ${file.path}:`,
            unlinkErr.message,
          );
        }
      }
    }
  }
};

// Update an existing course
export const updateCourse = async (req, res) => {
  const { id } = req.params;
  const {
    courseId,
    name,
    subject,
    price,
    discountedPrice,
    useDiscount,
    discountLimitTag,
    progressEnabled,
    telegramGroupLink,
    examStage,
  } = req.body;
  const files = req.files || [];

  try {
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    if (courseId && courseId.trim() !== course.courseId) {
      const existing = await Course.findOne({ courseId: courseId.trim() });
      if (existing) {
        return res
          .status(400)
          .json({ error: "New Course ID is already taken" });
      }
      course.courseId = courseId.trim();
    }

    if (name) course.name = name;
    if (subject) course.subject = subject;
    if (price !== undefined) course.price = Number(price);
    if (discountedPrice !== undefined)
      course.discountedPrice = Number(discountedPrice);
    if (useDiscount !== undefined)
      course.useDiscount = useDiscount === "true" || useDiscount === true;
    if (discountLimitTag !== undefined)
      course.discountLimitTag =
        discountLimitTag === "true" || discountLimitTag === true;
    if (progressEnabled !== undefined)
      course.progressEnabled =
        progressEnabled === "true" || progressEnabled === true;
    if (telegramGroupLink !== undefined)
      course.telegramGroupLink = telegramGroupLink.trim();
    if (examStage === "Prelims" || examStage === "Mains")
      course.examStage = examStage;

    let filesConfig = [];
    if (req.body.filesConfig) {
      try {
        filesConfig = JSON.parse(req.body.filesConfig);
      } catch (e) {
        console.warn("Failed to parse filesConfig in updateCourse:", e);
      }
    }

    if (filesConfig.length > 0) {
      const fileUrls = [];
      const fileNames = [];
      const partPageCounts = [];

      let fileIndex = 0;
      const oldUrls =
        course.fileUrls && course.fileUrls.length > 0
          ? course.fileUrls
          : [course.fileUrl];

      for (const config of filesConfig) {
        if (config.type === "existing") {
          fileUrls.push(config.url);
          fileNames.push(config.name);
          partPageCounts.push(config.pageCount || 0);
        } else {
          const file = files[fileIndex++];
          if (!file) continue;

          console.log(
            `[R2 Upload] Uploading replacement/new file ${file.filename} to R2...`,
          );
          const fileStream = createReadStream(file.path);
          await r2Client.send(
            new PutObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: file.filename,
              Body: fileStream,
              ContentType: file.mimetype || "application/pdf",
            }),
          );
          console.log(
            `[R2 Upload] Replacement/new file uploaded to R2: ${file.filename}`,
          );

          // Count pages of this PDF file
          const pageCount = await getPdfPageCount(file.path, file.originalname);

          fileUrls.push(`r2://${file.filename}`);
          fileNames.push(config.name || file.originalname);
          partPageCounts.push(pageCount);
        }
      }

      // Cleanup files that were in the old course but are not in the new configuration
      for (const oldUrl of oldUrls) {
        if (oldUrl && !fileUrls.includes(oldUrl)) {
          if (oldUrl.startsWith("r2://")) {
            const oldR2Key = oldUrl.replace("r2://", "");
            console.log(
              `[R2 Cleanup] Deleting removed file from R2: ${oldR2Key}`,
            );
            try {
              await r2Client.send(
                new DeleteObjectCommand({
                  Bucket: process.env.R2_BUCKET_NAME,
                  Key: oldR2Key,
                }),
              );
            } catch (deleteErr) {
              console.warn(
                `[R2 Cleanup] Could not delete removed file from R2:`,
                deleteErr.message,
              );
            }
          } else {
            const oldFilePath = path.join(__dirname, "../", oldUrl);
            try {
              await fs.unlink(oldFilePath);
            } catch (unlinkErr) {
              console.warn(
                "Could not delete removed local file:",
                unlinkErr.message,
              );
            }
          }
        }
      }

      course.fileName = fileNames[0] || "";
      course.fileUrl = fileUrls[0] || "";
      course.fileNames = fileNames;
      course.fileUrls = fileUrls;
      course.partPageCounts = partPageCounts;
    } else if (files.length > 0) {
      // Fallback edit behavior if no filesConfig sent but files exist:
      const fileUrls = [];
      const fileNames = [];
      const partPageCounts = [];

      for (const file of files) {
        console.log(
          `[R2 Upload] Uploading replacement file ${file.filename} to R2...`,
        );
        const fileStream = createReadStream(file.path);
        await r2Client.send(
          new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: file.filename,
            Body: fileStream,
            ContentType: file.mimetype || "application/pdf",
          }),
        );
        console.log(
          `[R2 Upload] Replacement file uploaded to R2: ${file.filename}`,
        );

        // Count pages of this PDF file
        const pageCount = await getPdfPageCount(file.path, file.originalname);

        fileUrls.push(`r2://${file.filename}`);
        fileNames.push(file.originalname);
        partPageCounts.push(pageCount);
      }

      // Cleanup old files (either from R2 or local disk depending on prefixes)
      const oldUrls =
        course.fileUrls && course.fileUrls.length > 0
          ? course.fileUrls
          : [course.fileUrl];
      for (const oldUrl of oldUrls) {
        if (oldUrl) {
          if (oldUrl.startsWith("r2://")) {
            const oldR2Key = oldUrl.replace("r2://", "");
            console.log(`[R2 Cleanup] Deleting old file from R2: ${oldR2Key}`);
            try {
              await r2Client.send(
                new DeleteObjectCommand({
                  Bucket: process.env.R2_BUCKET_NAME,
                  Key: oldR2Key,
                }),
              );
            } catch (deleteErr) {
              console.warn(
                `[R2 Cleanup] Could not delete old file from R2:`,
                deleteErr.message,
              );
            }
          } else {
            const oldFilePath = path.join(__dirname, "../", oldUrl);
            try {
              await fs.unlink(oldFilePath);
            } catch (unlinkErr) {
              console.warn(
                "Could not delete old local file:",
                unlinkErr.message,
              );
            }
          }
        }
      }

      course.fileName = fileNames[0];
      course.fileUrl = fileUrls[0];
      course.fileNames = fileNames;
      course.fileUrls = fileUrls;
      course.partPageCounts = partPageCounts;
    }

    await course.save();

    res.json({
      message: "Course updated successfully!",
      course,
    });
  } catch (err) {
    console.error("Error updating course:", err);
    res.status(500).json({ error: "Server error updating course" });
  } finally {
    for (const file of files) {
      if (file && file.path) {
        try {
          await fs.unlink(file.path);
          console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
        } catch (unlinkErr) {
          console.warn(
            `[Cleanup] Failed to delete temp file ${file.path}:`,
            unlinkErr.message,
          );
        }
      }
    }
  }
};

// Delete an existing course
export const deleteCourse = async (req, res) => {
  const { id } = req.params;

  try {
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    // Delete the file from the filesystem/R2
    const urlsToDelete =
      course.fileUrls && course.fileUrls.length > 0
        ? course.fileUrls
        : [course.fileUrl];
    for (const url of urlsToDelete) {
      if (url) {
        if (url.startsWith("r2://")) {
          const r2Key = url.replace("r2://", "");
          console.log(`[R2 Cleanup] Deleting file from R2: ${r2Key}`);
          try {
            await r2Client.send(
              new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: r2Key,
              }),
            );
          } catch (deleteErr) {
            console.warn(
              `[R2 Cleanup] Could not delete file from R2:`,
              deleteErr.message,
            );
          }
        } else {
          const filePath = path.join(__dirname, "../", url);
          try {
            await fs.unlink(filePath);
          } catch (unlinkErr) {
            console.warn(
              "Could not delete course file from disk:",
              unlinkErr.message,
            );
          }
        }
      }
    }

    await Course.findByIdAndDelete(id);

    res.json({ message: "Course removed successfully!" });
  } catch (err) {
    console.error("Error deleting course:", err);
    res.status(500).json({ error: "Server error deleting course" });
  }
};

// Retrieve all available courses
export const listCourses = async (req, res) => {
  try {
    const courses = await Course.find({}).sort({ createdAt: -1 });
    res.json({ courses });
  } catch (err) {
    console.error("Error listing courses:", err);
    res.status(500).json({ error: "Server error listing courses" });
  }
};

// Retrieve user's purchased courses
export const getPurchasedCourses = async (req, res) => {
  try {
    // Course lives in the content cluster, User in the people cluster, so the model must be given explicitly.
    const user = await User.findById(req.userId).populate({ path: "purchasedCourses", model: Course });
    if (!user) {
      return res.status(404).json({ error: "User profile not found" });
    }
    res.json({ purchasedCourses: user.purchasedCourses || [] });
  } catch (err) {
    console.error("Error retrieving purchased courses:", err);
    res
      .status(500)
      .json({ error: "Server error fetching purchased courses list" });
  }
};

// Analyze a specific page of a course PDF
export const analyzeCoursePage = async (req, res) => {
  const { courseId, pageNumber } = req.body;

  if (!courseId) {
    return res.status(400).json({ error: "courseId is required" });
  }
  if (!pageNumber || isNaN(Number(pageNumber)) || Number(pageNumber) <= 0) {
    return res.status(400).json({ error: "Valid pageNumber is required" });
  }

  try {
    // 1. Verify user profile and purchases
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User profile not found" });
    }

    const hasPurchased = user.purchasedCourses.some(
      (id) => id.toString() === courseId,
    );
    if (!hasPurchased) {
      return res
        .status(403)
        .json({ error: "Access denied. You have not purchased this course." });
    }

    // 2. Fetch the course details
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    // Map global page number to correct local part
    const partUrls =
      course.fileUrls && course.fileUrls.length > 0
        ? course.fileUrls
        : [course.fileUrl];
    let targetPartUrl = partUrls[0];
    let localPageNumber = Number(pageNumber);

    if (
      partUrls.length > 1 &&
      course.partPageCounts &&
      course.partPageCounts.length === partUrls.length
    ) {
      let accumulatedPages = 0;
      let targetPartIdx = 0;
      for (let i = 0; i < course.partPageCounts.length; i++) {
        const count = course.partPageCounts[i];
        if (Number(pageNumber) <= accumulatedPages + count) {
          targetPartIdx = i;
          localPageNumber = Number(pageNumber) - accumulatedPages;
          break;
        }
        accumulatedPages += count;
      }
      targetPartUrl = partUrls[targetPartIdx];
      console.log(
        `[PDF Security] Mapping page ${pageNumber} -> Part ${targetPartIdx + 1} page ${localPageNumber}`,
      );
    }

    // 3. Load PDF buffer from R2 or local disk
    let fileBuffer;
    if (targetPartUrl.startsWith("r2://")) {
      const r2Key = targetPartUrl.replace("r2://", "");
      console.log(
        `[R2 Stream] Fetching raw PDF for page analysis from R2 key: ${r2Key}`,
      );
      try {
        const r2Response = await r2Client.send(
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }),
        );

        const chunks = [];
        for await (const chunk of r2Response.Body) {
          chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
      } catch (r2Err) {
        console.error(
          `[PDF Security] Error reading PDF from R2 for page analysis:`,
          r2Err,
        );
        return res
          .status(500)
          .json({ error: "Could not retrieve course file from Cloudflare R2" });
      }
    } else {
      const filePath = path.join(__dirname, "../", targetPartUrl);
      try {
        await fs.access(filePath);
        fileBuffer = await fs.readFile(filePath);
      } catch (readErr) {
        console.error(
          `Error reading PDF file from disk for page analysis:`,
          readErr,
        );
        return res
          .status(404)
          .json({ error: "Course PDF file not found on server disk." });
      }
    }

    // 4. Read PDF and parse the specific page
    console.log(
      `Analyzing course page: parsing page ${localPageNumber} (global ${pageNumber})...`,
    );
    const parser = new PDFParse({ data: fileBuffer });

    // Efficiently parse ONLY the target page
    const pdfData = await parser.getText({ partial: [localPageNumber] });
    const pageObj = pdfData.pages.find((p) => p.num === localPageNumber);
    const pageText = pageObj ? pageObj.text : "";

    if (!pageText || pageText.trim().length === 0) {
      return res.status(400).json({
        error: `Could not extract text from page ${pageNumber}. The page might be blank, scanned, or contains only images.`,
      });
    }

    console.log(
      `Page ${pageNumber} parsed successfully. Character count: ${pageText.length}`,
    );

    // 5. Load the syllabus outline for the course's subject
    const syllabusPath = path.join(__dirname, "../syllabus_hierarchy.json");
    const syllabusContent = await fs.readFile(syllabusPath, "utf8");
    const fullSyllabus = JSON.parse(syllabusContent);

    let subjectSyllabus = null;
    let subjectDisplayName = course.subject;

    if (fullSyllabus.gsModules && fullSyllabus.gsModules[course.subject]) {
      subjectSyllabus = fullSyllabus.gsModules[course.subject];
      subjectDisplayName = course.subject.replace("-", " ");
    } else if (
      fullSyllabus.optionalSubjects &&
      fullSyllabus.optionalSubjects[course.subject]
    ) {
      subjectSyllabus = fullSyllabus.optionalSubjects[course.subject];
      subjectDisplayName = `Optional subject: ${course.subject.replace("OptionalSubject", "")}`;
    }

    if (!subjectSyllabus) {
      return res
        .status(400)
        .json({
          error: `Syllabus outline not configured for subject: ${course.subject}`,
        });
    }

    // Simplify outline for prompt token efficiency
    const syllabusOutline = subjectSyllabus.map((sec) => ({
      section: sec.section,
      topics: sec.topics.map((t) => t.title),
    }));

    // 6. Call Gemini to tag and summarize the content on the page
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      return res
        .status(550)
        .json({ error: "Gemini API key is not configured in backend .env" });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    const prompt = `
You are an expert academic syllabus analyzer. We have extracted the text of Page ${pageNumber} from a course textbook or study guide for the subject "${subjectDisplayName}".

Page Text:
"""
${pageText}
"""

Instructions:
1. Analyze the core concept, topic, or question being discussed on this page.
2. From the subject syllabus hierarchy provided below, identify the single most relevant "section" name and corresponding topic "title". If multiple topics apply, select the single most prominent one.
3. If no specific topic from the hierarchy is a good match, select the closest logical match or use "General".
4. Formulate a brief, clear summary of the core question, theme, or concept discussed on this page.

Syllabus Hierarchy for "${subjectDisplayName}":
${JSON.stringify(syllabusOutline, null, 2)}

Return your analysis strictly as a JSON object with this format (do not wrap in markdown or backticks):
{
  "questionText": "Brief summary of the theme, question, or concept on this page",
  "section": "Matching section name from the syllabus hierarchy",
  "title": "Matching topic title from the syllabus hierarchy"
}
`;

    console.log(`Sending request to Gemini for page ${pageNumber} analysis...`);
    const response = await model.generateContent([prompt]);
    const responseText = response.response.text();
    console.log("Gemini response text:", responseText);

    let parsedResult = {};
    try {
      parsedResult = JSON.parse(responseText.trim());
    } catch (parseErr) {
      console.error("Error parsing Gemini JSON response:", parseErr);
      return res
        .status(500)
        .json({
          error: "Gemini did not return structured JSON. Please try again.",
        });
    }

    res.json({
      message: "Analysis successful!",
      analysis: {
        questionText:
          parsedResult.questionText || "Concept summary unavailable",
        section: parsedResult.section || "General",
        title: parsedResult.title || "General",
      },
    });
  } catch (err) {
    console.error("Error analyzing course page:", err);
    res.status(500).json({ error: "Server error during page analysis" });
  }
};

// Where the GitHub worker POSTs progress/completion. The worker sends CALLBACK_SECRET to this URL, so it
// must never be built from an attacker-controllable Host header in production (a student could point it
// at their own server, capture the secret and forge "failed" callbacks to refund download credits).
const resolveCallbackBase = (req) => {
  const configured = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/$/, "");
  const host = (req.hostname || "").toLowerCase();
  const allowed = (process.env.CALLBACK_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (["localhost", "127.0.0.1", "::1"].includes(host) || allowed.includes(host)) {
    return `${req.protocol}://${req.get("host")}`;
  }
  return null;
};

// The password a student opens the secured PDF with: last 10 digits of their mobile, else their email.
const openingPassword = (user) => {
  const mobile = (user.mobileNumber || "").trim();
  const digits = mobile.replace(/\D/g, "");
  if (digits && mobile !== "N/A") return digits.length >= 10 ? digits.slice(-10) : digits;
  return String(user.email || "").trim().toLowerCase();
};

async function loadCourseFileBuffer(url) {
  if (url.startsWith("r2://")) {
    const r2Response = await r2Client.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: url.replace("r2://", "") }),
    );
    return Buffer.from(await r2Response.Body.transformToByteArray());
  }
  return fs.readFile(path.join(__dirname, "../", url));
}

// Every secured PDF gets a unique License ID that is printed on each page, hidden in the file and
// recorded here, so a leaked copy can be traced back to who it was issued to, when, and from where.
async function issueLicense({ req, user, course, compositeCourseId, fileIndex }) {
  const licenseId = generateLicenseId();
  const issuedAt = new Date();
  await DownloadLog.create({
    licenseId,
    fingerprint: fingerprintOf(licenseId),
    userId: user._id,
    userEmail: user.email,
    userName: user.fullName || user.name || "",
    userMobile: user.mobileNumber || "",
    courseObjectId: course._id,
    courseId: compositeCourseId,
    courseName: course.name || "",
    fileIndex,
    ip: req.ip || "",
    forwardedFor: String(req.headers["x-forwarded-for"] || "").slice(0, 300),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    status: "queued",
    issuedAt,
  });
  return { licenseId, issuedAt };
}

// Handle secured PDF download: centred watermark, bottom credentials strip, barcode and hidden trace marks
export const downloadSecuredCoursePdf = async (req, res) => {
  const { courseId } = req.params;
  const { checkOnly, index: indexStr } = req.query;
  const fileIndex = indexStr !== undefined ? parseInt(indexStr) : 0;

  console.log(
    `[PDF Security] Starting secure download process for courseId: ${courseId}, fileIndex: ${fileIndex}, checkOnly: ${checkOnly}`,
  );

  // Determine mode (default to github-actions if not specified)
  let mode = process.env.DOWNLOAD_MODE || "github-actions";
  console.log(`[PDF Security] Download mode: ${mode}`);

  let dispatched = false;
  let tempStampPath = "";
  let tempWarningPath = "";
  let tempOutputPath = "";
  let rawPartPaths = [];
  let securedPartPaths = [];
  let creditIncremented = false;
  let compositeCourseId = courseId;

  try {
    // 2. Fetch course by custom courseId
    console.log(
      `[PDF Security] Fetching course details for courseId: ${courseId}`,
    );
    const course = await Course.findOne({ courseId });
    if (!course) {
      console.log(`[PDF Security] Course not found for courseId: ${courseId}`);
      return res.status(404).json({ error: "Course not found" });
    }
    console.log(`[PDF Security] Course found (${course.name})`);

    // Reject a bad file index up front: an unchecked NaN/out-of-range index used to crash later,
    // after the student's download credit had already been spent.
    const fileCount = Math.max(1, (course.fileUrls && course.fileUrls.length) || 0);
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= fileCount) {
      return res.status(400).json({ error: "Invalid file index" });
    }

    compositeCourseId =
      course.fileUrls && course.fileUrls.length > 1
        ? `${courseId}_${fileIndex}`
        : courseId;

    // A real (non-checkOnly) github-actions request only ever exists to
    // consume an already-completed generation (see the completedSession check
    // below) — nothing polls its progress, so these step markers would only
    // serve to stomp the "completed" status this same request is about to
    // look for. Skip them for that case; still track them for everything else.
    const skipProgressTracking = mode === "github-actions" && checkOnly !== "true";

    // Initialize tracking only if not checkOnly
    if (checkOnly !== "true" && !skipProgressTracking) {
      await setSessionProgress(req.userId, compositeCourseId, 1, "idle");
    }

    // 1. Fetch user to verify active session
    console.log(
      `[PDF Security] Step 1: Fetching user details for ID: ${req.userId}`,
    );
    const user = await User.findById(req.userId);
    if (!user) {
      console.log(
        `[PDF Security] Step 1: User not found for ID: ${req.userId}`,
      );
      return res.status(404).json({ error: "User not found" });
    }
    console.log(`[PDF Security] Step 1: User found (${user.email})`);

    // Step 2 starts only if not checkOnly
    if (checkOnly !== "true" && !skipProgressTracking) {
      await setSessionProgress(req.userId, compositeCourseId, 2, "idle");
    }

    // Step 3 starts only if not checkOnly
    if (checkOnly !== "true" && !skipProgressTracking) {
      await setSessionProgress(req.userId, compositeCourseId, 3, "idle");
    }

    // 3. Verify user has access to this course (purchasedCourses, or admin - see utils/courseAccess.js)
    console.log(`[PDF Security] Step 3: Verifying student course permissions`);
    if (!userHasCourseAccess(user, course)) {
      console.log(
        `[PDF Security] Step 3: Access denied for user ${user.email} on course ${courseId}`,
      );
      return res.status(403).json({
        error: "Access denied: You have not purchased this course",
      });
    }
    console.log(`[PDF Security] Step 3: Access verified`);

    // If checkOnly is true and mode is NOT github-actions (local/sync mode download)
    if (checkOnly === "true" && mode !== "github-actions") {
      console.log(
        `[PDF Security] checkOnly: Sync mode ${mode} ready for direct download.`,
      );
      return res.json({ exists: false, directStream: true });
    }

    if (mode === "github-actions" && checkOnly !== "true") {
      // No caching: a secured PDF is never reused across requests. The only
      // reason to look here is when the generation we kicked off via the
      // checkOnly call has just finished — signaled by the DownloadSession
      // flipping to "completed" — in which case we stream the one-time file
      // and delete it from R2 immediately after, win or lose.
      const destinationKey = `secured-${req.userId}-${courseId}${course.fileUrls && course.fileUrls.length > 1 ? `_${fileIndex}` : ""}.pdf`;

      const completedSession = await DownloadSession.findOne({
        userId: req.userId,
        courseId: compositeCourseId,
        status: "completed",
      });

      if (completedSession) {
        console.log(
          `[PDF Security] Generation complete. Streaming freshly generated PDF from R2 (one-time, not cached): ${destinationKey}`,
        );
        const getResponse = await r2Client.send(
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: destinationKey,
          }),
        );

        const activeFileName =
          course.fileNames && course.fileNames.length > 1
            ? course.fileNames[fileIndex]
            : course.fileName;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${activeFileName.replace(/\s+/g, "_")}_secured.pdf"`,
        );
        res.setHeader("Content-Length", getResponse.ContentLength);

        let cleanedUp = false;
        const cleanupOneTimeFile = async () => {
          if (cleanedUp) return;
          cleanedUp = true;
          await r2Client
            .send(
              new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: destinationKey,
              }),
            )
            .catch((err) =>
              console.error(
                `[PDF Security] Error deleting one-time R2 object:`,
                err,
              ),
            );
          await DownloadSession.deleteOne({
            _id: completedSession._id,
          }).catch((err) =>
            console.error(
              `[PDF Security] Error deleting completed session:`,
              err,
            ),
          );
        };

        res.on("finish", () => {
          console.log(
            `[PDF Security] Direct Stream: Successfully completed streaming secured PDF for courseId: ${compositeCourseId}`,
          );
          DownloadLog.findOneAndUpdate(
            { userId: req.userId, courseId: compositeCourseId, status: "ready" },
            { status: "delivered" },
            { sort: { issuedAt: -1 } },
          ).catch(() => {});
        });
        res.on("close", () => {
          console.log(
            `[PDF Security] Direct Stream: Client connection closed for courseId: ${courseId}`,
          );
          cleanupOneTimeFile();
        });
        res.on("error", (err) => {
          console.error(
            `[PDF Security] Direct Stream: Client response streaming error:`,
            err,
          );
          cleanupOneTimeFile();
        });

        getResponse.Body.pipe(res);
        return;
      }

      // A real (non-checkOnly) request must never silently kick off a fresh
      // generation cycle — that's only ever supposed to happen from the
      // checkOnly probe below. If we got here with nothing to stream, either
      // nothing was started yet, or (e.g. a duplicate poll/double-click firing
      // two native-download triggers) another request already consumed the
      // finished file. Either way, tell the caller to restart the
      // check-then-poll flow instead of quietly starting (and charging for)
      // another full generation run.
      console.log(
        `[PDF Security] Real download request found no completed generation ready for user: ${req.userId}, courseId: ${compositeCourseId}. Not starting a new one.`,
      );
      return res.status(409).json({
        error:
          "No completed generation found for this download. Please try downloading again.",
      });
    }

    // Step 4 starts only if not checkOnly
    if (checkOnly !== "true") {
      await setSessionProgress(req.userId, compositeCourseId, 4, "idle");
    }

    console.log(`[PDF Security] Step 4: Preparing to start generation`);

    // Enforce the per-course download limit right before it would be
    // incremented (see the two "Pre-emptively track..." blocks below). The
    // frontend also gates this, but its copy of downloadLimits is only
    // fetched once on page load and goes stale as soon as a download
    // completes — without a server-side check here, a user who hasn't
    // refreshed could keep re-triggering generations past their allowed
    // count. This is checked here rather than earlier so it never fires for
    // a checkOnly call that's just resuming/polling an already-claimed job
    // (that job's own start already accounted for the increment).
    const isOverLimit = () => {
      const entry = user.downloadLimits.find(
        (d) => d.courseId.toLowerCase() === compositeCourseId.toLowerCase(),
      );
      const allowedCount = entry ? entry.allowedCount : 1;
      const downloadedCount = entry ? entry.downloadedCount : 0;
      return downloadedCount >= allowedCount;
    };

    if (mode === "github-actions") {
      const destinationKey = `secured-${req.userId}-${courseId}${course.fileUrls && course.fileUrls.length > 1 ? `_${fileIndex}` : ""}.pdf`;

      // Fail fast on misconfiguration BEFORE claiming a session slot or spending a download credit
      // (this check used to run after both, leaving the student with a spent credit and a stuck session).
      const callbackBase = resolveCallbackBase(req);
      if (!callbackBase) {
        console.error(
          "[PDF Security] Cannot determine a trusted callback URL. Set BACKEND_URL (or RENDER_EXTERNAL_URL) in the backend environment.",
        );
        return res
          .status(500)
          .json({ error: "Download service is not fully configured" });
      }
      if (
        !process.env.GITHUB_REPO_OWNER ||
        !process.env.GITHUB_REPO_NAME ||
        !process.env.GITHUB_PAT
      ) {
        console.error(
          "[PDF Security] Missing GitHub repository info or PAT in env",
        );
        return res
          .status(500)
          .json({ error: "GitHub Actions background worker is not fully configured" });
      }

      // Atomically claim this download slot before doing any work. A plain
      // "find, then later mark queued" sequence leaves a race window (the GitHub
      // dispatch call below can take a noticeable amount of time) where two
      // near-simultaneous requests for the same user+file (double-click, two
      // tabs, a retry) can both see "no active job" and both increment the
      // download count. The unique {userId, courseId} index on DownloadSession
      // turns this into a single atomic compare-and-swap: only one concurrent
      // request can win the update to "queued"; the other gets a duplicate-key
      // error and is treated exactly like the old "job already running" case.
      try {
        await DownloadSession.findOneAndUpdate(
          {
            userId: req.userId,
            courseId: compositeCourseId,
            status: { $nin: ["queued", "processing"] },
          },
          { $set: { step: 1, status: "queued", error: null } },
          { upsert: true, new: true },
        );
      } catch (claimErr) {
        if (claimErr.code === 11000) {
          const existing = await DownloadSession.findOne({
            userId: req.userId,
            courseId: compositeCourseId,
          });
          console.log(
            `[PDF Security] Job is already running. Database value:`,
            existing,
          );
          return res.status(202).json({
            status: "processing",
            message: "PDF generation is currently in progress",
            step: existing?.step || 1,
          });
        }
        throw claimErr;
      }

      // The atomic claim above only proves no other job is already queued/
      // processing for this file — it says nothing about the allowance, so
      // check it now that we know this is a genuinely new job (not a resumed
      // poll of one already running). Release the slot we just claimed so a
      // legitimate future attempt (e.g. after an admin grants extra credit)
      // isn't blocked by a phantom "queued" session.
      if (isOverLimit()) {
        console.log(
          `[PDF Security] Download limit reached for user ${user.email} on course ${compositeCourseId}; releasing claimed session.`,
        );
        await setSessionProgress(
          req.userId,
          compositeCourseId,
          0,
          "failed",
          "Download limit reached",
        );
        return res.status(403).json({
          error: "Download limit reached for this file.",
        });
      }

      // Pre-emptively track and update download limit in database since we are starting generation
      const limitUser = await User.findById(req.userId);
      if (limitUser) {
        let finalLimitEntry = limitUser.downloadLimits.find(
          (d) => d.courseId.toLowerCase() === compositeCourseId.toLowerCase(),
        );
        if (finalLimitEntry) {
          finalLimitEntry.downloadedCount += 1;
        } else {
          limitUser.downloadLimits.push({
            courseId: compositeCourseId,
            downloadedCount: 1,
            allowedCount: 1,
          });
        }
        await limitUser.save();
        creditIncremented = true;
        console.log(
          `[PDF Security] Download limit tracked & updated in database (downloadedCount incremented)`,
        );
      }

      const repoOwner = process.env.GITHUB_REPO_OWNER;
      const repoName = process.env.GITHUB_REPO_NAME;
      const githubPat = process.env.GITHUB_PAT;

      if (!repoOwner || !repoName || !githubPat) {
        console.error(
          "[PDF Security] Missing GitHub repository info or PAT in env",
        );
        return res
          .status(500)
          .json({
            error: "GitHub Actions background worker is not fully configured",
          });
      }

      const singleUrl =
        course.fileUrls && course.fileUrls.length > 1
          ? course.fileUrls[fileIndex]
          : course.fileUrls && course.fileUrls.length === 1
            ? course.fileUrls[0]
            : course.fileUrl;
      const sourceKeys = singleUrl.replace("r2://", "");

      const callbackUrl = `${callbackBase}/api/courses/github-callback`;

      const dispatchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/pdf-processor.yml/dispatches`;

      console.log(
        `[PDF Security] Triggering GitHub workflow dispatch at: ${dispatchUrl}`,
      );

      let license = null;
      try {
        license = await issueLicense({ req, user, course, compositeCourseId, fileIndex });
        const response = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${githubPat}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "render-backend-app",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              courseId: compositeCourseId,
              userId: req.userId,
              userName: user.fullName || user.name || "Scholar",
              userEmail: user.email,
              userMobile: user.mobileNumber || "N/A",
              sourceKey: sourceKeys,
              destinationKey: destinationKey,
              callbackUrl: callbackUrl,
              licenseId: license.licenseId,
              issuedAt: license.issuedAt.toISOString(),
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `[PDF Security] GitHub API returned error ${response.status}: ${errorText}`,
          );
          throw new Error(
            `GitHub API returned ${response.status}: ${errorText}`,
          );
        }

        dispatched = true;
        console.log(
          `[PDF Security] Successfully dispatched GitHub workflow run`,
        );

        return res.status(202).json({
          status: "processing",
          message: "PDF generation queued on GitHub Actions worker",
        });
      } catch (dispatchErr) {
        console.error(
          `[PDF Security] Error triggering workflow dispatch:`,
          dispatchErr,
        );
        if (license) {
          await DownloadLog.updateOne(
            { licenseId: license.licenseId },
            { status: "failed" },
          ).catch(() => {});
        }
        if (creditIncremented) {
          const refundUser = await User.findById(req.userId);
          if (refundUser) {
            let refundEntry = refundUser.downloadLimits.find(
              (d) =>
                d.courseId.toLowerCase() === compositeCourseId.toLowerCase(),
            );
            if (refundEntry && refundEntry.downloadedCount > 0) {
              refundEntry.downloadedCount -= 1;
              await refundUser.save();
            }
          }
        }
        // Release the claimed session so a retry isn't permanently blocked by
        // the atomic claim above thinking a job is still queued/processing.
        await setSessionProgress(
          req.userId,
          compositeCourseId,
          0,
          "failed",
          dispatchErr.message,
        );
        return res
          .status(500)
          .json({
            error:
              "Failed to trigger background PDF processing: " +
              dispatchErr.message,
          });
      }
    }

    // Listen for client connection abort to refund credit
    req.on("close", async () => {
      if (!res.writableFinished && creditIncremented) {
        console.log(
          `[PDF Security] Request aborted midway by client. Initiating download credit refund for user: ${req.userId}, courseId: ${compositeCourseId}`,
        );
        try {
          const refundUser = await User.findById(req.userId);
          if (refundUser) {
            let refundEntry = refundUser.downloadLimits.find(
              (d) =>
                d.courseId.toLowerCase() === compositeCourseId.toLowerCase(),
            );
            if (refundEntry && refundEntry.downloadedCount > 0) {
              refundEntry.downloadedCount -= 1;
              await refundUser.save();
              console.log(
                `[PDF Security] Credit successfully refunded in database. downloadedCount: ${refundEntry.downloadedCount}`,
              );
            }
          }
        } catch (refundErr) {
          console.error(
            `[PDF Security] Error refunding download credit on abort:`,
            refundErr,
          );
        }
      }
    });

    if (isOverLimit()) {
      console.log(
        `[PDF Security] Download limit reached for user ${user.email} on course ${compositeCourseId}`,
      );
      return res.status(403).json({
        error: "Download limit reached for this file.",
      });
    }

    // We increment download credit pre-emptively, similar to original logic
    const limitUser = await User.findById(req.userId);
    if (limitUser) {
      let finalLimitEntry = limitUser.downloadLimits.find(
        (d) => d.courseId.toLowerCase() === compositeCourseId.toLowerCase(),
      );
      if (finalLimitEntry) {
        finalLimitEntry.downloadedCount += 1;
      } else {
        limitUser.downloadLimits.push({
          courseId: compositeCourseId,
          downloadedCount: 1,
          allowedCount: 1,
        });
      }
      await limitUser.save();
      creditIncremented = true;
      console.log(
        `[PDF Security] Download limit tracked & updated in database (downloadedCount incremented)`,
      );
    }

    const singleUrl =
      course.fileUrls && course.fileUrls.length > 1
        ? course.fileUrls[fileIndex]
        : course.fileUrls && course.fileUrls.length === 1
          ? course.fileUrls[0]
          : course.fileUrl;
    const partUrls = [singleUrl];

    // --- LOCAL PROCESSING (used when DOWNLOAD_MODE is not "github-actions") ---
    // This used to be three separate modes (client-side / server-native (qpdf) / server-js), each with its
    // own copy of the watermark code - and "client-side" streamed the RAW, unwatermarked file. They now all
    // run the one shared pipeline in lib/pdfStamp.js, so the output is identical to the GitHub Actions worker.
    if (mode !== "server-js") {
      console.warn(
        `[PDF Security] DOWNLOAD_MODE "${mode}" is retired; using the shared server-js pipeline instead.`,
      );
    }
    await setSessionProgress(req.userId, compositeCourseId, 5, "processing");

    const license = await issueLicense({ req, user, course, compositeCourseId, fileIndex });
    try {
      const sources = [];
      for (const partUrl of partUrls) sources.push(await loadCourseFileBuffer(partUrl));

      const stepNumbers = { barcode: 6, stamping: 7, saving: 8 };
      const stamped = await buildSecuredPdf({
        sources,
        user: {
          userId: String(user._id),
          name: user.fullName || user.name,
          email: user.email,
          mobile: user.mobileNumber,
        },
        license,
        docInfo: { title: course.name, subject: course.subject },
        onStep: (step) =>
          setSessionProgress(req.userId, compositeCourseId, stepNumbers[step], "processing"),
      });

      const encrypted = await encryptPDF(stamped, openingPassword(user));
      await setSessionProgress(req.userId, compositeCourseId, 9, "completed");
      await DownloadLog.updateOne({ licenseId: license.licenseId }, { status: "delivered" });

      const activeFileName =
        course.fileNames && course.fileNames.length > 1
          ? course.fileNames[fileIndex]
          : course.fileName;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${String(activeFileName || "course").replace(/[^\w.-]+/g, "_")}_secured.pdf"`,
      );
      res.setHeader("Content-Length", encrypted.length);
      res.end(Buffer.from(encrypted));
      console.log(`[PDF Security] Local pipeline: secured PDF streamed (license ${license.licenseId}).`);
      return;
    } catch (localErr) {
      await DownloadLog.updateOne({ licenseId: license.licenseId }, { status: "failed" }).catch(() => {});
      throw localErr;
    }
  } catch (err) {
    console.error(
      `[PDF Security] Server error during PDF secure process:`,
      err,
    );
    res
      .status(500)
      .json({ error: "Server error processing secured PDF download" });
  } finally {
    if (!dispatched) {
      await DownloadSession.deleteOne({
        userId: req.userId,
        courseId: compositeCourseId,
      }).catch((err) =>
        console.error(
          `[DownloadSession] Error deleting session on cleanup:`,
          err,
        ),
      );
    }

    // Cleanup temporary files in native mode
    if (tempStampPath) await fs.unlink(tempStampPath).catch(() => {});
    if (tempWarningPath) await fs.unlink(tempWarningPath).catch(() => {});
    if (tempOutputPath) await fs.unlink(tempOutputPath).catch(() => {});
    for (const p of rawPartPaths) {
      if (p) await fs.unlink(p).catch(() => {});
    }
    for (const p of securedPartPaths) {
      if (p) await fs.unlink(p).catch(() => {});
    }
  }
};

// Retrieve raw course PDF (Admin or Authorized Student)
export const getRawCoursePdf = async (req, res) => {
  const { id } = req.params;
  const fileIndex =
    req.query.index !== undefined ? parseInt(req.query.index) : 0;

  try {
    // 1. Fetch user to verify active session
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // 2. Fetch course by custom MongoDB ID
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    // 3. Verify user access: must be admin OR own the course (purchasedCourses)
    if (!userHasCourseAccess(user, course)) {
      return res.status(403).json({
        error: "Access denied: You do not have permissions for this resource",
      });
    }

    const targetUrl =
      course.fileUrls && course.fileUrls.length > 0
        ? course.fileUrls[fileIndex] || course.fileUrl
        : course.fileUrl;
    if (!targetUrl) {
      return res
        .status(404)
        .json({ error: "Raw PDF file URL not found for requested index" });
    }

    // 4. Stream PDF from Cloudflare R2 or local disk, honoring HTTP Range requests so
    // pdf.js can lazily fetch only the byte ranges it needs instead of downloading the
    // whole file before rendering the first page.
    const rangeHeader = req.headers.range;

    if (targetUrl.startsWith("r2://")) {
      const r2Key = targetUrl.replace("r2://", "");
      console.log(
        `[R2 Stream] Serving raw PDF from R2 key: ${r2Key} (index ${fileIndex})${rangeHeader ? ` range=${rangeHeader}` : ""}`,
      );

      const getObjectParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
      };
      if (rangeHeader) getObjectParams.Range = rangeHeader;

      const r2Response = await r2Client.send(
        new GetObjectCommand(getObjectParams),
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", r2Response.ContentLength);

      if (rangeHeader && r2Response.ContentRange) {
        res.status(206);
        res.setHeader("Content-Range", r2Response.ContentRange);
      }

      r2Response.Body.pipe(res);
    } else {
      // Local disk file
      const filePath = path.join(__dirname, "../", targetUrl);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return res
          .status(404)
          .json({ error: "Raw PDF file not found on disk" });
      }

      const fileSize = stat.size;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Accept-Ranges", "bytes");

      const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = match[1] === "" ? 0 : parseInt(match[1], 10);
        const end = match[2] === "" ? fileSize - 1 : parseInt(match[2], 10);

        if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
          res.setHeader("Content-Range", `bytes */${fileSize}`);
          return res.status(416).end();
        }

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        res.setHeader("Content-Length", end - start + 1);
        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.setHeader("Content-Length", fileSize);
        createReadStream(filePath).pipe(res);
      }
    }
  } catch (err) {
    console.error("Error fetching raw PDF:", err);
    res.status(500).json({ error: "Server error retrieving raw PDF" });
  }
};

// Upload (or replace) a course's sample PDF (Admin only)
export const uploadCourseSample = async (req, res) => {
  const { id } = req.params;
  const file = req.file;

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const isAdmin = [
      process.env.ADMIN_EMAIL,
      process.env.ADMIN_EMAIL1,
      process.env.ADMIN_EMAIL2,
    ]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
      .includes((user.email || "").toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: "Access denied: Admin only" });
    }

    if (!file) {
      return res.status(400).json({ error: "Sample PDF file is required" });
    }

    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    // Delete the previous sample from R2 (if any) before uploading the new one
    if (course.sampleFileUrl && course.sampleFileUrl.startsWith("r2://")) {
      const oldKey = course.sampleFileUrl.replace("r2://", "");
      console.log(`[R2 Cleanup] Deleting previous sample from R2: ${oldKey}`);
      try {
        await r2Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: oldKey,
          }),
        );
      } catch (deleteErr) {
        console.warn(
          "[R2 Cleanup] Could not delete previous sample from R2:",
          deleteErr.message,
        );
      }
    }

    console.log(
      `[R2 Upload] Uploading sample ${file.filename} to Cloudflare R2...`,
    );
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: file.filename,
        Body: createReadStream(file.path),
        ContentType: file.mimetype || "application/pdf",
      }),
    );
    console.log(
      `[R2 Upload] Sample uploaded successfully to R2: ${file.filename}`,
    );

    const pageCount = await getSamplePdfPageCount(file.path, file.originalname);

    course.sampleFileUrl = `r2://${file.filename}`;
    course.sampleFileName = file.originalname;
    course.samplePageCount = pageCount;
    await course.save();

    res.json({ message: "Sample uploaded successfully!", course });
  } catch (err) {
    console.error("Error uploading course sample:", err);
    res.status(500).json({ error: "Server error uploading sample" });
  } finally {
    // Delete temp file — unlike the rest of this function's early-return paths,
    // this always runs, so a sample upload never leaves its local temp file
    // behind on disk (matches the cleanup pattern in uploadCourse()).
    if (file && file.path) {
      try {
        await fs.unlink(file.path);
        console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
      } catch (unlinkErr) {
        console.warn(
          `[Cleanup] Failed to delete temp file ${file.path}:`,
          unlinkErr.message,
        );
      }
    }
  }
};

// Remove a course's sample PDF (Admin only)
export const removeCourseSample = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const isAdmin = [
      process.env.ADMIN_EMAIL,
      process.env.ADMIN_EMAIL1,
      process.env.ADMIN_EMAIL2,
    ]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
      .includes((user.email || "").toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: "Access denied: Admin only" });
    }

    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    if (course.sampleFileUrl && course.sampleFileUrl.startsWith("r2://")) {
      const r2Key = course.sampleFileUrl.replace("r2://", "");
      console.log(`[R2 Cleanup] Deleting sample from R2: ${r2Key}`);
      try {
        await r2Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }),
        );
      } catch (deleteErr) {
        console.warn(
          "[R2 Cleanup] Could not delete sample from R2:",
          deleteErr.message,
        );
      }
    }

    course.sampleFileUrl = "";
    course.sampleFileName = "";
    course.samplePageCount = 0;
    await course.save();

    res.json({ message: "Sample removed successfully!", course });
  } catch (err) {
    console.error("Error removing course sample:", err);
    res.status(500).json({ error: "Server error removing sample" });
  }
};

// Serve a course's sample PDF — public, no auth (marketing teaser, not gated content)
export const getCourseSamplePdf = async (req, res) => {
  const { id } = req.params;

  try {
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    const targetUrl = course.sampleFileUrl;
    if (!targetUrl) {
      return res
        .status(404)
        .json({ error: "No sample available for this course" });
    }

    const rangeHeader = req.headers.range;

    if (targetUrl.startsWith("r2://")) {
      const r2Key = targetUrl.replace("r2://", "");
      console.log(
        `[R2 Stream] Serving sample PDF from R2 key: ${r2Key}${rangeHeader ? ` range=${rangeHeader}` : ""}`,
      );

      const getObjectParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
      };
      if (rangeHeader) getObjectParams.Range = rangeHeader;

      const r2Response = await r2Client.send(
        new GetObjectCommand(getObjectParams),
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", r2Response.ContentLength);

      if (rangeHeader && r2Response.ContentRange) {
        res.status(206);
        res.setHeader("Content-Range", r2Response.ContentRange);
      }

      r2Response.Body.pipe(res);
    } else {
      const filePath = path.join(__dirname, "../", targetUrl);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return res.status(404).json({ error: "Sample PDF not found on disk" });
      }

      const fileSize = stat.size;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Accept-Ranges", "bytes");

      const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = match[1] === "" ? 0 : parseInt(match[1], 10);
        const end = match[2] === "" ? fileSize - 1 : parseInt(match[2], 10);

        if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) {
          res.setHeader("Content-Range", `bytes */${fileSize}`);
          return res.status(416).end();
        }

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        res.setHeader("Content-Length", end - start + 1);
        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.setHeader("Content-Length", fileSize);
        createReadStream(filePath).pipe(res);
      }
    }
  } catch (err) {
    console.error("Error fetching sample PDF:", err);
    res.status(500).json({ error: "Server error retrieving sample PDF" });
  }
};

// Retrieve real-time progress of secured PDF download process
export const getDownloadProgress = async (req, res) => {
  const { courseId } = req.params;
  const { index: indexStr } = req.query;
  const fileIndex = indexStr !== undefined ? parseInt(indexStr) : 0;

  try {
    const course = await Course.findOne({ courseId });
    const compositeCourseId =
      course && course.fileUrls && course.fileUrls.length > 1
        ? `${courseId}_${fileIndex}`
        : courseId;

    let userObjectId = null;
    try {
      if (mongoose.Types.ObjectId.isValid(req.userId)) {
        userObjectId = new mongoose.Types.ObjectId(req.userId);
      }
    } catch (err) {}

    const session = await DownloadSession.findOne({
      $or: [
        { userId: req.userId, courseId: compositeCourseId },
        { userId: userObjectId, courseId: compositeCourseId },
      ].filter((q) => q.userId !== null),
    });
    if (!session) {
      return res.json({ step: 0, status: "idle" });
    }
    let status = session.status;
    if (status === "idle" && session.step > 0) {
      status = "processing";
    }
    let error = session.error || null;

    // A stalled "queued"/"processing" session usually means the GitHub Actions
    // job died without ever calling back (e.g. OOM-killed, runner cancelled) —
    // that crash bypasses the script's own failure callback entirely, so
    // nothing ever flips this session out of "processing". Without this check
    // the frontend polls forever and the student is stuck until the 2-hour
    // Mongo TTL silently deletes the session.
    if (
      (status === "processing" || status === "queued") &&
      Date.now() - session.updatedAt.getTime() > STALE_PROCESSING_MS
    ) {
      status = "failed";
      error = "Processing timed out unexpectedly. Please try again.";
      session.status = status;
      session.error = error;
      await session.save();
      await refundDownloadCredit(req.userId, compositeCourseId);
    }

    res.json({
      step: session.step || 0,
      status: status || "processing",
      error,
    });
  } catch (err) {
    console.error(`[DownloadSession] Error retrieving progress:`, err);
    res.status(500).json({ error: "Server error retrieving progress" });
  }
};

// Webhook callback from GitHub Actions PDF processor
export const githubCallback = async (req, res) => {
  const authHeader = req.headers.authorization;
  // process-pdf.js and the GitHub Actions workflow both send this using an env
  // var named CALLBACK_SECRET (see pdf-processor.yml / process-pdf.js) - this
  // used to only check GITHUB_CALLBACK_SECRET, a differently-named variable, so
  // if that wasn't set to the exact same value the webhook would 401 on every
  // call and completion/failure would never be recorded. Accept either name.
  const secret = process.env.CALLBACK_SECRET || process.env.GITHUB_CALLBACK_SECRET;
  // With no secret configured the expected header used to become the literal "Bearer undefined",
  // which anyone could send. Refuse to accept callbacks at all until a secret is set.
  if (!secret) {
    console.error("[GitHub Callback] No CALLBACK_SECRET configured - rejecting callback");
    return res.status(503).json({ error: "Callback not configured" });
  }
  const expectedSecret = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authHeader || "");
  if (
    provided.length !== expectedSecret.length ||
    !crypto.timingSafeEqual(provided, expectedSecret)
  ) {
    console.warn("[GitHub Callback] Unauthorized webhook callback attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { status, courseId, userId, destinationKey, step, error, licenseId } = req.body;
  console.log(
    `[GitHub Callback] Received update. status: ${status}, courseId: ${courseId}, userId: ${userId}, step: ${step}, license: ${licenseId || "-"}`,
  );

  if (status === "progress") {
    await setSessionProgress(userId, courseId, step, "processing");
  } else if (status === "completed") {
    await setSessionProgress(userId, courseId, 9, "completed");
    if (licenseId) {
      await DownloadLog.updateOne({ licenseId, status: "queued" }, { status: "ready" }).catch(() => {});
    }
    console.log(
      `[GitHub Callback] PDF processing completed successfully. Key: ${destinationKey}`,
    );
  } else if (status === "failed") {
    // Only a job that is still queued can fail-and-refund. Once a license is ready/delivered the file
    // exists, so a late or replayed "failed" call must not hand the student their credit back.
    let mayRefund = true;
    if (licenseId) {
      const moved = await DownloadLog.updateOne({ licenseId, status: "queued" }, { status: "failed" });
      mayRefund = moved.modifiedCount > 0;
    }
    if (mayRefund) {
      await setSessionProgress(
        userId,
        courseId,
        0,
        "failed",
        error || "Processing failed",
      );
      console.error(`[GitHub Callback] PDF processing failed: ${error}`);
      await refundDownloadCredit(userId, courseId);
    } else {
      console.warn(`[GitHub Callback] Ignored failure report for license ${licenseId} (not in queued state)`);
    }
  }

  res.json({ status: "ok" });
};

// Admin: trace a leaked PDF. Search by the License ID printed on its pages (or by email / name / user id /
// course) to see who the copy was issued to, when, and from which IP.
export const listDownloadLogs = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegExp(q), "i");
      filter.$or = [{ licenseId: rx }, { userEmail: rx }, { userName: rx }, { courseName: rx }];
      if (mongoose.isValidObjectId(q)) filter.$or.push({ userId: q });
    }
    const logs = await DownloadLog.find(filter).sort({ issuedAt: -1 }).limit(limit).lean();
    res.json({ logs });
  } catch (err) {
    console.error("Error listing download logs:", err);
    res.status(500).json({ error: "Server error listing download logs" });
  }
};

// Retrieve a piece of admin-editable site text by key (public — shown to guests too)
export const getSiteContent = async (req, res) => {
  const { key } = req.params;
  try {
    const doc = await SiteContent.findOne({ key });
    res.json({ key, value: doc?.value || "" });
  } catch (err) {
    console.error("Error fetching site content:", err);
    res.status(500).json({ error: "Server error fetching site content" });
  }
};

// Update a piece of admin-editable site text by key (Admin only)
export const updateSiteContent = async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const isAdmin = [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
      .includes((user.email || "").toLowerCase());
    if (!isAdmin) {
      return res.status(403).json({ error: "Access denied: Admin only" });
    }

    const doc = await SiteContent.findOneAndUpdate(
      { key },
      { value: value || "" },
      { upsert: true, new: true },
    );
    res.json({ key, value: doc.value });
  } catch (err) {
    console.error("Error updating site content:", err);
    res.status(500).json({ error: "Server error updating site content" });
  }
};
