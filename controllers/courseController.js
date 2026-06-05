import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PDFDocument, rgb } from 'pdf-lib';
import bwipjs from 'bwip-js';
import { encryptPDF } from '@pdfsmaller/pdf-encrypt-lite';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global cache to track real-time download progress steps
export const downloadProgressCache = {};

// Upload a new Course PDF
export const uploadCourse = async (req, res) => {
  const { courseId, name, subject, price } = req.body;
  const file = req.file;

  if (!courseId) {
    return res.status(400).json({ error: 'Course ID is required' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Course name is required' });
  }
  if (!subject) {
    return res.status(400).json({ error: 'Subject is required' });
  }
  if (!price) {
    return res.status(400).json({ error: 'Price is required' });
  }
  if (!file) {
    return res.status(400).json({ error: 'Course PDF file is required' });
  }

  try {
    // Check if courseId is unique
    const existing = await Course.findOne({ courseId });
    if (existing) {
      return res.status(400).json({ error: 'Course ID must be unique' });
    }

    console.log(`[R2 Upload] Uploading ${file.filename} to Cloudflare R2...`);
    const fileStream = createReadStream(file.path);
    const uploadParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: file.filename,
      Body: fileStream,
      ContentType: file.mimetype || 'application/pdf',
    };

    await r2Client.send(new PutObjectCommand(uploadParams));
    console.log(`[R2 Upload] File uploaded successfully to R2: ${file.filename}`);

    // Generate file url path with R2 prefix
    const fileUrl = `r2://${file.filename}`;

    const newCourse = await Course.create({
      courseId: courseId.trim(),
      name,
      subject,
      fileName: file.originalname,
      fileUrl,
      price: Number(price)
    });

    res.json({
      message: 'Course PDF uploaded successfully!',
      course: newCourse
    });
  } catch (err) {
    console.error('Error uploading course:', err);
    res.status(500).json({ error: 'Server error uploading course PDF' });
  } finally {
    // Delete temp file from uploads/temp immediately
    if (file && file.path) {
      try {
        await fs.unlink(file.path);
        console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
      } catch (unlinkErr) {
        console.warn(`[Cleanup] Failed to delete temp file ${file.path}:`, unlinkErr.message);
      }
    }
  }
};

// Update an existing course
export const updateCourse = async (req, res) => {
  const { id } = req.params;
  const { courseId, name, subject, price } = req.body;
  const file = req.file;

  try {
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (courseId && courseId.trim() !== course.courseId) {
      const existing = await Course.findOne({ courseId: courseId.trim() });
      if (existing) {
        return res.status(400).json({ error: 'New Course ID is already taken' });
      }
      course.courseId = courseId.trim();
    }

    if (name) course.name = name;
    if (subject) course.subject = subject;
    if (price !== undefined) course.price = Number(price);

    if (file) {
      // 1. Upload new file to R2
      console.log(`[R2 Upload] Uploading replacement file ${file.filename} to R2...`);
      const fileStream = createReadStream(file.path);
      await r2Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: file.filename,
        Body: fileStream,
        ContentType: file.mimetype || 'application/pdf',
      }));
      console.log(`[R2 Upload] Replacement file uploaded to R2: ${file.filename}`);

      // 2. Remove old file (either from R2 or local disk depending on its prefix)
      if (course.fileUrl) {
        if (course.fileUrl.startsWith('r2://')) {
          const oldR2Key = course.fileUrl.replace('r2://', '');
          console.log(`[R2 Cleanup] Deleting old file from R2: ${oldR2Key}`);
          try {
            await r2Client.send(new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: oldR2Key,
            }));
          } catch (deleteErr) {
            console.warn(`[R2 Cleanup] Could not delete old file from R2:`, deleteErr.message);
          }
        } else {
          const oldFilePath = path.join(__dirname, '../', course.fileUrl);
          try {
            await fs.unlink(oldFilePath);
          } catch (unlinkErr) {
            console.warn('Could not delete old local file:', unlinkErr.message);
          }
        }
      }

      course.fileName = file.originalname;
      course.fileUrl = `r2://${file.filename}`;
    }

    await course.save();

    res.json({
      message: 'Course updated successfully!',
      course
    });
  } catch (err) {
    console.error('Error updating course:', err);
    res.status(500).json({ error: 'Server error updating course' });
  } finally {
    if (file && file.path) {
      try {
        await fs.unlink(file.path);
        console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
      } catch (unlinkErr) {
        console.warn(`[Cleanup] Failed to delete temp file ${file.path}:`, unlinkErr.message);
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
      return res.status(404).json({ error: 'Course not found' });
    }

    // Delete the file from the filesystem/R2
    if (course.fileUrl) {
      if (course.fileUrl.startsWith('r2://')) {
        const r2Key = course.fileUrl.replace('r2://', '');
        console.log(`[R2 Cleanup] Deleting file from R2: ${r2Key}`);
        try {
          await r2Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }));
        } catch (deleteErr) {
          console.warn(`[R2 Cleanup] Could not delete file from R2:`, deleteErr.message);
        }
      } else {
        const filePath = path.join(__dirname, '../', course.fileUrl);
        try {
          await fs.unlink(filePath);
        } catch (unlinkErr) {
          console.warn('Could not delete course file from disk:', unlinkErr.message);
        }
      }
    }

    await Course.findByIdAndDelete(id);

    res.json({ message: 'Course removed successfully!' });
  } catch (err) {
    console.error('Error deleting course:', err);
    res.status(500).json({ error: 'Server error deleting course' });
  }
};

