import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import fs from 'fs/promises';

// Load .env from backend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

// Load models
import User from '../models/User.js';
import Course from '../models/Course.js';
import DownloadRequest from '../models/DownloadRequest.js';

const PORT = process.env.PORT || 5000;
const BASE_URL = `http://localhost:${PORT}`;

async function runTests() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGODB_URI found in backend .env");
    process.exit(1);
  }

  console.log("Connecting to Database...");
  await mongoose.connect(uri);

  let studentUser = null;
  let adminUser = null;
  let mockCourse = null;
  let studentToken = "";
  let adminToken = "";

  try {
    const time = Date.now();
    const studentEmail = `student_${time}@example.com`;
    const adminEmail = process.env.ADMIN_EMAIL || `admin_${time}@example.com`;

    console.log("Setting up Mock Course...");
    // Let's check if there are any existing courses or if we create one
    // We will create a mock course on disk so the server has a real file to read.
    const mockPdfPath1 = path.join(__dirname, '../uploads/courses/mock_test_part_1.pdf');
    const mockPdfPath2 = path.join(__dirname, '../uploads/courses/mock_test_part_2.pdf');
    // Ensure uploads/courses directory exists
    await fs.mkdir(path.dirname(mockPdfPath1), { recursive: true });
    // Write a tiny dummy PDF header/content
    const dummyPdfContent = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] >>\nendobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF";
    await fs.writeFile(mockPdfPath1, dummyPdfContent);
    await fs.writeFile(mockPdfPath2, dummyPdfContent);

    mockCourse = await Course.create({
      courseId: `mock-course-${time}`,
      name: "Mock Security Course",
      subject: "GS-1",
      fileName: "mock_test_part_1.pdf",
      fileUrl: `/uploads/courses/mock_test_part_1.pdf`,
      fileUrls: [`/uploads/courses/mock_test_part_1.pdf`, `/uploads/courses/mock_test_part_2.pdf`],
      fileNames: [`mock_test_part_1.pdf`, `mock_test_part_2.pdf`],
      partPageCounts: [1, 1],
      price: 499
    });

    console.log(`Setting up Test Student: ${studentEmail}`);
    studentUser = await User.create({
      googleId: `google_student_${time}`,
      email: studentEmail,
      name: "Test Student",
      fullName: "Test Student Name",
      mobileNumber: "9876543210",
      interestedCourses: [`mock-course-${time}`]
    });

    console.log(`Setting up Test Admin: ${adminEmail}`);
    adminUser = await User.findOne({ email: adminEmail.toLowerCase() });
    if (!adminUser) {
      adminUser = await User.create({
        googleId: `google_admin_${time}`,
        email: adminEmail.toLowerCase(),
        name: "Test Admin",
        fullName: "Test Admin Name"
      });
    }

    const jwtSecret = process.env.JWT_SECRET || 'mysecret';
    studentToken = jwt.sign({ userId: studentUser._id, email: studentUser.email }, jwtSecret);
    adminToken = jwt.sign({ userId: adminUser._id, email: adminUser.email }, jwtSecret);

    console.log("Tokens generated successfully. Beginning secured download tests...");

    // Test 1: Fetch Profile and check downloadLimits is empty array by default
    console.log("\n--- TEST 1: Fetch student profile ---");
    let res = await fetch(`${BASE_URL}/api/user/profile`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    if (!res.ok) throw new Error(`Fetch profile failed: ${res.statusText}`);
    let profile = await res.json();
    console.log("Profile downloadLimits:", profile.downloadLimits);
    if (!Array.isArray(profile.downloadLimits)) throw new Error("downloadLimits is not an array");

    // Test 2: Perform 1st download (should succeed, return PDF content, and set count to 1)
    console.log("\n--- TEST 2: Perform first secured PDF download ---");
    res = await fetch(`${BASE_URL}/api/courses/download/mock-course-${time}`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`First secure download failed: ${JSON.stringify(err)}`);
    }
    console.log("Response Content-Type:", res.headers.get('content-type'));
    if (!res.headers.get('content-type').includes('application/pdf')) {
      throw new Error("Response is not a PDF");
    }
    const pdfBytes = await res.arrayBuffer();
    console.log(`Successfully received secured PDF buffer (${pdfBytes.byteLength} bytes).`);

    // Verify limit entry was created/incremented in the database
    const updatedStudent = await User.findById(studentUser._id);
    let entry = updatedStudent.downloadLimits.find(d => d.courseId === `mock-course-${time}`);
    console.log("Database limit entry after first download:", entry);
    if (!entry || entry.downloadedCount !== 1 || entry.allowedCount !== 1) {
      throw new Error(`Unexpected downloadLimits state: ${JSON.stringify(entry)}`);
    }

    // Test 3: Attempt 2nd download (should fail with 403 because limit is 1)
    console.log("\n--- TEST 3: Attempt second download (should fail) ---");
    res = await fetch(`${BASE_URL}/api/courses/download/mock-course-${time}`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    console.log(`Second download status (expect 403): ${res.status}`);
    if (res.ok) {
      throw new Error("Second download succeeded but should have failed");
    }
    let errorResponse = await res.json();
    console.log("Error response message:", errorResponse.error);
    if (!errorResponse.error.includes("Download limit reached")) {
      throw new Error(`Unexpected error message: ${errorResponse.error}`);
    }

    // Test 4: Submit request for additional download
    console.log("\n--- TEST 4: Submit request for additional download ---");
    res = await fetch(`${BASE_URL}/api/user/download-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${studentToken}`
      },
      body: JSON.stringify({ courseId: `mock-course-${time}`, courseName: 'Mock Security Course', reason: 'Mock test reason' })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Submit request failed: ${JSON.stringify(err)}`);
    }
    let requestResult = await res.json();
    console.log("Request submit response:", requestResult);
    if (!requestResult.success) throw new Error("Request response success is not true");

    // Test 5: Verify request shows up in student's request list
    console.log("\n--- TEST 5: Fetch student's own requests ---");
    res = await fetch(`${BASE_URL}/api/user/download-requests`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    if (!res.ok) throw new Error(`Fetch user requests failed: ${res.statusText}`);
    let userRequests = await res.json();
    console.log("Student requests:", userRequests);
    let pendingRequest = userRequests.find(r => r.courseId === `mock-course-${time}` && r.status === 'pending');
    if (!pendingRequest) throw new Error("Pending request not found in user requests list");

    // Test 6: Verify request shows up in admin's pending requests list
    console.log("\n--- TEST 6: Fetch admin pending requests ---");
    res = await fetch(`${BASE_URL}/api/user/admin/requests`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) throw new Error(`Fetch admin requests failed: ${res.statusText}`);
    let adminRequests = await res.json();
    console.log("Admin pending requests count:", adminRequests.length);
    let adminPendingReq = adminRequests.find(r => r._id.toString() === pendingRequest._id.toString());
    if (!adminPendingReq) throw new Error("Pending request not found in admin requests list");

    // Test 7: Admin approves the request
    console.log("\n--- TEST 7: Admin approves the request ---");
    res = await fetch(`${BASE_URL}/api/user/admin/requests/${pendingRequest._id}/approve`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Admin approve request failed: ${JSON.stringify(err)}`);
    }
    let approveResult = await res.json();
    console.log("Approve response:", approveResult);
    if (!approveResult.success) throw new Error("Approve response success is not true");

    // Test 8: Verify student profile allowedCount is now 2
    console.log("\n--- TEST 8: Verify updated student profile limits ---");
    res = await fetch(`${BASE_URL}/api/user/profile`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    if (!res.ok) throw new Error(`Fetch updated profile failed: ${res.statusText}`);
    profile = await res.json();
    console.log("Updated profile downloadLimits:", profile.downloadLimits);
    entry = profile.downloadLimits.find(d => d.courseId === `mock-course-${time}`);
    if (!entry || entry.downloadedCount !== 1 || entry.allowedCount !== 2) {
      throw new Error(`Unexpected updated limits state: ${JSON.stringify(entry)}`);
    }

    // Test 9: Perform 2nd download (should succeed now that limit is 2)
    console.log("\n--- TEST 9: Perform second download (should succeed now) ---");
    res = await fetch(`${BASE_URL}/api/courses/download/mock-course-${time}`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Second download failed: ${JSON.stringify(err)}`);
    }
    console.log("Response Content-Type (2nd download):", res.headers.get('content-type'));
    const pdfBytes2 = await res.arrayBuffer();
    console.log(`Successfully received second secured PDF buffer (${pdfBytes2.byteLength} bytes).`);

    // Verify database counts have incremented to 2 downloaded out of 2 allowed
    const updatedStudent2 = await User.findById(studentUser._id);
    entry = updatedStudent2.downloadLimits.find(d => d.courseId === `mock-course-${time}`);
    console.log("Database limit entry after second download:", entry);
    if (!entry || entry.downloadedCount !== 2 || entry.allowedCount !== 2) {
      throw new Error(`Unexpected final limits state: ${JSON.stringify(entry)}`);
    }

    console.log("\n--- ALL PDF SECURITY SYSTEM INTEGRATION TESTS PASSED COMPLETED SUCCESSFULLY! ---");

  } catch (err) {
    console.error("\nTEST FAILURE ERROR:", err);
  } finally {
    // Cleanup database and file
    console.log("\nCleaning up test database records and mock files...");
    if (studentUser) {
      try {
        await User.deleteOne({ _id: studentUser._id });
        await DownloadRequest.deleteMany({ user: studentUser._id });
      } catch (cleanupErr) {
        console.error("Db Cleanup error:", cleanupErr);
      }
    }
    if (mockCourse) {
      try {
        await Course.deleteOne({ _id: mockCourse._id });
        const mockPdfPath1 = path.join(__dirname, '../uploads/courses/mock_test_part_1.pdf');
        const mockPdfPath2 = path.join(__dirname, '../uploads/courses/mock_test_part_2.pdf');
        await fs.unlink(mockPdfPath1).catch(() => {});
        await fs.unlink(mockPdfPath2).catch(() => {});
      } catch (courseCleanupErr) {
        console.error("Course Cleanup error:", courseCleanupErr);
      }
    }
    await mongoose.connection.close();
    console.log("Database connection closed.");
  }
}

runTests();
