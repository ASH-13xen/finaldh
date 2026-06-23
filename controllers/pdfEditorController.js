import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  PDFDocument,
  PDFRawStream,
  PDFArray,
  PDFName,
  decodePDFRawStream,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "../config/r2.js";
import Course from "../models/Course.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the user_edits directory exists
const userEditsDir = path.join(__dirname, "../uploads/user_edits");
if (!fsSync.existsSync(userEditsDir)) {
  fsSync.mkdirSync(userEditsDir, { recursive: true });
}

// 1. Initialize PDF for Editing (copy course PDF or prepare uploaded PDF)
export const initPDFEdit = async (req, res) => {
  const { courseId } = req.body;
  const file = req.file;

  console.log(
    `[Init-Edit] Session initialization request received. courseId: ${courseId || "none"}, file: ${file ? file.originalname : "none"}`,
  );

  try {
    let sourcePath = "";
    let originalName = "";
    let isR2 = false;
    let r2Key = "";

    if (courseId) {
      console.log(
        `[Init-Edit] Retrieving purchased course details for ID: ${courseId}`,
      );
      const course = await Course.findById(courseId);
      if (!course) {
        console.error(
          `[Init-Edit] Error: Purchased course not found for ID: ${courseId}`,
        );
        return res.status(404).json({ error: "Course not found" });
      }
      originalName = course.fileName || "course.pdf";
      if (course.fileUrl.startsWith("r2://")) {
        isR2 = true;
        r2Key = course.fileUrl.replace("r2://", "");
        console.log(
          `[Init-Edit] Found course database entry stored in Cloudflare R2 (key: ${r2Key})`,
        );
      } else {
        sourcePath = path.join(__dirname, "../", course.fileUrl);
        console.log(
          `[Init-Edit] Found course database entry stored locally. Path: ${sourcePath}`,
        );
      }
    } else if (file) {
      sourcePath = file.path;
      originalName = file.originalname || "document.pdf";
      console.log(
        `[Init-Edit] Custom PDF upload detected. Temp path: ${sourcePath}, Name: ${originalName}`,
      );
    } else {
      console.warn(
        "[Init-Edit] Warning: Neither courseId nor custom file was provided.",
      );
      return res.status(400).json({
        error:
          "Either courseId or file upload is required to initialize editing",
      });
    }

    // Verify source file exists (only if it's local)
    if (!isR2) {
      console.log(
        `[Init-Edit] Checking source file existence at: ${sourcePath}`,
      );
      try {
        await fs.access(sourcePath);
        console.log(`[Init-Edit] Confirmed source file exists.`);
      } catch (accessErr) {
        console.error(
          `[Init-Edit] Error: Source PDF file does not exist at path: ${sourcePath}`,
          accessErr,
        );
        return res.status(404).json({ error: "Source PDF file not found." });
      }
    }

    // Generate unique edit ID and copy the file to user_edits
    const uniqueId = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const sanitizedOriginalName = originalName.replace(/\s+/g, "_");
    const editFileName = `edited-${uniqueId}-${sanitizedOriginalName}`;
    const destinationPath = path.join(userEditsDir, editFileName);
    console.log(`[Init-Edit] Generated session file details:`);
    console.log(`  - Session Edit ID: ${editFileName}`);
    console.log(`  - Destination Path: ${destinationPath}`);

    if (courseId) {
      if (isR2) {
        console.log(
          `[Init-Edit] Fetching raw PDF from Cloudflare R2 key: ${r2Key} to edit session destination...`,
        );
        const r2Response = await r2Client.send(
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }),
        );

        await new Promise((resolve, reject) => {
          const writeStream = fsSync.createWriteStream(destinationPath);
          r2Response.Body.pipe(writeStream);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
        console.log(`[Init-Edit] Copy from R2 completed successfully.`);
      } else {
        console.log(
          `[Init-Edit] Copying local database course file to edit session...`,
        );
        await fs.copyFile(sourcePath, destinationPath);
        console.log(`[Init-Edit] Copy operation completed successfully.`);
      }
    } else if (file) {
      console.log(`[Init-Edit] Moving custom uploaded file to edit session...`);
      await fs.rename(sourcePath, destinationPath);
      console.log(`[Init-Edit] Move operation completed successfully.`);
    }

    const fileUrl = `/uploads/user_edits/${editFileName}`;
    console.log(
      `[Init-Edit] PDF editing session successfully initialized. Client URL: ${fileUrl}`,
    );

    res.json({
      message: "PDF editing session initialized.",
      editId: editFileName,
      url: fileUrl,
      fileName: originalName,
    });
  } catch (err) {
    console.error(
      "[Init-Edit] Fatal error during PDF edit session initialization:",
      err,
    );
    res
      .status(500)
      .json({ error: "Server error initializing PDF edit session" });
  }
};

