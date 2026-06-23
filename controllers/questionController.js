import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");
import { GoogleGenerativeAI } from "@google/generative-ai";
import Question from "../models/Question.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Controller to upload PDF question paper, extract text, call Gemini, tag, and save questions
export const uploadQuestionPaper = async (req, res) => {
  const { subject, year } = req.body;
  const file = req.file;

  console.log("\n======================================================");
  console.log("Step 1: Received question paper upload request.");
  console.log("Parameters - Subject:", subject, "| Year:", year);
  console.log(
    "File Info - Name:",
    file?.originalname,
    "| Size:",
    file?.size,
    "bytes",
  );
  console.log("======================================================\n");

  if (!subject) {
    console.error("Validation Error: Subject is required");
    return res.status(400).json({ error: "Subject is required" });
  }
  if (!year) {
    console.error("Validation Error: Year is required");
    return res.status(400).json({ error: "Year is required" });
  }
  if (!file) {
    console.error("Validation Error: File is required");
    return res
      .status(400)
      .json({ error: "Question paper PDF file is required" });
  }

  try {
    // 2. Extract text from the PDF file (detect if scanned or digital)
    console.log("Step 2: Starting PDF text extraction using PDFParse...");
    let pdfText = "";
    let isScannedOrEmpty = false;

    try {
      const parser = new PDFParse({ data: file.buffer });
      const pdfData = await parser.getText();
      pdfText = pdfData.text;
      console.log("Step 3: PDF text extraction complete.");
      console.log("Extracted text character length:", pdfText?.length || 0);
      console.log(
        "Extracted text preview:\n",
        pdfText ? pdfText.slice(0, 300) + "..." : "EMPTY",
      );
    } catch (parseErr) {
      console.error(
        "PDFParse error (falling back to multimodal PDF scan):",
        parseErr,
      );
    }

    if (!pdfText || pdfText.trim().length < 200) {
      console.log(
        "PDF text is extremely short or empty. Treating as a SCANNED/IMAGE-based PDF.",
      );
      isScannedOrEmpty = true;
    } else {
      console.log(
        "PDF text extracted successfully. Treating as a DIGITAL PDF.",
      );
    }

    // 3. Load syllabus hierarchy details for matching
    console.log("Step 4: Reading syllabus_hierarchy.json...");
    const syllabusPath = path.join(__dirname, "../syllabus_hierarchy.json");
    const syllabusContent = await fs.readFile(syllabusPath, "utf8");
    const fullSyllabus = JSON.parse(syllabusContent);

    // Find the correct subject syllabus outline
    let subjectSyllabus = null;
    let subjectDisplayName = subject;

    if (fullSyllabus.gsModules && fullSyllabus.gsModules[subject]) {
      subjectSyllabus = fullSyllabus.gsModules[subject];
      subjectDisplayName = subject.replace("-", " ");
    } else if (
      fullSyllabus.optionalSubjects &&
      fullSyllabus.optionalSubjects[subject]
    ) {
      subjectSyllabus = fullSyllabus.optionalSubjects[subject];
      subjectDisplayName = `Optional subject: ${subject.replace("OptionalSubject", "")}`;
    }

    console.log(
      "Step 5: Matching subject syllabus outline. Display Name:",
      subjectDisplayName,
    );
    if (!subjectSyllabus) {
      console.error("Syllabus Error: Syllabus outline not found for", subject);
      return res
        .status(400)
        .json({ error: `Syllabus not found for subject: ${subject}` });
    }

    // Simplify the outline for prompt token efficiency
    const syllabusOutline = subjectSyllabus.map((sec) => ({
      section: sec.section,
      topics: sec.topics.map((t) => t.title),
    }));
    console.log(
      "Simplified syllabus outline sections loaded:",
      syllabusOutline.length,
    );

    // 4. Setup Gemini Client & Prompt
    console.log("Step 6: Configuring Gemini API client...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your_gemini_api_key_here") {
      console.error("Configuration Error: Gemini API key is missing");
      return res.status(550).json({
        error: "Gemini API key is not configured in backend .env file.",
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    const prompt = `
You are an expert syllabus tagger. Extract all academic exam questions from the past question paper for the subject "${subjectDisplayName}" from the year ${year}.
For each question you extract, match it to the most relevant "section" and topic "title" from the syllabus hierarchy provided below.

Syllabus Hierarchy for "${subjectDisplayName}":
${JSON.stringify(syllabusOutline, null, 2)}

Instructions:
1. Extract the full text of the question. Note that the question paper may contain text written in multiple languages (e.g. Hindi as well as English, or another language). Always extract only the version written in English. Do not include or translate the Hindi/other language versions.
2. For each question, find the single most relevant "section" name and corresponding topic "title" from the provided hierarchy. If no section or title matches well, use the closest logical match or "General".
3. Return the result strictly as a JSON array of objects with this format:
[
  {
    "text": "The full text of the question (in English)",
    "section": "The matching section name from the syllabus",
    "title": "The matching topic title from the syllabus"
  }
]

Do not include any Markdown wrapper like \`\`\`json, just return the raw JSON text.
`;

    let promptParts = [];
    if (isScannedOrEmpty) {
      console.log(
        "Step 7: Preparing raw PDF binary for Gemini multimodal OCR...",
      );
      const pdfPart = {
        inlineData: {
          data: file.buffer.toString("base64"),
          mimeType: "application/pdf",
        },
      };
      promptParts = [prompt, pdfPart];
    } else {
      console.log("Step 7: Preparing extracted text for Gemini...");
      promptParts = [`${prompt}\n\nQuestion Paper Text:\n${pdfText}`];
    }

    console.log("Step 8: Sending request to Gemini API (gemini-3.5-flash)...");
    const response = await model.generateContent(promptParts);
    const responseText = response.response.text();
    console.log("Step 9: Gemini API request complete.");
    console.log("Gemini Raw Response Text:\n", responseText);

    // Parse JSON response
    console.log("Step 9: Parsing Gemini JSON response...");
    let extractedQuestions = [];
    try {
      extractedQuestions = JSON.parse(responseText);
      console.log(
        "Parsed JSON successfully. Extracted question array count:",
        extractedQuestions.length,
      );
    } catch (parseErr) {
      console.error("Error parsing Gemini JSON response:", parseErr);
      return res.status(500).json({
        error: "Failed to parse structured JSON from Gemini. Please try again.",
      });
    }

    if (!Array.isArray(extractedQuestions)) {
      console.error("Format Error: Response is not a JSON array");
      return res
        .status(500)
        .json({ error: "Gemini did not return a valid list of questions." });
    }

    // 5. Save questions to Mongoose database
    console.log("Step 10: Saving extracted questions to MongoDB...");
    const savedQuestions = [];
    for (let i = 0; i < extractedQuestions.length; i++) {
      const q = extractedQuestions[i];
      if (!q.text || q.text.trim().length === 0) {
        console.log(`Skipping index ${i}: Question text is empty`);
        continue;
      }

      console.log(
        `Saving question ${i + 1}/${extractedQuestions.length}: "${q.text.slice(0, 60)}..."`,
      );
      console.log(`Tags - Section: "${q.section}" | Topic: "${q.title}"`);

      const questionObj = await Question.create({
        text: q.text,
        subject: subject,
        year: Number(year),
        tags: {
          subject: subject,
          section: q.section || "General",
          title: q.title || "General",
        },
      });
      savedQuestions.push(questionObj);
    }

    console.log(
      "Step 11: All database writes complete. Total questions saved:",
      savedQuestions.length,
    );
    console.log("======================================================\n");

    res.json({
      message: `Successfully extracted and saved ${savedQuestions.length} questions.`,
      questions: savedQuestions,
    });
  } catch (err) {
    console.error("Error processing question paper upload:", err);
    res
      .status(500)
      .json({ error: err.message || "Server error processing file" });
  }
};

// Retrieve all parsed questions globally
export const getAllQuestions = async (req, res) => {
  try {
    const questions = await Question.find({}).sort({ createdAt: -1 });
    res.json({ questions });
  } catch (err) {
    console.error("Error retrieving all questions:", err);
    res.status(500).json({ error: "Server error retrieving questions list" });
  }
};