// Retrieve all available courses
export const listCourses = async (req, res) => {
  try {
    const courses = await Course.find({}).sort({ createdAt: -1 });
    res.json({ courses });
  } catch (err) {
    console.error('Error listing courses:', err);
    res.status(500).json({ error: 'Server error listing courses' });
  }
};

// Checkout Shopping Cart (Mock Payment)
export const checkoutCart = async (req, res) => {
  const { courseIds } = req.body; // Array of Course IDs

  if (!courseIds || !Array.isArray(courseIds) || courseIds.length === 0) {
    return res.status(400).json({ error: 'Invalid or empty courseIds array provided' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    // Add unique course IDs to user's purchasedCourses list
    const currentPurchases = user.purchasedCourses.map(id => id.toString());
    courseIds.forEach(id => {
      if (!currentPurchases.includes(id)) {
        user.purchasedCourses.push(id);
      }
    });

    await user.save();

    res.json({
      message: 'Checkout successful! Payment Completed.',
      purchasedCoursesCount: user.purchasedCourses.length
    });
  } catch (err) {
    console.error('Error checking out cart:', err);
    res.status(500).json({ error: 'Server error during mock payment checkout' });
  }
};

// Retrieve user's purchased courses
export const getPurchasedCourses = async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate('purchasedCourses');
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    res.json({ purchasedCourses: user.purchasedCourses || [] });
  } catch (err) {
    console.error('Error retrieving purchased courses:', err);
    res.status(500).json({ error: 'Server error fetching purchased courses list' });
  }
};