// 2. Call Gemini to Auto-Detect Question Text, Cleaned Text, and Bounding Box
export const detectPrefix = async (req, res) => {
  const { image } = req.body; // base64 JPEG from frontend canvas

  console.log(
    `[Detect-Prefix] Received prefix detection request. Image payload size: ${image ? image.length : 0} characters.`,
  );

  if (!image) {
    console.error("[Detect-Prefix] Error: Base64 image payload is missing.");
    return res
      .status(400)
      .json({ error: "Base64 image data is required for prefix detection" });
  }

  try {
    console.log("[Detect-Prefix] Fetching and validating Gemini API key...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      console.error(
        "[Detect-Prefix] Error: Gemini API key is missing or default.",
      );
      return res
        .status(550)
        .json({ error: "Gemini API key is not configured in backend .env" });
    }

    console.log(
      "[Detect-Prefix] Initializing Google Generative AI model 'gemini-3.5-flash'...",
    );
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    // Prepare image part for Gemini multimodal API
    console.log(
      "[Detect-Prefix] Slicing image headers and preparing base64 part payload...",
    );
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType: "image/jpeg",
      },
    };

    const prompt = `
You are an expert exam question OCR engine. Analyze this page image from an exam answer sheet.
The typed question is printed at the top of the page. The question will only be written at the top in the form of computer text (printed/typed text), NOT handwritten text, and NOT text in a colored strip below the topper's details strip.
Some questions start with a question number prefix like "q5).", "q5)", "Q5.", "Question 5.", "5(a)", "Q.5.", etc.
Your job is to:
1. Extract the full text of the question (in English).
2. Identify the exact prefix (like "q5).") at the start.
3. Clean the question text by removing this prefix, keeping only the rest of the question starting with the actual first word (e.g., "Explain...", "Discuss...", "What...").
4. Identify the bounding box coordinates of the entire printed question area (so we can strip it).

Return your response strictly as a JSON object containing:
{
  "originalText": "The full text of the question including the prefix",
  "cleanedText": "The text of the question with the prefix removed",
  "prefixText": "The exact prefix text found (e.g., 'q5).') or null if none",
  "boundingBox": {
    "ymin": integer (0 to 1000, distance from top edge),
    "xmin": integer (0 to 1000, distance from left edge),
    "ymax": integer (0 to 1000, distance from top edge),
    "xmax": integer (0 to 1000, distance from left edge)
  }
}

Note: Coordinates should be scaled from 0 to 1000. ymin/ymax represent the top/bottom boundary of the question text box. xmin/xmax represent the left/right boundary.
`;

    console.log("[Detect-Prefix] Calling Gemini generateContent API...");
    const response = await model.generateContent([prompt, imagePart]);
    const responseText = response.response.text();
    console.log(
      "[Detect-Prefix] Gemini API response text received:",
      responseText,
    );

    console.log(
      "[Detect-Prefix] Attempting to parse Gemini response as JSON...",
    );
    let parsedResult = {};
    try {
      parsedResult = JSON.parse(responseText.trim());
      console.log("[Detect-Prefix] Successfully parsed Gemini JSON response.");
    } catch (parseErr) {
      console.error(
        "[Detect-Prefix] JSON Parsing Error on Gemini response:",
        parseErr,
      );
      return res.status(500).json({
        error:
          "Gemini did not return structured coordinates JSON. Please try again.",
      });
    }

    console.log("[Detect-Prefix] Prefix detection results details:");
    console.log(`  - Original: "${parsedResult.originalText}"`);
    console.log(`  - Cleaned:  "${parsedResult.cleanedText}"`);
    console.log(`  - Prefix:   "${parsedResult.prefixText}"`);
    console.log(`  - Box:      `, parsedResult.boundingBox);

    res.json({
      message: "Detection completed.",
      result: {
        originalText: parsedResult.originalText || "",
        cleanedText: parsedResult.cleanedText || "",
        prefixText: parsedResult.prefixText || null,
        boundingBox: parsedResult.boundingBox || null,
      },
    });
  } catch (err) {
    console.error("[Detect-Prefix] Fatal error during prefix detection:", err);
    res.status(500).json({ error: "Server error during prefix detection" });
  }
};

// Helper function to wrap text into multiple lines
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

