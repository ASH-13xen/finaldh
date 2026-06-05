import mongoose from 'mongoose';
import dotenv from 'dotenv';
import https from 'https';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1p8bNB0jBxwH4rcy3BGUX53E5yv2dtHt3l443pUbLxYo/export?format=csv&gid=1429469952';

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects if any (e.g. status code 301, 302, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchCSV(res.headers.location));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Failed to fetch spreadsheet: status code ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote inside quotes
        row[row.length - 1] += '"';
        i++;
      } else {
        // Toggle quote block
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // New cell
      row.push("");
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      // New row
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      lines.push(row);
      row = [""];
    } else {
      row[row.length - 1] += char;
    }
  }
  if (row.length > 1 || row[0] !== "") {
    lines.push(row);
  }
  return lines;
}

async function importData() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not defined in the backend .env file.");
    process.exit(1);
  }

  console.log("Connecting to MongoDB...");
  await mongoose.connect(uri);
  console.log("Connected to MongoDB.");

  try {
    console.log("Fetching Google Spreadsheet data...");
    const csvData = await fetchCSV(SHEET_CSV_URL);
    
    // Save the downloaded spreadsheet data as a CSV file
    const csvPath = path.join(__dirname, '../responses.csv');
    await fs.writeFile(csvPath, csvData, 'utf8');
    console.log(`Saved spreadsheet data as CSV file to: ${csvPath}`);

    console.log("Parsing CSV data...");
    const parsedRows = parseCSV(csvData);

    if (parsedRows.length <= 1) {
      console.log("No data found in the spreadsheet (only headers or empty).");
      return;
    }

    const header = parsedRows[0];
    console.log("Detected Columns:", header);

    // Columns index lookup
    // Expecting: Timestamp,Email address,Full Name (Official),Mobile Number,Telegram Name / Username ID,Select your interested choice : ,Kindly upload the payment screenshot.,Column 1
    const emailIdx = header.findIndex(h => h.toLowerCase().includes("email"));
    const nameIdx = header.findIndex(h => h.toLowerCase().includes("full name") || h.toLowerCase() === "name");
    const mobileIdx = header.findIndex(h => h.toLowerCase().includes("mobile"));
    const telegramIdx = header.findIndex(h => h.toLowerCase().includes("telegram"));
    const coursesIdx = header.findIndex(h => h.toLowerCase().includes("interested choice") || h.toLowerCase().includes("interested course") || h.toLowerCase().includes("select your interested choice"));

    console.log(`Column Mapping indices -> Email: ${emailIdx}, Name: ${nameIdx}, Mobile: ${mobileIdx}, Telegram: ${telegramIdx}, Courses: ${coursesIdx}`);

    if (emailIdx === -1) {
      throw new Error("Could not find 'Email address' column in spreadsheet header.");
    }

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    // Process rows starting from index 1 (skipping header)
    for (let i = 1; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      if (!row || row.length <= 1) continue;

      const rawEmail = row[emailIdx];
      if (!rawEmail || !rawEmail.includes("@")) {
        console.log(`Row ${i + 1}: Skipped (invalid/missing email: "${rawEmail}")`);
        skippedCount++;
        continue;
      }

      const email = rawEmail.trim().toLowerCase();
      const rawFullName = nameIdx !== -1 ? row[nameIdx] : "";
      const fullName = rawFullName ? rawFullName.trim() : "";
      const name = fullName || "User";
      
      const mobileNumber = mobileIdx !== -1 && row[mobileIdx] ? row[mobileIdx].trim() : "";
      const telegramUsername = telegramIdx !== -1 && row[telegramIdx] ? row[telegramIdx].trim() : "";
      
      // Parse interested courses (split by comma and trim)
      const rawCourses = coursesIdx !== -1 && row[coursesIdx] ? row[coursesIdx] : "";
      const interestedCourses = rawCourses
        ? rawCourses.split(",").map(c => c.trim()).filter(c => c.length > 0)
        : [];

      // Find if user already exists
      let user = await User.findOne({ email });

      if (user) {
        // Update existing user fields
        user.fullName = fullName || user.fullName;
        if (fullName) user.name = fullName;
        user.mobileNumber = mobileNumber || user.mobileNumber;
        user.telegramUsername = telegramUsername || user.telegramUsername;
        
        // Merge interested courses uniquely
        const mergedCourses = new Set([...user.interestedCourses, ...interestedCourses]);
        user.interestedCourses = Array.from(mergedCourses);

        await user.save();
        updatedCount++;
      } else {
        // Create new user with placeholder googleId
        const googleId = `imported_${email}`;
        await User.create({
          googleId,
          email,
          name,
          fullName,
          mobileNumber,
          telegramUsername,
          interestedCourses
        });
        createdCount++;
      }
    }

    console.log("\n====================================");
    console.log("Import Completed successfully:");
    console.log(`- Created new users: ${createdCount}`);
    console.log(`- Updated existing users: ${updatedCount}`);
    console.log(`- Skipped rows: ${skippedCount}`);
    console.log("====================================");

  } catch (err) {
    console.error("Error during database import operation:", err);
  } finally {
    await mongoose.connection.close();
    console.log("Database connection closed.");
  }
}

importData();