// Analyze a specific page of a course PDF
export const analyzeCoursePage = async (req, res) => {
  const { courseId, pageNumber } = req.body;

  if (!courseId) {
    return res.status(400).json({ error: 'courseId is required' });
  }
  if (!pageNumber || isNaN(Number(pageNumber)) || Number(pageNumber) <= 0) {
    return res.status(400).json({ error: 'Valid pageNumber is required' });
  }

  try {
    // 1. Verify user profile and purchases
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const hasPurchased = user.purchasedCourses.some(id => id.toString() === courseId);
    if (!hasPurchased) {
      return res.status(403).json({ error: 'Access denied. You have not purchased this course.' });
    }

    // 2. Fetch the course details
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // 3. Load PDF buffer from R2 or local disk
    let fileBuffer;
    if (course.fileUrl.startsWith('r2://')) {
      const r2Key = course.fileUrl.replace('r2://', '');
      console.log(`[R2 Stream] Fetching raw PDF for page analysis from R2 key: ${r2Key}`);
      try {
        const r2Response = await r2Client.send(new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: r2Key,
        }));
        
        const chunks = [];
        for await (const chunk of r2Response.Body) {
          chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
      } catch (r2Err) {
        console.error(`[PDF Security] Error reading PDF from R2 for page analysis:`, r2Err);
        return res.status(500).json({ error: 'Could not retrieve course file from Cloudflare R2' });
      }
    } else {
      const filePath = path.join(__dirname, '../', course.fileUrl);
      try {
        await fs.access(filePath);
        fileBuffer = await fs.readFile(filePath);
      } catch (readErr) {
        console.error(`Error reading PDF file from disk for page analysis:`, readErr);
        return res.status(404).json({ error: 'Course PDF file not found on server disk.' });
      }
    }

    // 4. Read PDF and parse the specific page
    console.log(`Analyzing course page: parsing page ${pageNumber}...`);
    const parser = new PDFParse({ data: fileBuffer });
    
    // Efficiently parse ONLY the target page
    const pdfData = await parser.getText({ partial: [Number(pageNumber)] });
    const pageObj = pdfData.pages.find(p => p.num === Number(pageNumber));
    const pageText = pageObj ? pageObj.text : '';

    if (!pageText || pageText.trim().length === 0) {
      return res.status(400).json({ 
        error: `Could not extract text from page ${pageNumber}. The page might be blank, scanned, or contains only images.` 
      });
    }

    console.log(`Page ${pageNumber} parsed successfully. Character count: ${pageText.length}`);

    // 5. Load the syllabus outline for the course's subject
    const syllabusPath = path.join(__dirname, '../syllabus_hierarchy.json');
    const syllabusContent = await fs.readFile(syllabusPath, 'utf8');
    const fullSyllabus = JSON.parse(syllabusContent);

    let subjectSyllabus = null;
    let subjectDisplayName = course.subject;

    if (fullSyllabus.gsModules && fullSyllabus.gsModules[course.subject]) {
      subjectSyllabus = fullSyllabus.gsModules[course.subject];
      subjectDisplayName = course.subject.replace('-', ' ');
    } else if (fullSyllabus.optionalSubjects && fullSyllabus.optionalSubjects[course.subject]) {
      subjectSyllabus = fullSyllabus.optionalSubjects[course.subject];
      subjectDisplayName = `Optional subject: ${course.subject.replace('OptionalSubject', '')}`;
    }

    if (!subjectSyllabus) {
      return res.status(400).json({ error: `Syllabus outline not configured for subject: ${course.subject}` });
    }

    // Simplify outline for prompt token efficiency
    const syllabusOutline = subjectSyllabus.map(sec => ({
      section: sec.section,
      topics: sec.topics.map(t => t.title)
    }));

    // 6. Call Gemini to tag and summarize the content on the page
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      return res.status(550).json({ error: 'Gemini API key is not configured in backend .env' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
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
      console.error('Error parsing Gemini JSON response:', parseErr);
      return res.status(500).json({ error: 'Gemini did not return structured JSON. Please try again.' });
    }

    res.json({
      message: 'Analysis successful!',
      analysis: {
        questionText: parsedResult.questionText || 'Concept summary unavailable',
        section: parsedResult.section || 'General',
        title: parsedResult.title || 'General'
      }
    });

  } catch (err) {
    console.error('Error analyzing course page:', err);
    res.status(500).json({ error: 'Server error during page analysis' });
  }
};

