import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import bwipjs from "bwip-js";
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

// Checkout Shopping Cart (Mock Payment)
export const checkoutCart = async (req, res) => {
  const { courseIds } = req.body; // Array of Course IDs

  if (!courseIds || !Array.isArray(courseIds) || courseIds.length === 0) {
    return res
      .status(400)
      .json({ error: "Invalid or empty courseIds array provided" });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User profile not found" });
    }

    // Add unique course IDs to user's purchasedCourses list
    const currentPurchases = user.purchasedCourses.map((id) => id.toString());
    courseIds.forEach((id) => {
      if (!currentPurchases.includes(id)) {
        user.purchasedCourses.push(id);
      }
    });

    await user.save();

    res.json({
      message: "Checkout successful! Payment Completed.",
      purchasedCoursesCount: user.purchasedCourses.length,
    });
  } catch (err) {
    console.error("Error checking out cart:", err);
    res
      .status(500)
      .json({ error: "Server error during mock payment checkout" });
  }
};

// Retrieve user's purchased courses
export const getPurchasedCourses = async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate("purchasedCourses");
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

// Handle secured PDF download with top watermarks and bottom barcode
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

    compositeCourseId =
      course.fileUrls && course.fileUrls.length > 1
        ? `${courseId}_${fileIndex}`
        : courseId;

    // Initialize tracking only if not checkOnly
    if (checkOnly !== "true") {
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
    if (checkOnly !== "true") {
      await setSessionProgress(req.userId, compositeCourseId, 2, "idle");
    }

    // Step 3 starts only if not checkOnly
    if (checkOnly !== "true") {
      await setSessionProgress(req.userId, compositeCourseId, 3, "idle");
    }

    // 3. Verify user has access to this course (check if interestedCourses contains courseId)
    console.log(`[PDF Security] Step 3: Verifying student course permissions`);
    const interestedList = Array.isArray(user.interestedCourses)
      ? user.interestedCourses
      : [];
    const hasAccess = interestedList.some(
      (id) => id.toLowerCase() === courseId.toLowerCase(),
    );

    if (!hasAccess) {
      console.log(
        `[PDF Security] Step 3: Access denied for user ${user.email} on course ${courseId}`,
      );
      return res
        .status(403)
        .json({
          error: "Access denied: This course is not in your interested list",
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

    if (mode === "github-actions") {
      const destinationKey = `secured-${req.userId}-${courseId}${course.fileUrls && course.fileUrls.length > 1 ? `_${fileIndex}` : ""}.pdf`;

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

      let callbackUrl = `${req.protocol}://${req.get("host")}/api/courses/github-callback`;
      if (process.env.BACKEND_URL) {
        callbackUrl = `${process.env.BACKEND_URL.replace(/\/$/, "")}/api/courses/github-callback`;
      }

      const dispatchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/pdf-processor.yml/dispatches`;

      console.log(
        `[PDF Security] Triggering GitHub workflow dispatch at: ${dispatchUrl}`,
      );

      try {
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

    // --- MODE 1: CLIENT-SIDE PROCESSING ---
    if (mode === "client-side") {
      // Fall back to server-native if the course is multi-part, since concatenated PDFs are invalid
      if (partUrls.length > 1) {
        console.log(
          `[PDF Security] Client-side Mode: Multi-part course detected. Automatically falling back to server-native mode.`,
        );
        mode = "server-native";
      } else {
        res.setHeader("x-download-mode", "client-side");
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${course.fileName.replace(/\s+/g, "_")}_raw.pdf"`,
        );

        if (course.fileUrl.startsWith("r2://")) {
          const r2Key = course.fileUrl.replace("r2://", "");
          console.log(
            `[PDF Security] Client-side Mode: Proxy streaming from Cloudflare R2 (key: ${r2Key})`,
          );
          const r2Response = await r2Client.send(
            new GetObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: r2Key,
            }),
          );

          r2Response.Body.pipe(res);
        } else {
          console.log(
            `[PDF Security] Client-side Mode: Streaming from local disk`,
          );
          const filePath = path.join(__dirname, "../", course.fileUrl);
          const fileStream = createReadStream(filePath);
          fileStream.pipe(res);
        }
        return;
      }
    }

    // --- MODE 2: SERVER-SIDE NATIVE (QPDF) PROCESSING ---
    if (mode === "server-native") {
      await setSessionProgress(req.userId, courseId, 5, "processing");

      // Ensure temp directory exists
      const tempDir = path.join(__dirname, "../uploads/temp");
      await fs.mkdir(tempDir, { recursive: true });

      tempStampPath = path.join(tempDir, `stamp_${req.userId}_${courseId}.pdf`);
      tempWarningPath = path.join(
        tempDir,
        `warning_${req.userId}_${courseId}.pdf`,
      );
      tempOutputPath = path.join(
        tempDir,
        `output_${req.userId}_${courseId}.pdf`,
      );

      let totalPages = 0;
      let firstPageWidth = 595.276; // Default A4
      let firstPageHeight = 841.89;

      // 5. Download and process parts sequentially to save memory
      for (let i = 0; i < partUrls.length; i++) {
        const partUrl = partUrls[i];
        const rawPartPath = path.join(
          tempDir,
          `part_${i}_raw_${req.userId}_${courseId}.pdf`,
        );
        const securedPartPath = path.join(
          tempDir,
          `part_${i}_secured_${req.userId}_${courseId}.pdf`,
        );
        rawPartPaths.push(rawPartPath);
        securedPartPaths.push(securedPartPath);

        if (partUrl.startsWith("r2://")) {
          const r2Key = partUrl.replace("r2://", "");
          console.log(
            `[PDF Security] Native Mode: Downloading part ${i + 1}/${partUrls.length} from R2 (key: ${r2Key})`,
          );
          const r2Response = await r2Client.send(
            new GetObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: r2Key,
            }),
          );
          await pipeline(r2Response.Body, createWriteStream(rawPartPath));
        } else {
          console.log(
            `[PDF Security] Native Mode: Copying local part ${i + 1}/${partUrls.length}`,
          );
          const localFilePath = path.join(__dirname, "../", partUrl);
          await fs.copyFile(localFilePath, rawPartPath);
        }

        // Get dimensions and page count of part using qpdf
        const { stdout: qpdfInfo } = await execPromise(
          `qpdf --show-pages "${rawPartPath}"`,
        );
        const partPageCount = (qpdfInfo.match(/page \d+:/g) || []).length;
        totalPages += partPageCount;

        if (i === 0) {
          const sizeMatch = qpdfInfo.match(
            /page 1:[^]*?size: ([\d.]+) x ([\d.]+)/i,
          );
          if (sizeMatch) {
            firstPageWidth = parseFloat(sizeMatch[1]);
            firstPageHeight = parseFloat(sizeMatch[2]);
          }
        }
      }
      console.log(
        `[PDF Security] Native Mode: All parts downloaded. Total pages: ${totalPages}`,
      );

      await setSessionProgress(req.userId, courseId, 6, "processing");

      // 6. Generate barcode buffer
      console.log(`[PDF Security] Native Mode: Generating user barcode`);
      let barcodePngBuffer = await new Promise((resolve, reject) => {
        bwipjs.toBuffer(
          {
            bcid: "code128",
            text: user._id.toString(),
            scale: 2,
            height: 10,
            includetext: true,
            textxalign: "center",
          },
          (err, png) => {
            if (err) reject(err);
            else resolve(png);
          },
        );
      });

      await setSessionProgress(req.userId, courseId, 7, "processing");

      // Create stamp PDF (1 page with watermark & barcode)
      console.log(`[PDF Security] Native Mode: Creating watermark stamp PDF`);
      const stampDoc = await PDFDocument.create();
      const helveticaFont = await stampDoc.embedFont("Helvetica");
      const helveticaBoldFont = await stampDoc.embedFont("Helvetica-Bold");
      const stampPage = stampDoc.addPage([firstPageWidth, firstPageHeight]);

      const watermarkText = `Name: ${user.fullName || user.name}  |  Email: ${user.email}  |  Mobile: ${user.mobileNumber || "N/A"}`;
      stampPage.drawText(watermarkText, {
        x: 25,
        y: firstPageHeight - 25,
        size: 9,
        font: helveticaFont,
        color: rgb(0.6, 0.6, 0.6),
      });

      const barcodeImage = await stampDoc.embedPng(barcodePngBuffer);
      const barcodeWidth = 90;
      const barcodeHeight = 20;
      stampPage.drawImage(barcodeImage, {
        x: firstPageWidth - barcodeWidth - 25,
        y: 15,
        width: barcodeWidth,
        height: barcodeHeight,
      });

      drawInvisibleTracking(stampPage, user._id.toString(), helveticaFont);

      const stampBytes = await stampDoc.save();
      await fs.writeFile(tempStampPath, stampBytes);

      // Create warning PDF (1 page)
      console.log(`[PDF Security] Native Mode: Creating warning page PDF`);
      const warningDoc = await PDFDocument.create();
      const warningPage = warningDoc.addPage([firstPageWidth, firstPageHeight]);
      drawSecurityWarningPage(
        warningPage,
        user,
        course,
        helveticaFont,
        helveticaBoldFont,
      );
      const warningBytes = await warningDoc.save();
      await fs.writeFile(tempWarningPath, warningBytes);

      // 7. Apply watermark stamp to each part sequentially
      for (let i = 0; i < partUrls.length; i++) {
        console.log(
          `[PDF Security] Native Mode: Watermarking part ${i + 1}/${partUrls.length}`,
        );
        const qpdfStampCmd = `qpdf "${rawPartPaths[i]}" --overlay "${tempStampPath}" --repeat=1-z -- "${securedPartPaths[i]}"`;
        await execPromise(qpdfStampCmd);
        // Clean up the raw file immediately
        await fs.unlink(rawPartPaths[i]).catch(() => {});
      }

      await setSessionProgress(req.userId, courseId, 8, "processing");

      // Determine warning page positions in global page space.
      // The first warning page always lands exactly on page 2.
      const numPagesToAdd = Math.max(1, Math.floor(totalPages / 50));
      const insertPositions = [2];
      for (let j = 1; j < numPagesToAdd; j++) {
        insertPositions.push(Math.floor(Math.random() * (totalPages + 1)) + 1);
      }
      insertPositions.sort((a, b) => a - b);

      // Get page counts of each secured part
      const partPageCounts = [];
      for (let i = 0; i < securedPartPaths.length; i++) {
        const { stdout: partInfo } = await execPromise(
          `qpdf --show-pages "${securedPartPaths[i]}"`,
        );
        const count = (partInfo.match(/page \d+:/g) || []).length;
        partPageCounts.push(count);
      }

      // Map insertPositions globally to construct pages list
      const qpdfPages = [];
      let currentPartIdx = 0;
      let currentPartPageStart = 1;
      let globalPageCursor = 1;

      for (const insertPos of insertPositions) {
        while (currentPartIdx < securedPartPaths.length) {
          const partLength = partPageCounts[currentPartIdx];
          const partGlobalEnd =
            globalPageCursor + (partLength - currentPartPageStart);

          if (insertPos <= partGlobalEnd) {
            const localInsertOffset = insertPos - globalPageCursor;
            const localInsertPage = currentPartPageStart + localInsertOffset;

            if (localInsertPage > currentPartPageStart) {
              qpdfPages.push(
                `"${securedPartPaths[currentPartIdx]}"`,
                `${currentPartPageStart}-${localInsertPage - 1}`,
              );
            }
            qpdfPages.push(`"${tempWarningPath}"`, `1`);

            currentPartPageStart = localInsertPage;
            globalPageCursor = insertPos;
            break;
          } else {
            if (currentPartPageStart <= partLength) {
              qpdfPages.push(
                `"${securedPartPaths[currentPartIdx]}"`,
                `${currentPartPageStart}-z`,
              );
            }
            globalPageCursor += partLength - currentPartPageStart + 1;
            currentPartIdx++;
            currentPartPageStart = 1;
          }
        }
      }

      while (currentPartIdx < securedPartPaths.length) {
        const partLength = partPageCounts[currentPartIdx];
        if (currentPartPageStart <= partLength) {
          qpdfPages.push(
            `"${securedPartPaths[currentPartIdx]}"`,
            `${currentPartPageStart}-z`,
          );
        }
        currentPartIdx++;
        currentPartPageStart = 1;
      }

      // 8. Execute qpdf to merge stamped parts, insert warnings, and encrypt
      console.log(
        `[PDF Security] Native Mode: Running final qpdf merge & encrypt`,
      );
      let userPassword = user.email.trim().toLowerCase();
      if (
        user.mobileNumber &&
        user.mobileNumber.trim() !== "N/A" &&
        user.mobileNumber.trim() !== ""
      ) {
        const digits = user.mobileNumber.replace(/\D/g, "");
        userPassword = digits.length >= 10 ? digits.slice(-10) : digits;
      }

      const qpdfCommand = `qpdf --empty --pages ${qpdfPages.join(" ")} -- --encrypt "${userPassword}" "${userPassword}" 256 -- "${tempOutputPath}"`;
      await execPromise(qpdfCommand);

      await setSessionProgress(req.userId, courseId, 9, "completed");

      // Stream output file
      const outputStats = await fs.stat(tempOutputPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${course.fileName.replace(/\s+/g, "_")}_secured.pdf"`,
      );
      res.setHeader("Content-Length", outputStats.size);

      await pipeline(createReadStream(tempOutputPath), res);
      console.log(
        `[PDF Security] Native Mode: Secured PDF streamed successfully!`,
      );
      return;
    }

    // --- MODE 3: SERVER-SIDE JS (FALLBACK) PROCESSING ---
    if (mode === "server-js") {
      await setSessionProgress(req.userId, courseId, 5, "processing");

      const pdfDocs = [];
      for (let i = 0; i < partUrls.length; i++) {
        const partUrl = partUrls[i];
        let pdfBuffer;
        if (partUrl.startsWith("r2://")) {
          const r2Key = partUrl.replace("r2://", "");
          console.log(
            `[PDF Security] JS Mode: Loading part ${i + 1}/${partUrls.length} from Cloudflare R2 (key: ${r2Key})`,
          );
          const r2Response = await r2Client.send(
            new GetObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: r2Key,
            }),
          );
          pdfBuffer = Buffer.from(await r2Response.Body.transformToByteArray());
        } else {
          console.log(
            `[PDF Security] JS Mode: Loading part ${i + 1}/${partUrls.length} from local disk`,
          );
          const filePath = path.join(__dirname, "../", partUrl);
          pdfBuffer = await fs.readFile(filePath);
        }
        const doc = await PDFDocument.load(pdfBuffer);
        pdfDocs.push(doc);
      }

      await setSessionProgress(req.userId, courseId, 6, "processing");

      let barcodePngBuffer = await new Promise((resolve, reject) => {
        bwipjs.toBuffer(
          {
            bcid: "code128",
            text: user._id.toString(),
            scale: 2,
            height: 10,
            includetext: true,
            textxalign: "center",
          },
          (err, png) => {
            if (err) reject(err);
            else resolve(png);
          },
        );
      });

      await setSessionProgress(req.userId, courseId, 7, "processing");

      const mergedPdfDoc = await PDFDocument.create();
      const barcodeImage = await mergedPdfDoc.embedPng(barcodePngBuffer);
      const helveticaFont = await mergedPdfDoc.embedFont("Helvetica");
      const helveticaBoldFont = await mergedPdfDoc.embedFont("Helvetica-Bold");

      mergedPdfDoc.setTitle(course.name || "Secured Course PDF");
      mergedPdfDoc.setAuthor(user.email);
      mergedPdfDoc.setSubject(course.subject || "Syllabus Course Content");
      mergedPdfDoc.setProducer("The Dark Horse UPSC");
      mergedPdfDoc.setCreator("The Dark Horse UPSC");
      mergedPdfDoc.setKeywords([user._id.toString(), user.email]);

      const watermarkText = `Name: ${user.fullName || user.name}  |  Email: ${user.email}  |  Mobile: ${user.mobileNumber || "N/A"}`;

      let totalOriginalPages = 0;
      for (const doc of pdfDocs) {
        const copiedPages = await mergedPdfDoc.copyPages(
          doc,
          doc.getPageIndices(),
        );
        for (const page of copiedPages) {
          const { width, height } = page.getSize();

          page.drawText(watermarkText, {
            x: 25,
            y: height - 25,
            size: 9,
            font: helveticaFont,
            color: rgb(0.6, 0.6, 0.6),
          });

          const barcodeWidth = 90;
          const barcodeHeight = 20;
          page.drawImage(barcodeImage, {
            x: width - barcodeWidth - 25,
            y: 15,
            width: barcodeWidth,
            height: barcodeHeight,
          });

          drawInvisibleTracking(page, user._id.toString(), helveticaFont);

          mergedPdfDoc.addPage(page);
          totalOriginalPages++;
        }
      }

      if (totalOriginalPages > 0) {
        const firstPage = mergedPdfDoc.getPages()[0];
        const { width, height } = firstPage.getSize();
        const numPagesToAdd = Math.max(1, Math.floor(totalOriginalPages / 50));
        // First warning page always lands exactly on page 2 (index 1).
        const insertIndices = [1];
        let currentPagesCount = totalOriginalPages + 1;
        for (let j = 1; j < numPagesToAdd; j++) {
          let maxIdx = currentPagesCount;
          let minIdx = 2;
          insertIndices.push(
            Math.floor(Math.random() * (maxIdx - minIdx + 1)) + minIdx,
          );
          currentPagesCount++;
        }
        insertIndices.sort((a, b) => a - b);
        for (const insertIdx of insertIndices) {
          const newPage = mergedPdfDoc.insertPage(insertIdx, [width, height]);
          drawSecurityWarningPage(
            newPage,
            user,
            course,
            helveticaFont,
            helveticaBoldFont,
          );
        }
      }

      await setSessionProgress(req.userId, courseId, 8, "processing");
      const modifiedPdfBuffer = await mergedPdfDoc.save({
        useObjectStreams: false,
        updateFieldAppearances: false,
      });

      await setSessionProgress(req.userId, courseId, 9, "completed");
      let userPassword = user.email.trim().toLowerCase();
      if (
        user.mobileNumber &&
        user.mobileNumber.trim() !== "N/A" &&
        user.mobileNumber.trim() !== ""
      ) {
        const digits = user.mobileNumber.replace(/\D/g, "");
        userPassword = digits.length >= 10 ? digits.slice(-10) : digits;
      }
      const encryptedPdfBuffer = await encryptPDF(
        modifiedPdfBuffer,
        userPassword,
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${course.fileName.replace(/\s+/g, "_")}_secured.pdf"`,
      );
      res.setHeader("Content-Length", encryptedPdfBuffer.length);
      res.end(Buffer.from(encryptedPdfBuffer));
      console.log(
        `[PDF Security] JS Mode: Secured and password-protected PDF streamed successfully!`,
      );
      return;
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