// 3. Remove text from selected area in PDF stream and write the new text center-aligned
export const applyWhiteout = async (req, res) => {
  const { editId, pageNumber, box, viewport, cleanedText } = req.body;

  console.log(`[Apply-Whiteout] Replacement request received:`);
  console.log(`  - editId: ${editId}`);
  console.log(`  - pageNumber: ${pageNumber}`);
  console.log(`  - cleanedText: "${cleanedText}"`);
  console.log(`  - box:`, box);
  console.log(`  - viewport:`, viewport);

  if (!editId) {
    console.error("[Apply-Whiteout] Error: Missing editId.");
    return res.status(400).json({ error: "editId is required" });
  }
  if (!pageNumber || isNaN(Number(pageNumber)) || Number(pageNumber) <= 0) {
    console.error("[Apply-Whiteout] Error: Invalid pageNumber.");
    return res.status(400).json({ error: "Valid pageNumber is required" });
  }
  if (
    !box ||
    typeof box.x !== "number" ||
    typeof box.y !== "number" ||
    typeof box.width !== "number" ||
    typeof box.height !== "number"
  ) {
    console.error("[Apply-Whiteout] Error: Invalid box coordinates.");
    return res.status(400).json({
      error: "Valid box coordinates {x, y, width, height} are required",
    });
  }
  if (
    !viewport ||
    typeof viewport.width !== "number" ||
    typeof viewport.height !== "number"
  ) {
    console.error("[Apply-Whiteout] Error: Invalid viewport dimensions.");
    return res.status(400).json({
      error: "Valid viewport dimensions {width, height} are required",
    });
  }
  if (!cleanedText) {
    console.error("[Apply-Whiteout] Error: Missing cleanedText.");
    return res
      .status(400)
      .json({ error: "Cleaned text is required to replace the question" });
  }

  try {
    const filePath = path.join(userEditsDir, editId);
    console.log(`[Apply-Whiteout] Checking file access at: ${filePath}`);

    // Verify file exists
    try {
      await fs.access(filePath);
      console.log(`[Apply-Whiteout] File access verified.`);
    } catch {
      console.error(`[Apply-Whiteout] Error: File not found at: ${filePath}`);
      return res
        .status(404)
        .json({ error: "Edited PDF file not found on server." });
    }

    console.log(`[Apply-Whiteout] Loading PDF bytes from disk...`);
    const pdfBytes = await fs.readFile(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    console.log(
      `[Apply-Whiteout] PDF successfully loaded. Page count: ${pages.length}`,
    );

    if (pageNumber > pages.length) {
      console.error(
        `[Apply-Whiteout] Error: Requested page ${pageNumber} exceeds total pages ${pages.length}`,
      );
      return res.status(400).json({
        error: `Page number ${pageNumber} exceeds PDF page count (${pages.length})`,
      });
    }

    const page = pages[pageNumber - 1];
    const { width: pdfWidth, height: pdfHeight } = page.getSize();
    console.log(
      `[Apply-Whiteout] Selected Page dimensions: ${pdfWidth.toFixed(2)}x${pdfHeight.toFixed(2)}`,
    );

    // Map viewport coordinates to PDF document coordinates
    console.log(
      `[Apply-Whiteout] Transforming box coordinates from viewport scale (${viewport.width}x${viewport.height}) to PDF scale...`,
    );
    const scaleX = pdfWidth / viewport.width;
    const scaleY = pdfHeight / viewport.height;

    const rectWidth = box.width * scaleX;
    const rectX = box.x * scaleX;
    const rectHeight = box.height * scaleY;
    const rectY = pdfHeight - (box.y + box.height) * scaleY;
    console.log(
      `[Apply-Whiteout] Mapped coordinates: x: ${rectX.toFixed(2)}, y: ${rectY.toFixed(2)}, w: ${rectWidth.toFixed(2)}, h: ${rectHeight.toFixed(2)}`,
    );

    // Draw a solid rectangle covering EXACTLY the target selection box area with color #EBEBFF
    console.log(
      "[Apply-Whiteout] Drawing solid replacement rectangle #EBEBFF...",
    );
    page.drawRectangle({
      x: rectX,
      y: rectY,
      width: rectWidth,
      height: rectHeight,
      color: rgb(235 / 255, 235 / 255, 1.0), // Color #EBEBFF
    });

    // Write new cleaned question text, center-aligned INSIDE the box
    console.log("[Apply-Whiteout] Embedding standard Helvetica font...");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 9; // Reduced by 2 (original was 11)
    const lineHeight = fontSize * 1.35;

    // Max width is 90% of the box width to ensure a tiny padding on left/right
    const maxTextWidth = rectWidth * 0.9;
    console.log(
      `[Apply-Whiteout] Wrapping cleaned text. Max Width: ${maxTextWidth.toFixed(2)}`,
    );
    const lines = wrapText(cleanedText, maxTextWidth, font, fontSize);
    console.log(`[Apply-Whiteout] Wrapped text into ${lines.length} lines:`);
    lines.forEach((l, i) => console.log(`  Line ${i + 1}: "${l}"`));

    // Calculate center coordinates of the box
    const xCenter = rectX + rectWidth / 2;
    const yCenter = rectY + rectHeight / 2;
    const totalTextHeight = lines.length * lineHeight;
    const startY = yCenter + totalTextHeight / 2 - fontSize;
    console.log(
      `[Apply-Whiteout] Text alignment layout: xCenter: ${xCenter.toFixed(2)}, yCenter: ${yCenter.toFixed(2)}, startY: ${startY.toFixed(2)}`,
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineW = font.widthOfTextAtSize(line, fontSize);
      const lineX = xCenter - lineW / 2; // Center horizontally within the box
      const lineY = startY - i * lineHeight;
      console.log(
        `[Apply-Whiteout] Drawing line ${i + 1} at x: ${lineX.toFixed(2)}, y: ${lineY.toFixed(2)}`,
      );

      page.drawText(line, {
        x: lineX,
        y: lineY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }

    // Save modified PDF file back
    console.log(
      `[Apply-Whiteout] Saving PDF bytes back to disk at: ${filePath}`,
    );
    const modifiedPdfBytes = await pdfDoc.save();
    await fs.writeFile(filePath, modifiedPdfBytes);
    console.log(`[Apply-Whiteout] PDF successfully modified and saved.`);

    res.json({
      message: "Question prefix successfully removed and replaced!",
      url: `/uploads/user_edits/${editId}?t=${Date.now()}`, // Add timestamp to break frontend browser cache
    });
  } catch (err) {
    console.error("[Apply-Whiteout] Fatal error replacing text in PDF:", err);
    res
      .status(500)
      .json({ error: "Server error replacing question text in PDF" });
  }
};

// 4. Download Cleaned PDF
export const downloadPDF = async (req, res) => {
  const { editId } = req.params;

  console.log(`[Download] Download request received for editId: ${editId}`);

  if (!editId) {
    console.error("[Download] Error: Missing editId parameter.");
    return res.status(400).json({ error: "editId parameter is required" });
  }

  try {
    const filePath = path.join(userEditsDir, editId);
    console.log(`[Download] Resolving file path: ${filePath}`);

    // Verify file existence
    try {
      await fs.access(filePath);
      console.log(`[Download] Confirmed file exists on disk.`);
    } catch {
      console.error(`[Download] Error: File not found at ${filePath}`);
      return res.status(404).json({ error: "Cleaned PDF file not found." });
    }

    // Extract the original filename from the edit filename
    const parts = editId.split("-");
    let displayName = "cleaned_document.pdf";
    if (parts.length >= 3) {
      displayName = parts.slice(2).join("-");
    }
    console.log(
      `[Download] Serving file download. Display name: ${displayName}`,
    );

    res.download(filePath, displayName);
  } catch (err) {
    console.error("[Download] Fatal error during PDF download:", err);
    res.status(500).json({ error: "Server error downloading modified PDF" });
  }
};

// 5. Auto-Clean Entire PDF in Chunks of Pages
export const autoCleanPDF = async (req, res) => {
  const {
    editId,
    startPage: startPageParam,
    maxPages: maxPagesParam,
  } = req.body;

  if (!editId) {
    console.log("[Auto-Clean] Error: Missing editId in request body.");
    return res.status(400).json({ error: "editId is required" });
  }

  // Parse startPage (1-based index) and maxPages
  const startPageIdx = startPageParam
    ? Math.max(1, parseInt(startPageParam, 10))
    : 1;
  const maxPagesToProcess = maxPagesParam
    ? Math.max(1, parseInt(maxPagesParam, 10))
    : null;

  try {
    const filePath = path.join(userEditsDir, editId);
    console.log(`[Auto-Clean] Initializing auto-clean for file: ${filePath}`);

    // Verify file exists
    try {
      await fs.access(filePath);
      console.log(`[Auto-Clean] Verified file access for: ${filePath}`);
    } catch (accessErr) {
      console.error(
        `[Auto-Clean] Error: File not found at ${filePath}`,
        accessErr,
      );
      return res
        .status(404)
        .json({ error: "Edited PDF file not found on server." });
    }

    // Load PDF using pdf-lib
    console.log(`[Auto-Clean] Loading PDF file into memory...`);
    const pdfBytes = await fs.readFile(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();
    console.log(
      `[Auto-Clean] PDF loaded successfully. Total pages: ${totalPages}`,
    );

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      console.error(
        "[Auto-Clean] Error: Gemini API key is missing or default.",
      );
      return res
        .status(550)
        .json({ error: "Gemini API key is not configured in backend .env" });
    }

    console.log("[Auto-Clean] Setting up Gemini connection...");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    console.log("[Auto-Clean] Embedding Standard Helvetica font...");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 9;
    const lineHeight = fontSize * 1.35;

    // Process in chunks of 50 pages
    const chunkSize = 50;

    // Determine the end limit of pages to clean in this request
    const limitPages = maxPagesToProcess
      ? Math.min(totalPages, startPageIdx + maxPagesToProcess - 1)
      : totalPages;
    console.log(
      `[Auto-Clean] Starting chunk-based processing loop. startPage: ${startPageIdx}, limitPages: ${limitPages}, totalPages: ${totalPages}, chunk size: ${chunkSize} pages.`,
    );

    for (
      let startPage = startPageIdx;
      startPage <= limitPages;
      startPage += chunkSize
    ) {
      const endPage = Math.min(startPage + chunkSize - 1, limitPages);
      console.log(
        `\n--- [Auto-Clean] Processing Chunk: Pages ${startPage} to ${endPage} of ${totalPages} ---`,
      );

      // Create a temporary document containing only the chunk pages
      console.log(
        `[Auto-Clean] Slicing pages ${startPage}-${endPage} into temporary document...`,
      );
      const chunkDoc = await PDFDocument.create();
      const pageIndices = [];
      for (let p = startPage; p <= endPage; p++) {
        pageIndices.push(p - 1);
      }

      const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((p) => chunkDoc.addPage(p));
      const chunkBytes = await chunkDoc.save();
      console.log(
        `[Auto-Clean] Temporary chunk PDF created. Size: ${chunkBytes.length} bytes.`,
      );

      // Convert chunk to base64 PDF
      const pdfBase64 = Buffer.from(chunkBytes).toString("base64");
      const pdfPart = {
        inlineData: {
          data: pdfBase64,
          mimeType: "application/pdf",
        },
      };

      const prompt = `
You are an expert exam question OCR and cleaning engine. We are providing a chunk of PDF pages from a scanned exam answer booklet.
For each page in this chunk:
1. Detect if there is a printed typed question at the top of the page. Note: The question will only be written at the top in the form of computer text (printed/typed text), NOT handwritten text, and NOT text in a colored strip below the topper's details strip.
2. If there is, identify the exact numbering prefix (like "q5).", "Q5", "5.") at the start of the question text.
3. Clean the question text by removing this prefix (e.g. "q5). Explain X" -> "Explain X").
4. Identify the exact bounding box coordinates of the printed computer text question block on that page.
   Return the bounding box in normalized coordinates (ymin, xmin, ymax, xmax) from 0 to 1000 where (0,0) is top-left and (1000,1000) is bottom-right.

Return your response strictly as a JSON array of objects for each page that contains a question (if a page has no question, do not include it):
[
  {
    "pageNumber": integer (1-based index relative to the pages in this chunk, i.e., 1 to ${copiedPages.length}),
    "originalText": "The full text of the question including the prefix",
    "cleanedText": "The text of the question with the prefix removed",
    "prefixText": "The exact prefix text found (e.g., 'q5).') or null if none",
    "boundingBox": {
      "ymin": integer (0 to 1000, distance from top edge),
      "xmin": integer (0 to 1000, distance from left edge),
      "ymax": integer (0 to 1000, distance from top edge),
      "xmax": integer (0 to 1000, distance from left edge)
    }
  }
]
`;

      let responseText = "";
      let retries = 5;
      let delayMs = 3000;
      let geminiSuccess = false;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(
            `[Auto-Clean] Calling Gemini API (Attempt ${attempt}/${retries})...`,
          );
          const response = await model.generateContent([prompt, pdfPart]);
          responseText = response.response.text();
          geminiSuccess = true;
          console.log(`[Auto-Clean] Gemini response received successfully.`);
          break;
        } catch (err) {
          console.error(
            `[Auto-Clean] Attempt ${attempt} failed:`,
            err.message || err,
          );
          if (attempt === retries) {
            console.error(
              `[Auto-Clean] Error: All ${retries} attempts failed calling Gemini API.`,
            );
            throw err;
          }
          console.log(
            `[Auto-Clean] Waiting ${delayMs}ms before retrying due to API error...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2; // Exponential backoff
        }
      }

      console.log(`[Auto-Clean] Raw Gemini response text:`, responseText);

      let chunkResults = [];
      try {
        chunkResults = JSON.parse(responseText.trim());
        console.log(
          `[Auto-Clean] Successfully parsed response JSON. Found ${chunkResults.length} pages to clean.`,
        );
      } catch (parseErr) {
        console.error(
          `[Auto-Clean] JSON parsing failed for chunk starting at page ${startPage}. Skipping chunk.`,
          parseErr,
        );
        continue;
      }

      if (!Array.isArray(chunkResults)) {
        console.error(
          `[Auto-Clean] Error: Gemini response is not an array. Skipping chunk.`,
        );
        continue;
      }

      let cleanedInChunk = 0;

      // Apply replacements on the main document
      for (const item of chunkResults) {
        const relPageNum = item.pageNumber;
        if (!relPageNum || relPageNum < 1 || relPageNum > pageIndices.length) {
          console.warn(
            `[Auto-Clean] Warning: Invalid relative page number ${relPageNum} returned. Skipping page.`,
          );
          continue;
        }

        const absPageNum = startPage + relPageNum - 1;
        const cleanedText = item.cleanedText;
        const box = item.boundingBox;

        if (
          !cleanedText ||
          !box ||
          typeof box.ymin !== "number" ||
          typeof box.xmin !== "number" ||
          typeof box.ymax !== "number" ||
          typeof box.xmax !== "number"
        ) {
          console.warn(
            `[Auto-Clean] Warning: Incomplete data returned for page ${absPageNum}. Skipping.`,
          );
          continue;
        }

        console.log(`[Auto-Clean] Cleaning page ${absPageNum}:`);
        console.log(
          `  - Original Text: "${item.originalText?.slice(0, 100)}..."`,
        );
        console.log(`  - Cleaned Text:  "${cleanedText.slice(0, 100)}..."`);
        console.log(`  - Prefix:        "${item.prefixText}"`);
        console.log(
          `  - Bounding Box:  ymin: ${box.ymin}, xmin: ${box.xmin}, ymax: ${box.ymax}, xmax: ${box.xmax}`,
        );

        const page = pages[absPageNum - 1];
        const { width: pdfWidth, height: pdfHeight } = page.getSize();

        // Convert normalized coordinates (0-1000) to PDF coordinates
        const rectWidth = ((box.xmax - box.xmin) / 1000) * pdfWidth;
        const rectX = (box.xmin / 1000) * pdfWidth;
        const rectHeight = ((box.ymax - box.ymin) / 1000) * pdfHeight;
        const rectY = pdfHeight - (box.ymax / 1000) * pdfHeight;

        console.log(
          `  - Drawing mask rectangle: x: ${rectX.toFixed(2)}, y: ${rectY.toFixed(2)}, w: ${rectWidth.toFixed(2)}, h: ${rectHeight.toFixed(2)}`,
        );

        // Draw solid #EBEBFF rectangle
        page.drawRectangle({
          x: rectX,
          y: rectY,
          width: rectWidth,
          height: rectHeight,
          color: rgb(235 / 255, 235 / 255, 1.0),
        });

        // Wrap and draw text center-aligned
        const maxTextWidth = rectWidth * 0.9;
        const lines = wrapText(cleanedText, maxTextWidth, font, fontSize);
        console.log(`  - Wrapped text into ${lines.length} lines:`);
        lines.forEach((l, idx) => console.log(`      Line ${idx + 1}: "${l}"`));

        const xCenter = rectX + rectWidth / 2;
        const yCenter = rectY + rectHeight / 2;
        const totalTextHeight = lines.length * lineHeight;
        const startY = yCenter + totalTextHeight / 2 - fontSize;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineW = font.widthOfTextAtSize(line, fontSize);
          const lineX = xCenter - lineW / 2;

          page.drawText(line, {
            x: lineX,
            y: startY - i * lineHeight,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
          });
        }
        cleanedInChunk++;
        console.log(`  - Page ${absPageNum} successfully modified.`);
      }

      // Save document after each successfully processed chunk to preserve progress
      if (cleanedInChunk > 0) {
        console.log(
          `[Auto-Clean] Saving intermediate progress back to disk...`,
        );
        const modifiedPdfBytes = await pdfDoc.save();
        await fs.writeFile(filePath, modifiedPdfBytes);
        console.log(
          `[Auto-Clean] Progress saved for chunk ending at page ${endPage}.`,
        );
      } else {
        console.log(
          `[Auto-Clean] No modifications made in this chunk. Skipping intermediate save.`,
        );
      }

      // Introduce a delay between chunks to avoid hitting API rate limits
      const waitTimeMs = 2500;
      console.log(
        `[Auto-Clean] Waiting ${waitTimeMs}ms before starting next chunk...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
    }

    console.log(`[Auto-Clean] Auto-cleaning complete for file: ${filePath}!`);
    res.json({
      message: "PDF automatically cleaned and questions replaced successfully!",
      url: `/uploads/user_edits/${editId}?t=${Date.now()}`,
    });
  } catch (err) {
    console.error(
      "[Auto-Clean] Fatal error during automated PDF cleaning:",
      err,
    );
    res.status(500).json({
      error:
        "Server error during automated PDF cleaning: " + (err.message || err),
    });
  }
};

// 6. Clean Specific Pages in Chunks of 10 Pages
export const cleanPagesPDF = async (req, res) => {
  const { editId, pages: pagesArray } = req.body;

  console.log(
    `[Clean-Pages] Selective cleaning request received. editId: ${editId}, pages count: ${pagesArray?.length}`,
  );

  if (!editId) {
    console.error("[Clean-Pages] Error: Missing editId.");
    return res.status(400).json({ error: "editId is required" });
  }

  if (!Array.isArray(pagesArray) || pagesArray.length === 0) {
    console.error("[Clean-Pages] Error: Invalid pages list.");
    return res.status(400).json({ error: "Valid pages array is required" });
  }

  try {
    const filePath = path.join(userEditsDir, editId);
    console.log(`[Clean-Pages] Checking file access at: ${filePath}`);

    // Verify file exists
    try {
      await fs.access(filePath);
      console.log(`[Clean-Pages] File access verified.`);
    } catch {
      console.error(`[Clean-Pages] Error: File not found at: ${filePath}`);
      return res
        .status(404)
        .json({ error: "Edited PDF file not found on server." });
    }

    console.log(`[Clean-Pages] Loading PDF bytes from disk...`);
    const pdfBytes = await fs.readFile(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();
    console.log(
      `[Clean-Pages] PDF successfully loaded. Page count: ${totalPages}`,
    );

    // Filter and validate page numbers (1-based index)
    const validPages = pagesArray
      .map((p) => parseInt(p, 10))
      .filter((p) => !isNaN(p) && p >= 1 && p <= totalPages);

    if (validPages.length === 0) {
      console.error(
        "[Clean-Pages] Error: No valid page numbers provided within PDF range.",
      );
      return res.status(400).json({
        error: `No valid page numbers provided within PDF range (1-${totalPages}).`,
      });
    }

    // Sort valid pages in ascending order
    validPages.sort((a, b) => a - b);
    console.log(`[Clean-Pages] Valid sorted pages to clean:`, validPages);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      console.error(
        "[Clean-Pages] Error: Gemini API key is missing or default.",
      );
      return res
        .status(550)
        .json({ error: "Gemini API key is not configured in backend .env" });
    }

    console.log("[Clean-Pages] Setting up Gemini connection...");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    console.log("[Clean-Pages] Embedding Standard Helvetica font...");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 9;
    const lineHeight = fontSize * 1.35;

    // Process in chunks of 10 pages as requested by user
    const chunkSize = 10;
    let totalCleanedCount = 0;

    for (let i = 0; i < validPages.length; i += chunkSize) {
      const chunkPages = validPages.slice(i, i + chunkSize);
      console.log(
        `\n--- [Clean-Pages] Processing Chunk: Pages ${chunkPages.join(", ")} ---`,
      );

      // Create a temporary document containing only the chunk pages
      console.log(
        `[Clean-Pages] Slicing pages [${chunkPages.join(", ")}] into temporary document...`,
      );
      const chunkDoc = await PDFDocument.create();
      const pageIndices = chunkPages.map((p) => p - 1);

      const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((p) => chunkDoc.addPage(p));
      const chunkBytes = await chunkDoc.save();
      console.log(
        `[Clean-Pages] Temporary chunk PDF created. Size: ${chunkBytes.length} bytes.`,
      );

      // Convert chunk to base64 PDF
      const pdfBase64 = Buffer.from(chunkBytes).toString("base64");
      const pdfPart = {
        inlineData: {
          data: pdfBase64,
          mimeType: "application/pdf",
        },
      };

      const prompt = `
You are an expert exam question OCR and cleaning engine. We are providing a chunk of PDF pages from a scanned exam answer booklet.
For each page in this chunk:
1. Detect if there is a printed typed question at the top of the page. Note: The question will only be written at the top in the form of computer text (printed/typed text), NOT handwritten text, and NOT text in a colored strip below the topper's details strip.
2. If there is, identify the exact numbering prefix (like "q5).", "Q5", "5.") at the start of the question text.
3. Clean the question text by removing this prefix (e.g. "q5). Explain X" -> "Explain X").
4. Identify the exact bounding box coordinates of the printed computer text question block on that page.
   Return the bounding box in normalized coordinates (ymin, xmin, ymax, xmax) from 0 to 1000 where (0,0) is top-left and (1000,1000) is bottom-right.

Return your response strictly as a JSON array of objects for each page that contains a question (if a page has no question, do not include it):
[
  {
    "pageNumber": integer (1-based index relative to the pages in this chunk, i.e., 1 to ${copiedPages.length}),
    "originalText": "The full text of the question including the prefix",
    "cleanedText": "The text of the question with the prefix removed",
    "prefixText": "The exact prefix text found (e.g., 'q5).') or null if none",
    "boundingBox": {
      "ymin": integer (0 to 1000, distance from top edge),
      "xmin": integer (0 to 1000, distance from left edge),
      "ymax": integer (0 to 1000, distance from top edge),
      "xmax": integer (0 to 1000, distance from left edge)
    }
  }
]
`;

      let responseText = "";
      let retries = 5;
      let delayMs = 3000;
      let geminiSuccess = false;

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(
            `[Clean-Pages] Calling Gemini API (Attempt ${attempt}/${retries})...`,
          );
          const response = await model.generateContent([prompt, pdfPart]);
          responseText = response.response.text();
          geminiSuccess = true;
          console.log(`[Clean-Pages] Gemini response received successfully.`);
          break;
        } catch (err) {
          console.error(
            `[Clean-Pages] Attempt ${attempt} failed:`,
            err.message || err,
          );
          if (attempt === retries) {
            console.error(
              `[Clean-Pages] Error: All ${retries} attempts failed calling Gemini API.`,
            );
            throw err;
          }
          console.log(
            `[Clean-Pages] Waiting ${delayMs}ms before retrying due to API error...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2; // Exponential backoff
        }
      }

      console.log(`[Clean-Pages] Raw Gemini response text:`, responseText);

      let chunkResults = [];
      try {
        chunkResults = JSON.parse(responseText.trim());
        console.log(
          `[Clean-Pages] Successfully parsed response JSON. Found ${chunkResults.length} pages to clean.`,
        );
      } catch (parseErr) {
        console.error(
          `[Clean-Pages] JSON parsing failed for chunk. Skipping chunk.`,
          parseErr,
        );
        continue;
      }

      if (!Array.isArray(chunkResults)) {
        console.error(
          `[Clean-Pages] Error: Gemini response is not an array. Skipping chunk.`,
        );
        continue;
      }

      let cleanedInChunk = 0;

      // Apply replacements on the main document
      for (const item of chunkResults) {
        const relPageNum = item.pageNumber;
        if (!relPageNum || relPageNum < 1 || relPageNum > chunkPages.length) {
          console.warn(
            `[Clean-Pages] Warning: Invalid relative page number ${relPageNum} returned. Skipping page.`,
          );
          continue;
        }

        const absPageNum = chunkPages[relPageNum - 1];
        const cleanedText = item.cleanedText;
        const box = item.boundingBox;

        if (
          !cleanedText ||
          !box ||
          typeof box.ymin !== "number" ||
          typeof box.xmin !== "number" ||
          typeof box.ymax !== "number" ||
          typeof box.xmax !== "number"
        ) {
          console.warn(
            `[Clean-Pages] Warning: Incomplete data returned for page ${absPageNum}. Skipping.`,
          );
          continue;
        }

        console.log(`[Clean-Pages] Cleaning page ${absPageNum}:`);
        console.log(
          `  - Original Text: "${item.originalText?.slice(0, 100)}..."`,
        );
        console.log(`  - Cleaned Text:  "${cleanedText.slice(0, 100)}..."`);
        console.log(`  - Prefix:        "${item.prefixText}"`);
        console.log(
          `  - Bounding Box:  ymin: ${box.ymin}, xmin: ${box.xmin}, ymax: ${box.ymax}, xmax: ${box.xmax}`,
        );

        const page = pages[absPageNum - 1];
        const { width: pdfWidth, height: pdfHeight } = page.getSize();

        // Convert normalized coordinates (0-1000) to PDF coordinates
        const rectWidth = ((box.xmax - box.xmin) / 1000) * pdfWidth;
        const rectX = (box.xmin / 1000) * pdfWidth;
        const rectHeight = ((box.ymax - box.ymin) / 1000) * pdfHeight;
        const rectY = pdfHeight - (box.ymax / 1000) * pdfHeight;

        console.log(
          `  - Drawing mask rectangle: x: ${rectX.toFixed(2)}, y: ${rectY.toFixed(2)}, w: ${rectWidth.toFixed(2)}, h: ${rectHeight.toFixed(2)}`,
        );

        // Draw solid #EBEBFF rectangle
        page.drawRectangle({
          x: rectX,
          y: rectY,
          width: rectWidth,
          height: rectHeight,
          color: rgb(235 / 255, 235 / 255, 1.0),
        });

        // Wrap and draw text center-aligned
        const maxTextWidth = rectWidth * 0.9;
        const lines = wrapText(cleanedText, maxTextWidth, font, fontSize);
        console.log(`  - Wrapped text into ${lines.length} lines:`);
        lines.forEach((l, idx) => console.log(`      Line ${idx + 1}: "${l}"`));

        const xCenter = rectX + rectWidth / 2;
        const yCenter = rectY + rectHeight / 2;
        const totalTextHeight = lines.length * lineHeight;
        const startY = yCenter + totalTextHeight / 2 - fontSize;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineW = font.widthOfTextAtSize(line, fontSize);
          const lineX = xCenter - lineW / 2;

          page.drawText(line, {
            x: lineX,
            y: startY - i * lineHeight,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
          });
        }
        cleanedInChunk++;
        totalCleanedCount++;
        console.log(`  - Page ${absPageNum} successfully modified.`);
      }

      // Save document after each successfully processed chunk to preserve progress
      if (cleanedInChunk > 0) {
        console.log(
          `[Clean-Pages] Saving intermediate progress back to disk...`,
        );
        const modifiedPdfBytes = await pdfDoc.save();
        await fs.writeFile(filePath, modifiedPdfBytes);
        console.log(`[Clean-Pages] Progress saved for chunk.`);
      } else {
        console.log(
          `[Clean-Pages] No modifications made in this chunk. Skipping intermediate save.`,
        );
      }

      // Introduce a delay between chunks to avoid hitting API rate limits
      if (i + chunkSize < validPages.length) {
        const waitTimeMs = 2500;
        console.log(
          `[Clean-Pages] Waiting ${waitTimeMs}ms before starting next chunk...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
      }
    }

    console.log(
      `[Clean-Pages] Specific page cleaning complete for file: ${filePath}! Total cleaned: ${totalCleanedCount}`,
    );
    res.json({
      message: `PDF successfully cleaned for selected pages! Cleaned ${totalCleanedCount} page(s).`,
      url: `/uploads/user_edits/${editId}?t=${Date.now()}`,
    });
  } catch (err) {
    console.error("[Clean-Pages] Fatal error during PDF cleaning:", err);
    res.status(500).json({
      error: "Server error during PDF cleaning: " + (err.message || err),
    });
  }
};