// Handle secured PDF download with top watermarks and bottom barcode
export const downloadSecuredCoursePdf = async (req, res) => {
  const { courseId } = req.params;
  console.log(`[PDF Security] Starting secure download process for courseId: ${courseId}`);

  // Determine mode (default to server-js if not specified)
  const mode = process.env.DOWNLOAD_MODE || 'server-js';
  console.log(`[PDF Security] Download mode: ${mode}`);

  // Initialize tracking
  downloadProgressCache[`${req.userId}_${courseId}`] = 1;

  let tempInputPath = '';
  let tempStampPath = '';
  let tempWarningPath = '';
  let tempOutputPath = '';
  let creditIncremented = false;

  try {
    // 1. Fetch user to verify active session
    console.log(`[PDF Security] Step 1: Fetching user details for ID: ${req.userId}`);
    const user = await User.findById(req.userId);
    if (!user) {
      console.log(`[PDF Security] Step 1: User not found for ID: ${req.userId}`);
      return res.status(404).json({ error: 'User not found' });
    }
    console.log(`[PDF Security] Step 1: User found (${user.email})`);

    // Step 2 starts
    downloadProgressCache[`${req.userId}_${courseId}`] = 2;

    // 2. Fetch course by custom courseId
    console.log(`[PDF Security] Step 2: Fetching course details for courseId: ${courseId}`);
    const course = await Course.findOne({ courseId });
    if (!course) {
      console.log(`[PDF Security] Step 2: Course not found for courseId: ${courseId}`);
      return res.status(404).json({ error: 'Course not found' });
    }
    console.log(`[PDF Security] Step 2: Course found (${course.name})`);

    // Step 3 starts
    downloadProgressCache[`${req.userId}_${courseId}`] = 3;

    // 3. Verify user has access to this course (check if interestedCourses contains courseId)
    console.log(`[PDF Security] Step 3: Verifying student course permissions`);
    const interestedList = Array.isArray(user.interestedCourses) ? user.interestedCourses : [];
    const hasAccess = interestedList.some(id => id.toLowerCase() === courseId.toLowerCase());

    if (!hasAccess) {
      console.log(`[PDF Security] Step 3: Access denied for user ${user.email} on course ${courseId}`);
      return res.status(403).json({ error: 'Access denied: This course is not in your interested list' });
    }
    console.log(`[PDF Security] Step 3: Access verified`);

    // Step 4 starts
    downloadProgressCache[`${req.userId}_${courseId}`] = 4;

    // 4. Validate user download limits
    console.log(`[PDF Security] Step 4: Validating user download limits`);
    let limitEntry = user.downloadLimits.find(d => d.courseId === courseId);

    if (limitEntry) {
      if (limitEntry.downloadedCount >= limitEntry.allowedCount) {
        console.log(`[PDF Security] Step 4: Download limit reached (used ${limitEntry.downloadedCount} of ${limitEntry.allowedCount})`);
        return res.status(403).json({ error: 'Download limit reached. Please request additional download access from the admin.' });
      }
    }
    console.log(`[PDF Security] Step 4: User download limits verified`);

    // Listen for client connection abort to refund credit
    req.on('close', async () => {
      if (!res.writableFinished && creditIncremented) {
        console.log(`[PDF Security] Request aborted midway by client. Initiating download credit refund for user: ${req.userId}, courseId: ${courseId}`);
        try {
          const refundUser = await User.findById(req.userId);
          if (refundUser) {
            let refundEntry = refundUser.downloadLimits.find(d => d.courseId === courseId);
            if (refundEntry && refundEntry.downloadedCount > 0) {
              refundEntry.downloadedCount -= 1;
              await refundUser.save();
              console.log(`[PDF Security] Credit successfully refunded in database. downloadedCount: ${refundEntry.downloadedCount}`);
            }
          }
        } catch (refundErr) {
          console.error(`[PDF Security] Error refunding download credit on abort:`, refundErr);
        }
      }
    });

    // We increment download credit pre-emptively, similar to original logic
    const limitUser = await User.findById(req.userId);
    if (limitUser) {
      let finalLimitEntry = limitUser.downloadLimits.find(d => d.courseId === courseId);
      if (finalLimitEntry) {
        finalLimitEntry.downloadedCount += 1;
      } else {
        limitUser.downloadLimits.push({
          courseId,
          downloadedCount: 1,
          allowedCount: 1
        });
      }
      await limitUser.save();
      creditIncremented = true;
      console.log(`[PDF Security] Download limit tracked & updated in database (downloadedCount incremented)`);
    }

    // --- MODE 1: CLIENT-SIDE PROCESSING ---
    if (mode === 'client-side') {
      res.setHeader('x-download-mode', 'client-side');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${course.fileName.replace(/\s+/g, '_')}_raw.pdf"`);

      if (course.fileUrl.startsWith('r2://')) {
        const r2Key = course.fileUrl.replace('r2://', '');
        console.log(`[PDF Security] Client-side Mode: Proxy streaming from Cloudflare R2 (key: ${r2Key})`);
        const r2Response = await r2Client.send(new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: r2Key,
        }));
        
        // Pipe the R2 response stream directly to the Express response (low memory)
        r2Response.Body.pipe(res);
      } else {
        console.log(`[PDF Security] Client-side Mode: Streaming from local disk`);
        const filePath = path.join(__dirname, '../', course.fileUrl);
        const fileStream = createReadStream(filePath);
        fileStream.pipe(res);
      }
      return;
    }

    // --- MODE 2: SERVER-SIDE NATIVE (QPDF) PROCESSING ---
    if (mode === 'server-native') {
      downloadProgressCache[`${req.userId}_${courseId}`] = 5;
      
      // Ensure temp directory exists
      const tempDir = path.join(__dirname, '../uploads/temp');
      await fs.mkdir(tempDir, { recursive: true });

      tempInputPath = path.join(tempDir, `input_${req.userId}_${courseId}.pdf`);
      tempStampPath = path.join(tempDir, `stamp_${req.userId}_${courseId}.pdf`);
      tempWarningPath = path.join(tempDir, `warning_${req.userId}_${courseId}.pdf`);
      tempOutputPath = path.join(tempDir, `output_${req.userId}_${courseId}.pdf`);

      // 5. Download source file to disk
      if (course.fileUrl.startsWith('r2://')) {
        const r2Key = course.fileUrl.replace('r2://', '');
        console.log(`[PDF Security] Native Mode: Streaming from Cloudflare R2 to disk (key: ${r2Key})`);
        const r2Response = await r2Client.send(new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: r2Key,
        }));
        await pipeline(r2Response.Body, createWriteStream(tempInputPath));
      } else {
        console.log(`[PDF Security] Native Mode: Copying local file to temp path`);
        const localFilePath = path.join(__dirname, '../', course.fileUrl);
        await fs.copyFile(localFilePath, tempInputPath);
      }
      console.log(`[PDF Security] Native Mode: PDF downloaded to disk`);

      downloadProgressCache[`${req.userId}_${courseId}`] = 6;

      // 6. Generate barcode buffer
      console.log(`[PDF Security] Native Mode: Generating user barcode`);
      let barcodePngBuffer = await new Promise((resolve, reject) => {
        bwipjs.toBuffer({
          bcid: 'code128',
          text: user._id.toString(),
          scale: 2,
          height: 10,
          includetext: true,
          textxalign: 'center',
        }, (err, png) => {
          if (err) reject(err);
          else resolve(png);
        });
      });

      downloadProgressCache[`${req.userId}_${courseId}`] = 7;

      // Get page dimensions and page count using qpdf
      console.log(`[PDF Security] Native Mode: Getting dimensions and page count from qpdf`);
      const { stdout: qpdfInfo } = await execPromise(`qpdf --show-pages "${tempInputPath}"`);
      const pageCount = (qpdfInfo.match(/page \d+:/g) || []).length;
      
      const sizeMatch = qpdfInfo.match(/page 1:[^]*?size: ([\d.]+) x ([\d.]+)/i);
      let width = 595.276; // Default A4
      let height = 841.89;
      if (sizeMatch) {
        width = parseFloat(sizeMatch[1]);
        height = parseFloat(sizeMatch[2]);
      }
      console.log(`[PDF Security] Native Mode: PDF has ${pageCount} pages, size: ${width}x${height}`);

      // Create stamp PDF (1 page with watermark & barcode)
      console.log(`[PDF Security] Native Mode: Creating watermark stamp PDF`);
      const stampDoc = await PDFDocument.create();
      const helveticaFont = await stampDoc.embedFont('Helvetica');
      const helveticaBoldFont = await stampDoc.embedFont('Helvetica-Bold');
      const stampPage = stampDoc.addPage([width, height]);

      const watermarkText = `Name: ${user.fullName || user.name}  |  Email: ${user.email}  |  Mobile: ${user.mobileNumber || 'N/A'}`;
      stampPage.drawText(watermarkText, {
        x: 25,
        y: height - 25,
        size: 9,
        font: helveticaFont,
        color: rgb(0.6, 0.6, 0.6),
      });

      const barcodeImage = await stampDoc.embedPng(barcodePngBuffer);
      const barcodeWidth = 90;
      const barcodeHeight = 20;
      stampPage.drawImage(barcodeImage, {
        x: width - barcodeWidth - 25,
        y: 15,
        width: barcodeWidth,
        height: barcodeHeight,
      });

      const stampBytes = await stampDoc.save();
      await fs.writeFile(tempStampPath, stampBytes);

      // Create warning PDF (1 page)
      console.log(`[PDF Security] Native Mode: Creating warning page PDF`);
      const warningDoc = await PDFDocument.create();
      const warningPage = warningDoc.addPage([width, height]);
      drawSecurityWarningPage(warningPage, user, course, helveticaFont, helveticaBoldFont);
      const warningBytes = await warningDoc.save();
      await fs.writeFile(tempWarningPath, warningBytes);

      // Determine warning page positions
      const numPagesToAdd = Math.max(1, Math.floor(pageCount / 40));
      const insertPositions = [];
      for (let j = 0; j < numPagesToAdd; j++) {
        insertPositions.push(Math.floor(Math.random() * (pageCount + 1)) + 1);
      }
      insertPositions.sort((a, b) => a - b);

      // Construct qpdf pages arguments
      const qpdfPages = [];
      let currentPos = 1;
      for (const pos of insertPositions) {
        if (pos > currentPos) {
          qpdfPages.push(`"${tempInputPath}"`, `${currentPos}-${pos - 1}`);
        }
        qpdfPages.push(`"${tempWarningPath}"`, `1`);
        currentPos = pos;
      }
      if (currentPos <= pageCount) {
        qpdfPages.push(`"${tempInputPath}"`, `${currentPos}-z`);
      }

      downloadProgressCache[`${req.userId}_${courseId}`] = 8;
      
      // 8. Execute qpdf to merge warning pages, overlay watermark, and encrypt
      console.log(`[PDF Security] Native Mode: Running qpdf command to stamp and encrypt`);
      const userPassword = user.email.trim().toLowerCase();
      
      const qpdfCommand = `qpdf --empty --pages ${qpdfPages.join(' ')} -- --overlay "${tempStampPath}" --repeat=1-z --encrypt "${userPassword}" "${userPassword}" 256 -- "${tempOutputPath}"`;
      await execPromise(qpdfCommand);

      downloadProgressCache[`${req.userId}_${courseId}`] = 9;

      // Stream the output file to user
      const outputStats = await fs.stat(tempOutputPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${course.fileName.replace(/\s+/g, '_')}_secured.pdf"`);
      res.setHeader('Content-Length', outputStats.size);
      
      await pipeline(createReadStream(tempOutputPath), res);
      console.log(`[PDF Security] Native Mode: Secured PDF streamed successfully!`);
      return;
    }

    // --- MODE 3: SERVER-SIDE JS (FALLBACK) PROCESSING ---
    if (mode === 'server-js') {
      downloadProgressCache[`${req.userId}_${courseId}`] = 5;

      let pdfBuffer;
      if (course.fileUrl.startsWith('r2://')) {
        const r2Key = course.fileUrl.replace('r2://', '');
        console.log(`[PDF Security] JS Mode: Loading raw PDF file from Cloudflare R2 (key: ${r2Key})`);
        const r2Response = await r2Client.send(new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: r2Key,
        }));
        pdfBuffer = Buffer.from(await r2Response.Body.transformToByteArray());
      } else {
        console.log(`[PDF Security] JS Mode: Loading raw PDF file from local disk`);
        const filePath = path.join(__dirname, '../', course.fileUrl);
        pdfBuffer = await fs.readFile(filePath);
      }

      downloadProgressCache[`${req.userId}_${courseId}`] = 6;

      let barcodePngBuffer = await new Promise((resolve, reject) => {
        bwipjs.toBuffer({
          bcid: 'code128',
          text: user._id.toString(),
          scale: 2,
          height: 10,
          includetext: true,
          textxalign: 'center',
        }, (err, png) => {
          if (err) reject(err);
          else resolve(png);
        });
      });

      downloadProgressCache[`${req.userId}_${courseId}`] = 7;

      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const barcodeImage = await pdfDoc.embedPng(barcodePngBuffer);
      const helveticaFont = await pdfDoc.embedFont('Helvetica');
      const helveticaBoldFont = await pdfDoc.embedFont('Helvetica-Bold');

      pdfDoc.setTitle(course.name || 'Secured Course PDF');
      pdfDoc.setAuthor(user.email);
      pdfDoc.setSubject(course.subject || 'Syllabus Course Content');
      pdfDoc.setProducer('The Dark Horse UPSC');
      pdfDoc.setCreator('The Dark Horse UPSC');
      pdfDoc.setKeywords([user._id.toString(), user.email]);

      const pages = pdfDoc.getPages();
      const watermarkText = `Name: ${user.fullName || user.name}  |  Email: ${user.email}  |  Mobile: ${user.mobileNumber || 'N/A'}`;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
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
      }

      if (pages.length > 0) {
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        const numPagesToAdd = Math.max(1, Math.floor(pages.length / 40));
        const insertIndices = [];
        let currentPagesCount = pages.length;
        for (let j = 0; j < numPagesToAdd; j++) {
          let maxIdx = currentPagesCount;
          let minIdx = currentPagesCount > 1 ? 1 : 0;
          insertIndices.push(Math.floor(Math.random() * (maxIdx - minIdx + 1)) + minIdx);
          currentPagesCount++;
        }
        insertIndices.sort((a, b) => a - b);
        for (const insertIdx of insertIndices) {
          const newPage = pdfDoc.insertPage(insertIdx, [width, height]);
          drawSecurityWarningPage(newPage, user, course, helveticaFont, helveticaBoldFont);
        }
      }

      downloadProgressCache[`${req.userId}_${courseId}`] = 8;
      const modifiedPdfBuffer = await pdfDoc.save({
        useObjectStreams: false,
        updateFieldAppearances: false
      });

      downloadProgressCache[`${req.userId}_${courseId}`] = 9;
      const userPassword = user.email.trim().toLowerCase();
      const encryptedPdfBuffer = await encryptPDF(modifiedPdfBuffer, userPassword);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${course.fileName.replace(/\s+/g, '_')}_secured.pdf"`);
      res.setHeader('Content-Length', encryptedPdfBuffer.length);
      res.end(Buffer.from(encryptedPdfBuffer));
      console.log(`[PDF Security] JS Mode: Secured and password-protected PDF streamed successfully!`);
      return;
    }

  } catch (err) {
    console.error(`[PDF Security] Server error during PDF secure process:`, err);
    res.status(500).json({ error: 'Server error processing secured PDF download' });
  } finally {
    delete downloadProgressCache[`${req.userId}_${courseId}`];
    
    // Cleanup temporary files in native mode
    if (tempInputPath) await fs.unlink(tempInputPath).catch(() => {});
    if (tempStampPath) await fs.unlink(tempStampPath).catch(() => {});
    if (tempWarningPath) await fs.unlink(tempWarningPath).catch(() => {});
    if (tempOutputPath) await fs.unlink(tempOutputPath).catch(() => {});
  }
};

