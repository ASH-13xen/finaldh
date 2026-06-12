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
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import DownloadSession from '../models/DownloadSession.js';
import mongoose from 'mongoose';
import { exec } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global cache to track real-time download progress steps (kept for backward-compatibility)
export const downloadProgressCache = {};

export const setSessionProgress = async (userId, courseId, step, status = 'processing', error = null) => {
  try {
    await DownloadSession.findOneAndUpdate(
      { userId, courseId },
      { step, status, error },
      { upsert: true }
    );
  } catch (err) {
    console.error(`[DownloadSession] Error updating progress:`, err);
  }
};

// Upload a new Course PDF
export const uploadCourse = async (req, res) => {
  const { courseId, name, subject, price, discountedPrice, useDiscount } = req.body;
  const files = req.files || [];

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
  if (files.length === 0) {
    return res.status(400).json({ error: 'Course PDF file(s) are required' });
  }

  try {
    // Check if courseId is unique
    const existing = await Course.findOne({ courseId });
    if (existing) {
      return res.status(400).json({ error: 'Course ID must be unique' });
    }

    const fileUrls = [];
    const fileNames = [];
    const partPageCounts = [];

    for (const file of files) {
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

      // Count pages of this PDF file
      let pageCount = 0;
      try {
        const fileBytes = await fs.readFile(file.path);
        const tempPdfDoc = await PDFDocument.load(fileBytes, {
          updateFieldAppearances: false
        });
        pageCount = tempPdfDoc.getPageCount();
      } catch (pdfErr) {
        console.warn(`[PDF Warning] Could not parse page count for ${file.originalname}:`, pdfErr.message);
      }

      fileUrls.push(`r2://${file.filename}`);
      fileNames.push(file.originalname);
      partPageCounts.push(pageCount);
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
      discountedPrice: discountedPrice !== undefined ? Number(discountedPrice) : Number(price),
      useDiscount: useDiscount === 'true' || useDiscount === true
    });

    res.json({
      message: 'Course PDF uploaded successfully!',
      course: newCourse
    });
  } catch (err) {
    console.error('Error uploading course:', err);
    res.status(500).json({ error: 'Server error uploading course PDF' });
  } finally {
    // Delete temp files
    for (const file of files) {
      if (file && file.path) {
        try {
          await fs.unlink(file.path);
          console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
        } catch (unlinkErr) {
          console.warn(`[Cleanup] Failed to delete temp file ${file.path}:`, unlinkErr.message);
        }
      }
    }
  }
};

