import 'dotenv/config';
import mongoose from 'mongoose';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import Course from '../models/Course.js';

await mongoose.connect(process.env.MONGODB_URI);

const course = await Course.findOne({ courseId: 'MMF' });
const key = course.sampleFileUrl.replace('r2://', '');
console.log('Downloading sample from R2:', key);

const obj = await r2Client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
const chunks = [];
for await (const chunk of obj.Body) chunks.push(chunk);
const buffer = Buffer.concat(chunks);
console.log('Downloaded bytes:', buffer.length);

const parser = new PDFParse({ data: buffer });
const info = await parser.getInfo();
await parser.destroy();
console.log('Real page count:', info.total);

course.samplePageCount = info.total;
await course.save();
console.log('Updated samplePageCount in DB to', info.total);

await mongoose.disconnect();