// Helper function to wrap text for PDF rendering
const wrapText = (text, maxWidth, font, fontSize) => {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

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
    { label: "Authorized Licensee:", value: user.fullName || user.name || "N/A" },
    { label: "Registered Email:", value: user.email },
    { label: "Mobile Number:", value: user.mobileNumber || "N/A" },
    { label: "License Tracking ID:", value: user._id.toString() },
    { label: "Document Name:", value: course.name || "N/A" }
  ];

  details.forEach(item => {
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
    "1. This textbook / e-book is a licensed publication of The Dark Horse UPSC. It is registered exclusively to the user specified in the registration details above. This copy is authorized only for their personal educational use.",
    "2. PROHIBITED SHARING: It is strictly prohibited to share, publish, distribute, resell, or upload this PDF to any private/public forum, website, Telegram channel, Google Drive, WhatsApp group, or social media platform.",
    "3. SECURITY TRACING: This document is embedded with active visible watermarks and dynamic, invisible steganographic tracking signatures. Any leaked copies found online will be auto-scanned to retrieve these tracking IDs.",
    "4. LEGAL CONSEQUENCES: Sharing or distributing this material constitutes intellectual property theft and copyright infringement. Violations will result in immediate termination of account access without refund and legal prosecution under the Indian Copyright Act, 1957."
  ];

  warningParagraphs.forEach(p => {
    const lines = wrapText(p, width - 120, font, 9);
    lines.forEach(line => {
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

  currentY -= 15;
  // Footer message
  const footerText = "Thank you for supporting honest learning and respecting authors' copy rights.";
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

  try {
    // 1. Fetch user to verify active session
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 2. Fetch course by custom MongoDB ID
    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // 3. Verify user access: must be admin OR have courseId in interestedCourses
    const isAdmin = user.email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase();
    const interestedList = Array.isArray(user.interestedCourses) ? user.interestedCourses : [];
    const hasAccess = interestedList.some(cId => cId.toLowerCase() === course.courseId.toLowerCase());

    if (!isAdmin && !hasAccess) {
      return res.status(403).json({ error: 'Access denied: You do not have permissions for this resource' });
    }

    // 4. Stream PDF from Cloudflare R2 or local disk
    if (course.fileUrl.startsWith('r2://')) {
      const r2Key = course.fileUrl.replace('r2://', '');
      console.log(`[R2 Stream] Serving raw PDF from R2 key: ${r2Key}`);

      const r2Response = await r2Client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
      }));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', r2Response.ContentLength);
      r2Response.Body.pipe(res);
    } else {
      // Local disk file
      const filePath = path.join(__dirname, '../', course.fileUrl);
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({ error: 'Raw PDF file not found on disk' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      const fileStream = createReadStream(filePath);
      fileStream.pipe(res);
    }
  } catch (err) {
    console.error('Error fetching raw PDF:', err);
    res.status(500).json({ error: 'Server error retrieving raw PDF' });
  }
};

// Retrieve real-time progress of secured PDF download process
export const getDownloadProgress = async (req, res) => {
  const { courseId } = req.params;
  const step = downloadProgressCache[`${req.userId}_${courseId}`] || 0;
  res.json({ step });
};