// Helper function to wrap text for PDF rendering
const wrapText = (text, maxWidth, font, fontSize) => {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
};

// Tiles the tracking token across the whole page at near-zero opacity. Invisible
// at normal reading opacity, but a leaked page still reveals the token under a
// basic contrast/levels boost (e.g. autocontrast in any image editor) — unlike
// the visible watermark/barcode or PDF metadata, this survives cropping (it
// covers the full page, not just the margins) and survives flattening/re-export
// to a new PDF, since it's baked into the rendered page content itself.
const drawInvisibleTracking = (page, token, font) => {
  const { width, height } = page.getSize();
  const fontSize = 6;
  const textWidth = font.widthOfTextAtSize(token, fontSize);
  const stepX = textWidth + 70;
  const stepY = 45;
  const angle = degrees(28);

  let row = 0;
  for (let y = -40; y < height + 40; y += stepY) {
    const xOffset = (row % 2) * (stepX / 2);
    for (let x = -80 + xOffset; x < width + 80; x += stepX) {
      page.drawText(token, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity: 0.025,
        rotate: angle,
      });
    }
    row++;
  }
};

// Helper function to draw warning details on a newly inserted page
const drawSecurityWarningPage = (page, user, course, font, boldFont) => {
  const { width, height } = page.getSize();

  // Draw a subtle border or background card
  page.drawRectangle({
    x: 40,
    y: 40,
    width: width - 80,
    height: height - 80,
    borderColor: rgb(0.8, 0.2, 0.2),
    borderWidth: 2.5,
    color: rgb(0.99, 0.98, 0.98),
  });

  // Top header red bar
  page.drawRectangle({
    x: 40,
    y: height - 90,
    width: width - 80,
    height: 50,
    color: rgb(0.75, 0.15, 0.15),
  });

  // Draw header text
  const titleText = "SECURITY NOTICE & LICENSE AGREEMENT";
  const titleWidth = boldFont.widthOfTextAtSize(titleText, 13);
  page.drawText(titleText, {
    x: (width - titleWidth) / 2,
    y: height - 70,
    size: 13,
    font: boldFont,
    color: rgb(1, 1, 1),
  });

  let currentY = height - 120;

  // Draw License info box header
  page.drawText("LICENSE REGISTRATION DETAILS", {
    x: 60,
    y: currentY,
    size: 11,
    font: boldFont,
    color: rgb(0.2, 0.2, 0.2),
  });

  currentY -= 25;

  // Draw licensee details
  const details = [
    {
      label: "Authorized Licensee:",
      value: user.fullName || user.name || "N/A",
    },
    { label: "Registered Email:", value: user.email },
    { label: "Mobile Number:", value: user.mobileNumber || "N/A" },
    { label: "License Tracking ID:", value: user._id.toString() },
    { label: "Document Name:", value: course.name || "N/A" },
  ];

  details.forEach((item) => {
    page.drawText(item.label, {
      x: 70,
      y: currentY,
      size: 9.5,
      font: boldFont,
      color: rgb(0.35, 0.35, 0.35),
    });
    page.drawText(item.value, {
      x: 210,
      y: currentY,
      size: 9.5,
      font: font,
      color: rgb(0.1, 0.1, 0.1),
    });
    currentY -= 18;
  });

  currentY -= 15;

  // Divider
  page.drawLine({
    start: { x: 60, y: currentY },
    end: { x: width - 60, y: currentY },
    color: rgb(0.85, 0.85, 0.85),
    thickness: 1,
  });

  currentY -= 25;

  // Draw warning details
  page.drawText("LEGAL TERMS & SHARE RESTRICTIONS", {
    x: 60,
    y: currentY,
    size: 11,
    font: boldFont,
    color: rgb(0.75, 0.15, 0.15),
  });

  currentY -= 20;

  const warningParagraphs = [
    "1. LICENSED USE: This document is uniquely registered to the individual named above and is intended solely for the registered user’s personal educational use.",
    "2. PROHIBITED SHARING: It is strictly prohibited to share, publish, distribute, resell, or upload this PDF to any private/public forum, website, Telegram channel, Google Drive, WhatsApp group, or social media platform.",
    "3. SECURITY TRACING: This document is embedded with active visible watermarks and dynamic, invisible steganographic tracking signatures. Any leaked copies found online will be auto-scanned to retrieve these tracking IDs.",
    "4. LEGAL CONSEQUENCES: Unauthorized sharing, distribution and reproduction of this document constitutes a breach of this license agreement. Violations will result in immediate termination of access without refund and initiation of appropriate legal proceedings."
  ];

  warningParagraphs.forEach((p) => {
    const lines = wrapText(p, width - 120, font, 9);
    lines.forEach((line) => {
      page.drawText(line, {
        x: 65,
        y: currentY,
        size: 9,
        font: font,
        color: rgb(0.25, 0.25, 0.25),
      });
      currentY -= 14;
    });
    currentY -= 6; // gap between paragraphs
  });

  currentY -= 10;

  // Styled callout box for the tracking/enforcement note
  const noteText =
    "NOTE - This document is individually licensed and embedded with traceable ownership credentials, both VISIBLE and INVISIBLE based on license tracking id. Any unauthorized acquisition and distribution will result in enforcement of appropriate legal remedies, without further notice.";
  const noteLines = wrapText(noteText, width - 150, boldFont, 8.5);
  const noteBoxPadding = 10;
  const noteBoxHeight = noteLines.length * 13 + noteBoxPadding * 2;
  const noteBoxTop = currentY;
  const noteBoxY = noteBoxTop - noteBoxHeight;

  page.drawRectangle({
    x: 60,
    y: noteBoxY,
    width: width - 120,
    height: noteBoxHeight,
    color: rgb(0.98, 0.94, 0.88),
    borderColor: rgb(0.85, 0.55, 0.1),
    borderWidth: 1,
  });

  let noteY = noteBoxTop - noteBoxPadding - 2;
  noteLines.forEach((line) => {
    page.drawText(line, {
      x: 70,
      y: noteY,
      size: 8.5,
      font: boldFont,
      color: rgb(0.55, 0.32, 0.02),
    });
    noteY -= 13;
  });

  currentY = noteBoxY - 15;
  // Footer message
  const footerText =
    "Thank you for supporting honest learning and respecting authors' copy rights.";
  const footerW = font.widthOfTextAtSize(footerText, 8.5);
  page.drawText(footerText, {
    x: (width - footerW) / 2,
    y: currentY,
    size: 8.5,
    font: font,
    color: rgb(0.5, 0.5, 0.5),
  });
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

    // 3. Verify user access: must be admin OR have courseId in interestedCourses
    const isAdmin = [
      process.env.ADMIN_EMAIL,
      process.env.ADMIN_EMAIL1,
      process.env.ADMIN_EMAIL2,
    ]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
      .includes((user.email || "").toLowerCase());
    const interestedList = Array.isArray(user.interestedCourses)
      ? user.interestedCourses
      : [];
    const hasAccess = interestedList.some(
      (cId) => cId.toLowerCase() === course.courseId.toLowerCase(),
    );

    if (!isAdmin && !hasAccess) {
      return res
        .status(403)
        .json({
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
    res.json({
      step: session.step || 0,
      status: status || "processing",
      error: session.error || null,
    });
  } catch (err) {
    console.error(`[DownloadSession] Error retrieving progress:`, err);
    res.status(500).json({ error: "Server error retrieving progress" });
  }
};

// Webhook callback from GitHub Actions PDF processor
export const githubCallback = async (req, res) => {
  const authHeader = req.headers.authorization;
  const expectedSecret = `Bearer ${process.env.GITHUB_CALLBACK_SECRET}`;

  if (!authHeader || authHeader !== expectedSecret) {
    console.warn("[GitHub Callback] Unauthorized webhook callback attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { status, courseId, userId, destinationKey, step, error } = req.body;
  console.log(
    `[GitHub Callback] Received update. status: ${status}, courseId: ${courseId}, userId: ${userId}, step: ${step}`,
  );

  if (status === "progress") {
    await setSessionProgress(userId, courseId, step, "processing");
  } else if (status === "completed") {
    await setSessionProgress(userId, courseId, 9, "completed");
    console.log(
      `[GitHub Callback] PDF processing completed successfully. Key: ${destinationKey}`,
    );
  } else if (status === "failed") {
    await setSessionProgress(
      userId,
      courseId,
      0,
      "failed",
      error || "Processing failed",
    );
    console.error(`[GitHub Callback] PDF processing failed: ${error}`);
  }

  res.json({ status: "ok" });
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