// Update an existing course
export const updateCourse = async (req, res) => {
  const { id } = req.params;
  const { courseId, name, subject, price, discountedPrice, useDiscount } = req.body;
  const files = req.files || [];

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
    if (discountedPrice !== undefined) course.discountedPrice = Number(discountedPrice);
    if (useDiscount !== undefined) course.useDiscount = useDiscount === 'true' || useDiscount === true;

    if (files.length > 0) {
      const fileUrls = [];
      const fileNames = [];
      const partPageCounts = [];

      for (const file of files) {
        console.log(`[R2 Upload] Uploading replacement file ${file.filename} to R2...`);
        const fileStream = createReadStream(file.path);
        await r2Client.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: file.filename,
          Body: fileStream,
          ContentType: file.mimetype || 'application/pdf',
        }));
        console.log(`[R2 Upload] Replacement file uploaded to R2: ${file.filename}`);

        // Count pages of this PDF file
        let pageCount = 0;
        try {
          const fileBytes = await fs.readFile(file.path);
          const tempPdfDoc = await PDFDocument.load(fileBytes, {
            updateFieldAppearances: false
          });
          pageCount = tempPdfDoc.getPageCount();
        } catch (pdfErr) {
          console.warn(`[PDF Warning] Could not parse page count for ${file.originalname}:`, pdfErr.message);
        }

        fileUrls.push(`r2://${file.filename}`);
        fileNames.push(file.originalname);
        partPageCounts.push(pageCount);
      }

      // Cleanup old files (either from R2 or local disk depending on prefixes)
      const oldUrls = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls : [course.fileUrl];
      for (const oldUrl of oldUrls) {
        if (oldUrl) {
          if (oldUrl.startsWith('r2://')) {
            const oldR2Key = oldUrl.replace('r2://', '');
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
            const oldFilePath = path.join(__dirname, '../', oldUrl);
            try {
              await fs.unlink(oldFilePath);
            } catch (unlinkErr) {
              console.warn('Could not delete old local file:', unlinkErr.message);
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
      message: 'Course updated successfully!',
      course
    });
  } catch (err) {
    console.error('Error updating course:', err);
    res.status(500).json({ error: 'Server error updating course' });
  } finally {
    for (const file of files) {
      if (file && file.path) {
        try {
          await fs.unlink(file.path);
          console.log(`[Cleanup] Deleted temporary local file: ${file.path}`);
        } catch (unlinkErr) {
          console.warn(`[Cleanup] Failed to delete temp file ${file.path}:`, unlinkErr.message);
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
      return res.status(404).json({ error: 'Course not found' });
    }

    // Delete the file from the filesystem/R2
    const urlsToDelete = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls : [course.fileUrl];
    for (const url of urlsToDelete) {
      if (url) {
        if (url.startsWith('r2://')) {
          const r2Key = url.replace('r2://', '');
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
          const filePath = path.join(__dirname, '../', url);
          try {
            await fs.unlink(filePath);
          } catch (unlinkErr) {
            console.warn('Could not delete course file from disk:', unlinkErr.message);
          }
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

    // Map global page number to correct local part
    const partUrls = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls : [course.fileUrl];
    let targetPartUrl = partUrls[0];
    let localPageNumber = Number(pageNumber);

    if (partUrls.length > 1 && course.partPageCounts && course.partPageCounts.length === partUrls.length) {
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
      console.log(`[PDF Security] Mapping page ${pageNumber} -> Part ${targetPartIdx + 1} page ${localPageNumber}`);
    }

    // 3. Load PDF buffer from R2 or local disk
    let fileBuffer;
    if (targetPartUrl.startsWith('r2://')) {
      const r2Key = targetPartUrl.replace('r2://', '');
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
      const filePath = path.join(__dirname, '../', targetPartUrl);
      try {
        await fs.access(filePath);
        fileBuffer = await fs.readFile(filePath);
      } catch (readErr) {
        console.error(`Error reading PDF file from disk for page analysis:`, readErr);
        return res.status(404).json({ error: 'Course PDF file not found on server disk.' });
      }
    }

    // 4. Read PDF and parse the specific page
    console.log(`Analyzing course page: parsing page ${localPageNumber} (global ${pageNumber})...`);
    const parser = new PDFParse({ data: fileBuffer });
    
    // Efficiently parse ONLY the target page
    const pdfData = await parser.getText({ partial: [localPageNumber] });
    const pageObj = pdfData.pages.find(p => p.num === localPageNumber);
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
  const { checkOnly } = req.query;
  console.log(`[PDF Security] Starting secure download process for courseId: ${courseId}, checkOnly: ${checkOnly}`);

  // Determine mode (default to github-actions if not specified)
  let mode = process.env.DOWNLOAD_MODE || 'github-actions';
  console.log(`[PDF Security] Download mode: ${mode}`);

  let dispatched = false;

  // Initialize tracking only if not checkOnly
  if (checkOnly !== 'true') {
    await setSessionProgress(req.userId, courseId, 1, 'idle');
  }

  let tempStampPath = '';
  let tempWarningPath = '';
  let tempOutputPath = '';
  let rawPartPaths = [];
  let securedPartPaths = [];
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

    // Step 2 starts only if not checkOnly
    if (checkOnly !== 'true') {
      await setSessionProgress(req.userId, courseId, 2, 'idle');
    }

    // 2. Fetch course by custom courseId
    console.log(`[PDF Security] Step 2: Fetching course details for courseId: ${courseId}`);
    const course = await Course.findOne({ courseId });
    if (!course) {
      console.log(`[PDF Security] Step 2: Course not found for courseId: ${courseId}`);
      return res.status(404).json({ error: 'Course not found' });
    }
    console.log(`[PDF Security] Step 2: Course found (${course.name})`);

    // Step 3 starts only if not checkOnly
    if (checkOnly !== 'true') {
      await setSessionProgress(req.userId, courseId, 3, 'idle');
    }

    // 3. Verify user has access to this course (check if interestedCourses contains courseId)
    console.log(`[PDF Security] Step 3: Verifying student course permissions`);
    const interestedList = Array.isArray(user.interestedCourses) ? user.interestedCourses : [];
    const hasAccess = interestedList.some(id => id.toLowerCase() === courseId.toLowerCase());

    if (!hasAccess) {
      console.log(`[PDF Security] Step 3: Access denied for user ${user.email} on course ${courseId}`);
      return res.status(403).json({ error: 'Access denied: This course is not in your interested list' });
    }
    console.log(`[PDF Security] Step 3: Access verified`);

    // If checkOnly is true and mode is NOT github-actions (local/sync mode download)
    if (checkOnly === 'true' && mode !== 'github-actions') {
      console.log(`[PDF Security] checkOnly: Sync mode ${mode} ready for direct download. Checking limits first.`);
      let limitEntry = user.downloadLimits.find(d => d.courseId === courseId);
      if (limitEntry && limitEntry.downloadedCount >= limitEntry.allowedCount) {
        console.log(`[PDF Security] checkOnly: Limit reached for user: ${user.email}, course: ${courseId}`);
        return res.status(403).json({ error: 'Download limit reached. Please request additional download access from the admin.' });
      }
      return res.json({ exists: false, directStream: true });
    }

    if (mode === 'github-actions') {
      const destinationKey = `secured-${req.userId}-${courseId}.pdf`;
      console.log(`[PDF Security] Checking if secured PDF already exists in R2 under key: ${destinationKey}`);
      let fileExists = false;
      try {
        await r2Client.send(new HeadObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: destinationKey
        }));
        fileExists = true;
        console.log(`[PDF Security] Secured PDF found in R2.`);
      } catch (err) {
        console.log(`[PDF Security] Secured PDF not found in R2.`);
      }

      if (fileExists) {
        // If checkOnly is true, return that it exists so frontend can trigger native direct download redirect
        if (checkOnly === 'true') {
          console.log(`[PDF Security] checkOnly: Secured PDF exists in R2. Returning exists: true`);
          return res.json({ exists: true });
        }

        // OTHERWISE, we stream the file.
        // Prevent double-charging: Check if a completed DownloadSession exists for this user and course
        let userObjectId = null;
        try {
          if (mongoose.Types.ObjectId.isValid(req.userId)) {
            userObjectId = new mongoose.Types.ObjectId(req.userId);
          }
        } catch (err) {}

        const completedSession = await DownloadSession.findOne({
          $or: [
            { userId: req.userId, courseId, status: 'completed' },
            { userId: userObjectId, courseId, status: 'completed' }
          ].filter(q => q.userId !== null)
        });
        
        if (completedSession) {
          console.log(`[PDF Security] Direct Stream: Completed session found for user: ${req.userId}, courseId: ${courseId}. Bypassing limit increment & deleting session.`);
          // Delete completed session so subsequent downloads get charged
          await DownloadSession.deleteOne({ _id: completedSession._id }).catch(err => {
            console.error(`[PDF Security] Error deleting completed session:`, err);
          });
        } else {
          // Validate user download limits first for direct download (since it's a new download of cached PDF)
          console.log(`[PDF Security] Direct Stream: No completed session found. Validating user download limits`);
          let limitEntry = user.downloadLimits.find(d => d.courseId === courseId);
          if (limitEntry) {
            if (limitEntry.downloadedCount >= limitEntry.allowedCount) {
              console.log(`[PDF Security] Direct Stream: Download limit reached (used ${limitEntry.downloadedCount} of ${limitEntry.allowedCount})`);
              return res.status(403).json({ error: 'Download limit reached. Please request additional download access from the admin.' });
            }
          }
          console.log(`[PDF Security] Direct Stream: User download limits verified`);

          // Pre-emptively track and update download limit in database since we are streaming the file
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
            console.log(`[PDF Security] Direct Stream: Download count incremented in database`);
          }
        }

        console.log(`[PDF Security] Direct Stream: Fetching secured PDF from R2: ${destinationKey}`);
        const getResponse = await r2Client.send(new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: destinationKey
        }));
        console.log(`[PDF Security] Direct Stream: Object retrieved. ContentLength: ${getResponse.ContentLength} bytes. Writing response headers.`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${course.fileName.replace(/\s+/g, '_')}_secured.pdf"`);
        res.setHeader('Content-Length', getResponse.ContentLength);
        
        console.log(`[PDF Security] Direct Stream: Headers written. Piping stream to client.`);
        
        res.on('finish', () => {
          console.log(`[PDF Security] Direct Stream: Successfully completed streaming secured PDF for courseId: ${courseId}`);
        });

        res.on('close', () => {
          console.log(`[PDF Security] Direct Stream: Client connection closed for courseId: ${courseId}`);
        });

        res.on('error', (err) => {
          console.error(`[PDF Security] Direct Stream: Client response streaming error:`, err);
        });

        getResponse.Body.pipe(res);
        return;
      }
    }

    // Step 4 starts only if not checkOnly
    if (checkOnly !== 'true') {
      await setSessionProgress(req.userId, courseId, 4, 'idle');
    }

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

    if (mode === 'github-actions') {
      const destinationKey = `secured-${req.userId}-${courseId}.pdf`;
      // If it doesn't exist, check if there's already an active job in progress
      const activeJob = await DownloadSession.findOne({ userId: req.userId, courseId });
      if (activeJob && (activeJob.status === 'queued' || activeJob.status === 'processing')) {
        console.log(`[PDF Security] Job is already running. Database value:`, activeJob);
        return res.status(202).json({
          status: 'processing',
          message: 'PDF generation is currently in progress',
          step: activeJob.step || 1
        });
      }

      // Pre-emptively track and update download limit in database since we are starting generation
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

      const repoOwner = process.env.GITHUB_REPO_OWNER;
      const repoName = process.env.GITHUB_REPO_NAME;
      const githubPat = process.env.GITHUB_PAT;
      
      if (!repoOwner || !repoName || !githubPat) {
        console.error('[PDF Security] Missing GitHub repository info or PAT in env');
        return res.status(500).json({ error: 'GitHub Actions background worker is not fully configured' });
      }

      const partUrls = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls : [course.fileUrl];
      const sourceKeys = partUrls.map(url => url.replace('r2://', '')).join(',');

      let callbackUrl = `${req.protocol}://${req.get('host')}/api/courses/github-callback`;
      if (process.env.BACKEND_URL) {
        callbackUrl = `${process.env.BACKEND_URL.replace(/\/$/, '')}/api/courses/github-callback`;
      }

      const dispatchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/pdf-processor.yml/dispatches`;
      
      console.log(`[PDF Security] Triggering GitHub workflow dispatch at: ${dispatchUrl}`);

      try {
        const response = await fetch(dispatchUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${githubPat}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'render-backend-app',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: {
              courseId: course.courseId,
              userId: req.userId,
              userName: user.fullName || user.name || 'Scholar',
              userEmail: user.email,
              userMobile: user.mobileNumber || 'N/A',
              sourceKey: sourceKeys,
              destinationKey: destinationKey,
              callbackUrl: callbackUrl
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[PDF Security] GitHub API returned error ${response.status}: ${errorText}`);
          throw new Error(`GitHub API returned ${response.status}: ${errorText}`);
        }

        await setSessionProgress(req.userId, courseId, 1, 'queued');
        dispatched = true;
        console.log(`[PDF Security] Successfully dispatched GitHub workflow run`);

        return res.status(202).json({
          status: 'processing',
          message: 'PDF generation queued on GitHub Actions worker'
        });
      } catch (dispatchErr) {
        console.error(`[PDF Security] Error triggering workflow dispatch:`, dispatchErr);
        if (creditIncremented) {
          const refundUser = await User.findById(req.userId);
          if (refundUser) {
            let refundEntry = refundUser.downloadLimits.find(d => d.courseId === courseId);
            if (refundEntry && refundEntry.downloadedCount > 0) {
              refundEntry.downloadedCount -= 1;
              await refundUser.save();
            }
          }
        }
        return res.status(500).json({ error: 'Failed to trigger background PDF processing: ' + dispatchErr.message });
      }
    }

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

    const partUrls = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls : [course.fileUrl];

    // --- MODE 1: CLIENT-SIDE PROCESSING ---
    if (mode === 'client-side') {
      // Fall back to server-native if the course is multi-part, since concatenated PDFs are invalid
      if (partUrls.length > 1) {
        console.log(`[PDF Security] Client-side Mode: Multi-part course detected. Automatically falling back to server-native mode.`);
        mode = 'server-native';
      } else {
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
          
          r2Response.Body.pipe(res);
        } else {
          console.log(`[PDF Security] Client-side Mode: Streaming from local disk`);
          const filePath = path.join(__dirname, '../', course.fileUrl);
          const fileStream = createReadStream(filePath);
          fileStream.pipe(res);
        }
        return;
      }
    }

    // --- MODE 2: SERVER-SIDE NATIVE (QPDF) PROCESSING ---
    if (mode === 'server-native') {
      await setSessionProgress(req.userId, courseId, 5, 'processing');
      
      // Ensure temp directory exists
      const tempDir = path.join(__dirname, '../uploads/temp');
      await fs.mkdir(tempDir, { recursive: true });

      tempStampPath = path.join(tempDir, `stamp_${req.userId}_${courseId}.pdf`);
      tempWarningPath = path.join(tempDir, `warning_${req.userId}_${courseId}.pdf`);
      tempOutputPath = path.join(tempDir, `output_${req.userId}_${courseId}.pdf`);

      let totalPages = 0;
      let firstPageWidth = 595.276; // Default A4
      let firstPageHeight = 841.89;

      // 5. Download and process parts sequentially to save memory
      for (let i = 0; i < partUrls.length; i++) {
        const partUrl = partUrls[i];
        const rawPartPath = path.join(tempDir, `part_${i}_raw_${req.userId}_${courseId}.pdf`);
        const securedPartPath = path.join(tempDir, `part_${i}_secured_${req.userId}_${courseId}.pdf`);
        rawPartPaths.push(rawPartPath);
        securedPartPaths.push(securedPartPath);

        if (partUrl.startsWith('r2://')) {
          const r2Key = partUrl.replace('r2://', '');
          console.log(`[PDF Security] Native Mode: Downloading part ${i+1}/${partUrls.length} from R2 (key: ${r2Key})`);
          const r2Response = await r2Client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }));
          await pipeline(r2Response.Body, createWriteStream(rawPartPath));
        } else {
          console.log(`[PDF Security] Native Mode: Copying local part ${i+1}/${partUrls.length}`);
          const localFilePath = path.join(__dirname, '../', partUrl);
          await fs.copyFile(localFilePath, rawPartPath);
        }

        // Get dimensions and page count of part using qpdf
        const { stdout: qpdfInfo } = await execPromise(`qpdf --show-pages "${rawPartPath}"`);
        const partPageCount = (qpdfInfo.match(/page \d+:/g) || []).length;
        totalPages += partPageCount;

        if (i === 0) {
          const sizeMatch = qpdfInfo.match(/page 1:[^]*?size: ([\d.]+) x ([\d.]+)/i);
          if (sizeMatch) {
            firstPageWidth = parseFloat(sizeMatch[1]);
            firstPageHeight = parseFloat(sizeMatch[2]);
          }
        }
      }
      console.log(`[PDF Security] Native Mode: All parts downloaded. Total pages: ${totalPages}`);

      await setSessionProgress(req.userId, courseId, 6, 'processing');

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

      await setSessionProgress(req.userId, courseId, 7, 'processing');

      // Create stamp PDF (1 page with watermark & barcode)
      console.log(`[PDF Security] Native Mode: Creating watermark stamp PDF`);
      const stampDoc = await PDFDocument.create();
      const helveticaFont = await stampDoc.embedFont('Helvetica');
      const helveticaBoldFont = await stampDoc.embedFont('Helvetica-Bold');
      const stampPage = stampDoc.addPage([firstPageWidth, firstPageHeight]);

      const watermarkText = `Name: ${user.fullName || user.name}  |  Email: ${user.email}  |  Mobile: ${user.mobileNumber || 'N/A'}`;
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

      const stampBytes = await stampDoc.save();
      await fs.writeFile(tempStampPath, stampBytes);

      // Create warning PDF (1 page)
      console.log(`[PDF Security] Native Mode: Creating warning page PDF`);
      const warningDoc = await PDFDocument.create();
      const warningPage = warningDoc.addPage([firstPageWidth, firstPageHeight]);
      drawSecurityWarningPage(warningPage, user, course, helveticaFont, helveticaBoldFont);
      const warningBytes = await warningDoc.save();
      await fs.writeFile(tempWarningPath, warningBytes);

      // 7. Apply watermark stamp to each part sequentially
      for (let i = 0; i < partUrls.length; i++) {
        console.log(`[PDF Security] Native Mode: Watermarking part ${i+1}/${partUrls.length}`);
        const qpdfStampCmd = `qpdf "${rawPartPaths[i]}" --overlay "${tempStampPath}" --repeat=1-z -- "${securedPartPaths[i]}"`;
        await execPromise(qpdfStampCmd);
        // Clean up the raw file immediately
        await fs.unlink(rawPartPaths[i]).catch(() => {});
      }

      await setSessionProgress(req.userId, courseId, 8, 'processing');

      // Determine warning page positions in global page space
      const numPagesToAdd = Math.max(1, Math.floor(totalPages / 40));
      const insertPositions = [];
      for (let j = 0; j < numPagesToAdd; j++) {
        insertPositions.push(Math.floor(Math.random() * (totalPages + 1)) + 1);
      }
      insertPositions.sort((a, b) => a - b);

      // Get page counts of each secured part
      const partPageCounts = [];
      for (let i = 0; i < securedPartPaths.length; i++) {
        const { stdout: partInfo } = await execPromise(`qpdf --show-pages "${securedPartPaths[i]}"`);
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
          const partGlobalEnd = globalPageCursor + (partLength - currentPartPageStart);

          if (insertPos <= partGlobalEnd) {
            const localInsertOffset = insertPos - globalPageCursor;
            const localInsertPage = currentPartPageStart + localInsertOffset;

            if (localInsertPage > currentPartPageStart) {
              qpdfPages.push(`"${securedPartPaths[currentPartIdx]}"`, `${currentPartPageStart}-${localInsertPage - 1}`);
            }
            qpdfPages.push(`"${tempWarningPath}"`, `1`);

            currentPartPageStart = localInsertPage;
            globalPageCursor = insertPos;
            break;
          } else {
            if (currentPartPageStart <= partLength) {
              qpdfPages.push(`"${securedPartPaths[currentPartIdx]}"`, `${currentPartPageStart}-z`);
            }
            globalPageCursor += (partLength - currentPartPageStart + 1);
            currentPartIdx++;
            currentPartPageStart = 1;
          }
        }
      }

      while (currentPartIdx < securedPartPaths.length) {
        const partLength = partPageCounts[currentPartIdx];
        if (currentPartPageStart <= partLength) {
          qpdfPages.push(`"${securedPartPaths[currentPartIdx]}"`, `${currentPartPageStart}-z`);
        }
        currentPartIdx++;
        currentPartPageStart = 1;
      }

      // 8. Execute qpdf to merge stamped parts, insert warnings, and encrypt
      console.log(`[PDF Security] Native Mode: Running final qpdf merge & encrypt`);
      let userPassword = user.email.trim().toLowerCase();
      if (user.mobileNumber && user.mobileNumber.trim() !== 'N/A' && user.mobileNumber.trim() !== '') {
        const digits = user.mobileNumber.replace(/\D/g, '');
        userPassword = digits.length >= 10 ? digits.slice(-10) : digits;
      }
      
      const qpdfCommand = `qpdf --empty --pages ${qpdfPages.join(' ')} -- --encrypt "${userPassword}" "${userPassword}" 256 -- "${tempOutputPath}"`;
      await execPromise(qpdfCommand);

      await setSessionProgress(req.userId, courseId, 9, 'completed');

      // Stream output file
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
      await setSessionProgress(req.userId, courseId, 5, 'processing');

      const pdfDocs = [];
      for (let i = 0; i < partUrls.length; i++) {
        const partUrl = partUrls[i];
        let pdfBuffer;
        if (partUrl.startsWith('r2://')) {
          const r2Key = partUrl.replace('r2://', '');
          console.log(`[PDF Security] JS Mode: Loading part ${i+1}/${partUrls.length} from Cloudflare R2 (key: ${r2Key})`);
          const r2Response = await r2Client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
          }));
          pdfBuffer = Buffer.from(await r2Response.Body.transformToByteArray());
        } else {
          console.log(`[PDF Security] JS Mode: Loading part ${i+1}/${partUrls.length} from local disk`);
          const filePath = path.join(__dirname, '../', partUrl);
          pdfBuffer = await fs.readFile(filePath);
        }
        const doc = await PDFDocument.load(pdfBuffer);
        pdfDocs.push(doc);
      }

      await setSessionProgress(req.userId, courseId, 6, 'processing');

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

      await setSessionProgress(req.userId, courseId, 7, 'processing');

      const mergedPdfDoc = await PDFDocument.create();
      const barcodeImage = await mergedPdfDoc.embedPng(barcodePngBuffer);
      const helveticaFont = await mergedPdfDoc.embedFont('Helvetica');
      const helveticaBoldFont = await mergedPdfDoc.embedFont('Helvetica-Bold');

      mergedPdfDoc.setTitle(course.name || 'Secured Course PDF');
      mergedPdfDoc.setAuthor(user.email);
      mergedPdfDoc.setSubject(course.subject || 'Syllabus Course Content');
      mergedPdfDoc.setProducer('The Dark Horse UPSC');
      mergedPdfDoc.setCreator('The Dark Horse UPSC');
      mergedPdfDoc.setKeywords([user._id.toString(), user.email]);

      const watermarkText = `Name: ${user.fullName || user.name}  |  Email: ${user.email}  |  Mobile: ${user.mobileNumber || 'N/A'}`;

      let totalOriginalPages = 0;
      for (const doc of pdfDocs) {
        const copiedPages = await mergedPdfDoc.copyPages(doc, doc.getPageIndices());
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

          mergedPdfDoc.addPage(page);
          totalOriginalPages++;
        }
      }

      if (totalOriginalPages > 0) {
        const firstPage = mergedPdfDoc.getPages()[0];
        const { width, height } = firstPage.getSize();
        const numPagesToAdd = Math.max(1, Math.floor(totalOriginalPages / 40));
        const insertIndices = [];
        let currentPagesCount = totalOriginalPages;
        for (let j = 0; j < numPagesToAdd; j++) {
          let maxIdx = currentPagesCount;
          let minIdx = currentPagesCount > 1 ? 1 : 0;
          insertIndices.push(Math.floor(Math.random() * (maxIdx - minIdx + 1)) + minIdx);
          currentPagesCount++;
        }
        insertIndices.sort((a, b) => a - b);
        for (const insertIdx of insertIndices) {
          const newPage = mergedPdfDoc.insertPage(insertIdx, [width, height]);
          drawSecurityWarningPage(newPage, user, course, helveticaFont, helveticaBoldFont);
        }
      }

      await setSessionProgress(req.userId, courseId, 8, 'processing');
      const modifiedPdfBuffer = await mergedPdfDoc.save({
        useObjectStreams: false,
        updateFieldAppearances: false
      });

      await setSessionProgress(req.userId, courseId, 9, 'completed');
      let userPassword = user.email.trim().toLowerCase();
      if (user.mobileNumber && user.mobileNumber.trim() !== 'N/A' && user.mobileNumber.trim() !== '') {
        const digits = user.mobileNumber.replace(/\D/g, '');
        userPassword = digits.length >= 10 ? digits.slice(-10) : digits;
      }
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
    if (!dispatched) {
      await DownloadSession.deleteOne({ userId: req.userId, courseId }).catch(err => 
        console.error(`[DownloadSession] Error deleting session on cleanup:`, err)
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
  try {
    let userObjectId = null;
    try {
      if (mongoose.Types.ObjectId.isValid(req.userId)) {
        userObjectId = new mongoose.Types.ObjectId(req.userId);
      }
    } catch (err) {}

    const session = await DownloadSession.findOne({
      $or: [
        { userId: req.userId, courseId },
        { userId: userObjectId, courseId }
      ].filter(q => q.userId !== null)
    });
    if (!session) {
      return res.json({ step: 0, status: 'idle' });
    }
    let status = session.status;
    if (status === 'idle' && session.step > 0) {
      status = 'processing';
    }
    res.json({
      step: session.step || 0,
      status: status || 'processing',
      error: session.error || null
    });
  } catch (err) {
    console.error(`[DownloadSession] Error retrieving progress:`, err);
    res.status(500).json({ error: 'Server error retrieving progress' });
  }
};

// Webhook callback from GitHub Actions PDF processor
export const githubCallback = async (req, res) => {
  const authHeader = req.headers.authorization;
  const expectedSecret = `Bearer ${process.env.GITHUB_CALLBACK_SECRET}`;

  if (!authHeader || authHeader !== expectedSecret) {
    console.warn('[GitHub Callback] Unauthorized webhook callback attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { status, courseId, userId, destinationKey, step, error } = req.body;
  console.log(`[GitHub Callback] Received update. status: ${status}, courseId: ${courseId}, userId: ${userId}, step: ${step}`);

  if (status === 'progress') {
    await setSessionProgress(userId, courseId, step, 'processing');
  } else if (status === 'completed') {
    await setSessionProgress(userId, courseId, 9, 'completed');
    console.log(`[GitHub Callback] PDF processing completed successfully. Key: ${destinationKey}`);
  } else if (status === 'failed') {
    await setSessionProgress(userId, courseId, 0, 'failed', error || 'Processing failed');
    console.error(`[GitHub Callback] PDF processing failed: ${error}`);
  }

  res.json({ status: 'ok' });
};

