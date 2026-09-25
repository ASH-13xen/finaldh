// Audit of course access after the move from User.interestedCourses -> User.purchasedCourses.
//
//   node scripts/report_course_access.mjs                  read-only report (default)
//   node scripts/report_course_access.mjs --apply-verified add purchasedCourses ONLY where an admin-approved
//                                                          PurchaseRequest proves the student bought the course
//   node scripts/report_course_access.mjs --apply-all      trust interestedCourses and backfill everything
//                                                          (only do this after reviewing the report)
//
// Why: access used to be decided by interestedCourses, which students could write themselves, so that list
// can no longer be trusted. Access is now decided by purchasedCourses (set by admin-approved purchases and
// the admin user editor). Accounts that only have the old entry lose access until they are backfilled here,
// or until you set LEGACY_INTERESTED_ACCESS=true as a temporary bridge.
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Course from '../models/Course.js';
import PurchaseRequest from '../models/PurchaseRequest.js';
import { openPeopleDb, closePeopleDb } from '../config/peopleDb.js';

const applyVerified = process.argv.includes('--apply-verified');
const applyAll = process.argv.includes('--apply-all');

await mongoose.connect(process.env.MONGODB_URI);
await openPeopleDb(); // users and purchase requests live in the people cluster

const courses = await Course.find({}).select('_id courseId name');
const byCourseId = new Map(courses.map((c) => [c.courseId.toLowerCase(), c]));

const approved = await PurchaseRequest.find({ status: 'approved' }).select('userId courseObjectId courses');
const approvedPairs = new Set();
for (const r of approved) {
  const ids = r.courses && r.courses.length ? r.courses : [r.courseObjectId];
  for (const cid of ids) approvedPairs.add(`${r.userId}:${cid}`);
}

const users = await User.find({ 'interestedCourses.0': { $exists: true } });
let verified = 0;
let unverified = 0;
let unknownCourse = 0;
const rows = [];

for (const u of users) {
  const owned = new Set((u.purchasedCourses || []).map(String));
  const toAdd = [];
  for (const cid of u.interestedCourses) {
    const course = byCourseId.get(String(cid).toLowerCase());
    if (!course) { unknownCourse++; continue; }
    if (owned.has(String(course._id))) continue;
    const isVerified = approvedPairs.has(`${u._id}:${course._id}`);
    if (isVerified) verified++; else unverified++;
    toAdd.push({ course, isVerified });
    rows.push(`${u.email.padEnd(38)} ${course.courseId.padEnd(28)} ${isVerified ? 'approved purchase on record' : 'NO purchase record (admin-granted or self-granted?)'}`);
  }
  const chosen = toAdd.filter((x) => applyAll || (applyVerified && x.isVerified));
  if (chosen.length) {
    u.purchasedCourses.push(...chosen.map((x) => x.course._id));
    await u.save();
  }
}

console.log(rows.length ? rows.join('\n') : 'No accounts are missing purchasedCourses entries.');
console.log('\n--- summary ---');
console.log(`users with interestedCourses:                 ${users.length}`);
console.log(`missing purchasedCourses, purchase verified:   ${verified}`);
console.log(`missing purchasedCourses, NO purchase record:  ${unverified}`);
console.log(`interestedCourses entries with no such course: ${unknownCourse}`);
console.log(applyAll ? 'Applied: backfilled everything.' : applyVerified ? 'Applied: backfilled verified purchases only.' : 'Read-only run: nothing was changed.');
await mongoose.disconnect();
await closePeopleDb();
