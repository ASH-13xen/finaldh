import { PDFDocument, rgb } from 'pdf-lib';
import bwipjs from 'bwip-js';
import { encryptPDF } from '@pdfsmaller/pdf-encrypt-lite';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

// Setup robust argument parser
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const val = argv[i];
  if (val.startsWith('--')) {
    if (val.includes('=')) {
      const parts = val.split('=');
      const key = parts[0].substring(2);
      const value = parts.slice(1).join('=');
      args[key] = value;
    } else {
      const key = val.substring(2);
      const nextVal = argv[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
        args[key] = nextVal;
        i++; // skip next element
      } else {
        args[key] = 'true';
      }
    }
  }
}

const {
  courseId,
  userId,
  userName,
  userEmail,
  userMobile,
  sourceKey, // Comma separated list of keys in R2
  destinationKey,
  callbackUrl
} = args;

console.log('--- Starting PDF Asynchronous Processing Script ---');
console.log(`Course ID: ${courseId}`);
console.log(`User ID: ${userId}`);
console.log(`User Name: ${userName}`);
console.log(`User Email: ${userEmail}`);
console.log(`Source Keys: ${sourceKey}`);
console.log(`Destination Key: ${destinationKey}`);
console.log(`Callback URL: ${callbackUrl}`);
console.log('--- Environment Variables Check ---');
console.log(`CLOUDFLARE_ACCOUNT_ID: ${process.env.CLOUDFLARE_ACCOUNT_ID ? 'defined' : 'undefined'}`);
console.log(`CLOUDFLARE_ACCESS_KEY_ID: ${process.env.CLOUDFLARE_ACCESS_KEY_ID ? 'defined' : 'undefined'}`);
console.log(`CLOUDFLARE_SECRET_ACCESS_KEY: ${process.env.CLOUDFLARE_SECRET_ACCESS_KEY ? 'defined' : 'undefined'}`);
console.log(`R2_BUCKET_NAME: ${process.env.R2_BUCKET_NAME ? 'defined (' + process.env.R2_BUCKET_NAME.length + ' chars)' : 'undefined'}`);
console.log(`CALLBACK_SECRET: ${process.env.CALLBACK_SECRET ? 'defined' : 'undefined'}`);

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

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

