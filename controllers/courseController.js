import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PDFDocument, rgb } from 'pdf-lib';
import bwipjs from 'bwip-js';
import { encryptPDF } from '@pdfsmaller/pdf-encrypt-lite';
import Course from '../models/Course.js';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Upload a new Course PDF
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

    // Generate file url path
    const fileUrl = `/uploads/courses/${file.filename}`;

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
      // Remove old file
      const oldFilePath = path.join(__dirname, '../', course.fileUrl);
      try {
        await fs.unlink(oldFilePath);
      } catch (unlinkErr) {
        console.warn('Could not delete old file:', unlinkErr.message);
      }
      course.fileName = file.originalname;
      course.fileUrl = `/uploads/courses/${file.filename}`;
    }

    await course.save();

    res.json({
      message: 'Course updated successfully!',
      course
    });
  } catch (err) {
    console.error('Error updating course:', err);
    res.status(500).json({ error: 'Server error updating course' });
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

    // Delete the file from the filesystem
    const filePath = path.join(__dirname, '../', course.fileUrl);
    try {
      await fs.unlink(filePath);
    } catch (unlinkErr) {
      console.warn('Could not delete course file from disk:', unlinkErr.message);
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

    // 3. Resolve the local file path on disk
    const filePath = path.join(__dirname, '../', course.fileUrl);

    // Verify file existence
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Course PDF file not found on server disk.' });
    }

    // 4. Read PDF and parse the specific page
    console.log(`Analyzing course page: parsing page ${pageNumber} of file ${filePath}...`);
    const fileBuffer = await fs.readFile(filePath);
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

  try {
    // 1. Fetch user to verify active session
    console.log(`[PDF Security] Step 1: Fetching user details for ID: ${req.userId}`);
    const user = await User.findById(req.userId);
    if (!user) {
      console.log(`[PDF Security] Step 1: User not found for ID: ${req.userId}`);
      return res.status(404).json({ error: 'User not found' });
    }
    console.log(`[PDF Security] Step 1: User found (${user.email})`);

    // 2. Fetch course by custom courseId
    console.log(`[PDF Security] Step 2: Fetching course details for courseId: ${courseId}`);
    const course = await Course.findOne({ courseId });
    if (!course) {
      console.log(`[PDF Security] Step 2: Course not found for courseId: ${courseId}`);
      return res.status(404).json({ error: 'Course not found' });
    }
    console.log(`[PDF Security] Step 2: Course found (${course.name})`);

    // 3. Verify user has access to this course (check if interestedCourses contains courseId)
    console.log(`[PDF Security] Step 3: Verifying student course permissions`);
    const interestedList = Array.isArray(user.interestedCourses) ? user.interestedCourses : [];
    const hasAccess = interestedList.some(id => id.toLowerCase() === courseId.toLowerCase());

    if (!hasAccess) {
      console.log(`[PDF Security] Step 3: Access denied for user ${user.email} on course ${courseId}`);
      return res.status(403).json({ error: 'Access denied: This course is not in your interested list' });
    }
    console.log(`[PDF Security] Step 3: Access verified`);

    // 4. Validate and update download limits
    console.log(`[PDF Security] Step 4: Validating user download limits`);
    let limitEntry = user.downloadLimits.find(d => d.courseId === courseId);

    if (limitEntry) {
      if (limitEntry.downloadedCount >= limitEntry.allowedCount) {
        console.log(`[PDF Security] Step 4: Download limit reached (used ${limitEntry.downloadedCount} of ${limitEntry.allowedCount})`);
        return res.status(403).json({ error: 'Download limit reached. Please request additional download access from the admin.' });
      }
      limitEntry.downloadedCount += 1;
    } else {
      user.downloadLimits.push({
        courseId,
        downloadedCount: 1,
        allowedCount: 1
      });
    }

    // Save user state update
    await user.save();
    console.log(`[PDF Security] Step 4: Download limit tracked & updated in database`);

    // 5. Load raw PDF file into buffer
    console.log(`[PDF Security] Step 5: Loading raw PDF file from disk`);
    const filePath = path.join(__dirname, '../', course.fileUrl);
    let pdfBuffer;
    try {
      pdfBuffer = await fs.readFile(filePath);
    } catch (readErr) {
      console.error(`[PDF Security] Step 5: Error reading PDF file from disk:`, readErr);
      return res.status(500).json({ error: 'Could not retrieve course file from server disk' });
    }
    console.log(`[PDF Security] Step 5: PDF file loaded (${pdfBuffer.length} bytes)`);

    // 6. Generate barcode of student's ID string using bwip-js
    console.log(`[PDF Security] Step 6: Rendering Code 128 barcode of user ID: ${user._id}`);
    let barcodePngBuffer;
    try {
      barcodePngBuffer = await new Promise((resolve, reject) => {
        bwipjs.toBuffer({
          bcid: 'code128',
          text: user._id.toString(),
          scale: 2,
          height: 10,
          includetext: true,
          textxalign: 'center',
        }, function (err, png) {
          if (err) {
            reject(err);
          } else {
            resolve(png);
          }
        });
      });
    } catch (barcodeErr) {
      console.error(`[PDF Security] Step 6: Error rendering barcode:`, barcodeErr);
      return res.status(500).json({ error: 'Security processing error (barcode generation failed)' });
    }
    console.log(`[PDF Security] Step 6: Barcode PNG buffer generated (${barcodePngBuffer.length} bytes)`);

    // 7. Load PDF in pdf-lib, overlay stamps, and configure metadata tracking
    console.log(`[PDF Security] Step 7: Embedding barcode, watermarking PDF pages, and writing tracking metadata`);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const barcodeImage = await pdfDoc.embedPng(barcodePngBuffer);
    const helveticaFont = await pdfDoc.embedFont('Helvetica');

    // Add metadata steganography tags
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

      // Draw watermark text at top-left (left-aligned)
      const fontSize = 9;
      const textX = 25; 

      page.drawText(watermarkText, {
        x: textX,
        y: height - 25,
        size: fontSize,
        font: helveticaFont,
        color: rgb(0.6, 0.6, 0.6),
      });

      // Draw barcode image at bottom-right (right-aligned, very small)
      const barcodeWidth = 90;
      const barcodeHeight = 20;
      const barcodeX = width - barcodeWidth - 25;

      page.drawImage(barcodeImage, {
        x: barcodeX,
        y: 15,
        width: barcodeWidth,
        height: barcodeHeight,
      });
    }
    console.log(`[PDF Security] Step 7: Stamped barcode and watermark on ${pages.length} pages`);

    // 8. Save modified PDF
    console.log(`[PDF Security] Step 8: Saving modified PDF`);
    const modifiedPdfBuffer = await pdfDoc.save({
      useObjectStreams: false,
      updateFieldAppearances: false
    });

    // 9. Encrypt PDF with user email as password
    console.log(`[PDF Security] Step 9: Encrypting PDF with user email as password`);
    const userPassword = user.email.trim().toLowerCase();
    const encryptedPdfBuffer = await encryptPDF(modifiedPdfBuffer, userPassword);
    console.log(`[PDF Security] Step 9: PDF encrypted successfully (${encryptedPdfBuffer.length} bytes)`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${course.fileName.replace(/\s+/g, '_')}_secured.pdf"`);
    res.setHeader('Content-Length', encryptedPdfBuffer.length);
    res.end(Buffer.from(encryptedPdfBuffer));
    console.log(`[PDF Security] Secured and password-protected PDF streamed successfully!`);

  } catch (err) {
    console.error(`[PDF Security] Server error during PDF secure process:`, err);
    res.status(500).json({ error: 'Server error processing secured PDF download' });
  }
};
