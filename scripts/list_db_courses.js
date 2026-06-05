import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import Course from '../models/Course.js';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGODB_URI found");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const courses = await Course.find({});
  console.log("Courses in DB:", JSON.stringify(courses, null, 2));
  await mongoose.connection.close();
}
run();