const drawSecurityWarningPage = (page, user, font, boldFont) => {
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
    { label: "Authorized Licensee:", value: user.userName || "N/A" },
    { label: "Registered Email:", value: user.userEmail || "N/A" },
    { label: "Mobile Number:", value: user.userMobile || "N/A" },
    { label: "License Tracking ID:", value: user.userId },
    { label: "Document Name:", value: user.courseId }
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
    "1. LICENSED USE",
    "This document is uniquely registered to the individual named above and is intended solely for the registered user’s personal educational use.",
    "2. PROHIBITED SHARING: It is strictly prohibited to share, publish, distribute, resell, or upload this PDF to any private/public forum, website, Telegram channel, Google Drive, WhatsApp group, or social media platform.",
    "3. SECURITY TRACING: This document is embedded with active visible watermarks and dynamic, invisible steganographic tracking signatures. Any leaked copies found online will be auto-scanned to retrieve these tracking IDs.",
    "4. LEGAL CONSEQUENCES",
    "Unauthorized sharing, distribution and reproduction of this document constitutes a breach of this license agreement. Violations will result in immediate termination of access without refund and initiation of appropriate legal proceedings."
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

async function updateProgress(step) {
  console.log(`Reporting progress step: ${step}`);
  try {
    await axios.post(callbackUrl, {
      status: 'progress',
      step,
      courseId,
      userId
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CALLBACK_SECRET}`
      }
    });
  } catch (err) {
    console.error(`Failed to report progress step ${step}:`, err.message);
  }
}

async function run() {
  try {
    const keys = sourceKey.split(',').map(k => k.trim());
    const pdfDocs = [];

    // Notify backend that we started downloading parts (Step 5)
    await updateProgress(5);

    // 1. Download files from R2
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      console.log(`Downloading part ${i+1}/${keys.length} from Cloudflare R2: ${key}`);
      const r2Response = await r2Client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
      }));

      const chunks = [];
      for await (const chunk of r2Response.Body) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);
      const doc = await PDFDocument.load(fileBuffer);
      pdfDocs.push(doc);
    }

    // Notify backend that we are generating the barcode (Step 6)
    await updateProgress(6);

    // 2. Generate barcode buffer
    console.log(`Generating user barcode image for userId: ${userId}`);
    const barcodePngBuffer = await new Promise((resolve, reject) => {
      bwipjs.toBuffer({
        bcid: 'code128',
        text: userId,
        scale: 2,
        height: 10,
        includetext: true,
        textxalign: 'center',
      }, (err, png) => {
        if (err) reject(err);
        else resolve(png);
      });
    });

    // Notify backend that we are applying watermarks (Step 7)
    await updateProgress(7);

    // 3. Setup stamp & watermarks in a merged document
    const mergedPdfDoc = await PDFDocument.create();
    const barcodeImage = await mergedPdfDoc.embedPng(barcodePngBuffer);
    const helveticaFont = await mergedPdfDoc.embedFont('Helvetica');
    const helveticaBoldFont = await mergedPdfDoc.embedFont('Helvetica-Bold');

    mergedPdfDoc.setTitle(courseId);
    mergedPdfDoc.setAuthor(userEmail);
    mergedPdfDoc.setProducer('The Dark Horse UPSC');
    mergedPdfDoc.setCreator('The Dark Horse UPSC');
    mergedPdfDoc.setKeywords([userId, userEmail]);

    const watermarkText = `Name: ${userName}  |  Email: ${userEmail}  |  Mobile: ${userMobile || 'N/A'}`;

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

    // 4. Insert security warning pages
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
        drawSecurityWarningPage(newPage, { userName, userEmail, userMobile, userId, courseId }, helveticaFont, helveticaBoldFont);
      }
    }

    // Notify backend that we are saving the PDF (Step 8)
    await updateProgress(8);

    // 5. Save modified PDF
    console.log('Saving watermarked PDF...');
    const modifiedPdfBuffer = await mergedPdfDoc.save({
      useObjectStreams: false,
      updateFieldAppearances: false
    });

    // Notify backend that we are encrypting and uploading (Step 9)
    await updateProgress(9);

    // 6. Encrypt PDF with user's mobile number (fallback to email if not registered)
    console.log('Encrypting PDF...');
    let userPassword = userEmail.trim().toLowerCase();
    if (userMobile && userMobile.trim() !== 'N/A' && userMobile.trim() !== '') {
      const digits = userMobile.replace(/\D/g, '');
      userPassword = digits.length >= 10 ? digits.slice(-10) : digits;
    }
    const encryptedPdfBuffer = await encryptPDF(modifiedPdfBuffer, userPassword);

    // 7. Upload to R2
    console.log(`Uploading processed PDF back to R2: ${destinationKey}`);
    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: destinationKey,
      Body: Buffer.from(encryptedPdfBuffer),
      ContentType: 'application/pdf',
    }));

    // 8. Ping callback URL
    console.log(`Pinging callback webhook: ${callbackUrl}`);
    await axios.post(callbackUrl, {
      status: 'completed',
      courseId,
      userId,
      destinationKey
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CALLBACK_SECRET}`
      }
    });

    console.log('Asynchronous processing completed successfully!');
  } catch (err) {
    console.error('Error during asynchronous PDF generation:', err);
    try {
      // Notify failure
      await axios.post(callbackUrl, {
        status: 'failed',
        courseId,
        userId,
        error: err.message || 'Unknown error during script run'
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CALLBACK_SECRET}`
        }
      });
    } catch (cbErr) {
      console.error('Failed to notify callback URL of failure:', cbErr.message);
    }
    process.exit(1);
  }
}

run();
