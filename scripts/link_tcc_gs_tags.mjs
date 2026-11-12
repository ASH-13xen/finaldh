// Give students labelled with an old course alias (GS1..GS4 from the TCC spreadsheet imports) the course the
// label stands for, and replace the old label with the course's real ID. See COURSE_TAG_ALIASES in
// utils/courseAccess.js for the mapping.
//
//   node scripts/link_tcc_gs_tags.mjs                       dry run: what would change, writes nothing
//   node scripts/link_tcc_gs_tags.mjs --apply               back up, grant the courses, replace the labels
//   node scripts/link_tcc_gs_tags.mjs --undo <backup.json>  put interestedCourses / purchasedCourses /
//                                                           downloadLimits back exactly as backed up
//
// Granting works like a verified purchase: the course is added to purchasedCourses and one download per PDF
// part is set up (existing limits are kept). Students who already own the course keep what they have.
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Course from '../models/Course.js';
import { openPeopleDb, closePeopleDb } from '../config/peopleDb.js';
import { COURSE_TAG_ALIASES, canonicalCourseTag } from '../utils/courseAccess.js';
import { grantCourseAccessToUsers } from '../utils/purchaseFulfillment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');
const undoIdx = process.argv.indexOf('--undo');
const undoFile = undoIdx !== -1 ? process.argv[undoIdx + 1] : null;

await mongoose.connect(process.env.MONGODB_URI);
await openPeopleDb(); // users live in the people cluster

try {
  if (undoFile) {
    const saved = JSON.parse(await fs.readFile(undoFile, 'utf8'));
    const ops = saved.map((u) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(u._id) },
        update: { $set: { interestedCourses: u.interestedCourses, purchasedCourses: u.purchasedCourses, downloadLimits: u.downloadLimits } }
      }
    }));
    const result = ops.length ? await User.bulkWrite(ops) : { modifiedCount: 0 };
    console.log(`Restored ${result.modifiedCount} of ${saved.length} students from ${undoFile}`);
  } else {
    // The alias targets must exist, or the labels would be replaced with an ID no course has
    const courses = await Course.find({});
    const courseById = new Map(courses.map((c) => [c.courseId.trim().toLowerCase(), c]));
    for (const target of new Set(Object.values(COURSE_TAG_ALIASES))) {
      if (!courseById.has(target.toLowerCase())) throw new Error(`No course has the courseId "${target}" - aborting, nothing changed`);
    }

    // Students carrying at least one old alias label
    const candidates = await User.find({ 'interestedCourses.0': { $exists: true } })
      .select('_id email interestedCourses purchasedCourses downloadLimits');
    const affected = [];
    const grantedTo = new Map(); // student id -> Set of course _ids this run grants them
    const plan = new Map(); // courseId -> { course, oldLabels:Set, students:Map(id -> ownsAlready) }
    for (const u of candidates) {
      const aliasLabels = u.interestedCourses.filter((t) => canonicalCourseTag(t) !== String(t).trim());
      if (aliasLabels.length === 0) continue;
      affected.push(u);
      for (const label of aliasLabels) {
        const course = courseById.get(canonicalCourseTag(label).toLowerCase());
        if (!plan.has(course.courseId)) plan.set(course.courseId, { course, oldLabels: new Set(), students: new Map() });
        const entry = plan.get(course.courseId);
        entry.oldLabels.add(label);
        entry.students.set(String(u._id), u.purchasedCourses.some((id) => String(id) === String(course._id)));
        if (!grantedTo.has(String(u._id))) grantedTo.set(String(u._id), new Set());
        grantedTo.get(String(u._id)).add(String(course._id));
      }
    }

    console.log(`${apply ? 'APPLYING' : 'DRY RUN (nothing is written)'} - ${affected.length} students carry an old label\n`);
    for (const [courseId, e] of plan) {
      const parts = e.course.fileUrls?.length || 1;
      const alreadyOwn = [...e.students.values()].filter(Boolean).length;
      console.log(`  ${[...e.oldLabels].map((l) => JSON.stringify(l)).join(', ').padEnd(16)} -> "${courseId}" (${parts} PDF part${parts === 1 ? '' : 's'}): ` +
        `${e.students.size} students, ${alreadyOwn} already own it, ${e.students.size - alreadyOwn} gain access`);
    }

    if (apply && affected.length > 0) {
      const backupPath = path.join(__dirname, '../migration-backups', `tcc-gs-tag-link-${Date.now()}.json`);
      await fs.writeFile(backupPath, JSON.stringify(affected.map((u) => ({
        _id: String(u._id),
        email: u.email,
        interestedCourses: u.interestedCourses,
        purchasedCourses: u.purchasedCourses.map(String),
        downloadLimits: u.downloadLimits.map((d) => ({ courseId: d.courseId, downloadedCount: d.downloadedCount, allowedCount: d.allowedCount }))
      })), null, 2));
      console.log(`\nBackup written: ${backupPath}`);

      for (const [courseId, e] of plan) {
        // Grant first (adds the real courseId label as well), then drop the old label. Each step is
        // idempotent, so re-running after an interruption finishes the job without doubling anything.
        const ids = [...e.students.keys()].map((id) => new mongoose.Types.ObjectId(id));
        await grantCourseAccessToUsers(ids, [e.course]);
        await User.updateMany({ _id: { $in: ids } }, { $pull: { interestedCourses: { $in: [...e.oldLabels] } } });
        console.log(`  done: "${courseId}"`);
      }

      const after = await User.find({ _id: { $in: affected.map((u) => u._id) } }).select('interestedCourses purchasedCourses');
      const failed = after.filter((u) => {
        const owned = new Set(u.purchasedCourses.map(String));
        const stillAliased = u.interestedCourses.some((t) => canonicalCourseTag(t) !== String(t).trim());
        const missing = [...grantedTo.get(String(u._id))].some((cid) => !owned.has(cid));
        return stillAliased || missing;
      });
      console.log(failed.length === 0
        ? `\nCheck passed: no old labels left, and all ${after.length} students own the courses their labels named.`
        : `\nCHECK FAILED for ${failed.length} students - re-run --apply, or restore with --undo ${backupPath}`);
    }
  }
} finally {
  await mongoose.disconnect();
  await closePeopleDb();
}
