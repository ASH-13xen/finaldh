import User from '../models/User.js';
import Course from '../models/Course.js';
import { escapeRegExp } from './sanitize.js';

// The one place that turns a paid purchase into access. Used by Razorpay payments (paymentController.js)
// and by admin approval of legacy UPI requests (purchaseController.js / mcqPurchaseController.js).
//
// Every write is a single atomic update with "only if not already there" semantics, so running a grant
// twice - the browser's verify call and the webhook arriving together - leaves exactly one entry each,
// and never trips a VersionError the way two concurrent user.save() calls would.

// Course access: purchasedCourses is the source of truth (see utils/courseAccess.js); interestedCourses
// keeps the enrollment label; downloadLimits starts at 1 allowed download per PDF part (courseId_index
// keys when a course has several PDFs), matching what admin approval has always set up.
async function grantCoursesToUsers(userFilter, courses) {
  if (!courses || courses.length === 0) return;

  await User.updateMany(userFilter, {
    $addToSet: {
      purchasedCourses: { $each: courses.map((c) => c._id) },
      interestedCourses: { $each: courses.map((c) => c.courseId) }
    }
  });

  for (const course of courses) {
    const fileCount = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls.length : 1;
    for (let i = 0; i < fileCount; i++) {
      const compositeCourseId = fileCount > 1 ? `${course.courseId}_${i}` : course.courseId;
      // Existing limits are matched case-insensitively, as the download check does
      await User.updateMany(
        { ...userFilter, 'downloadLimits.courseId': { $not: new RegExp(`^${escapeRegExp(compositeCourseId)}$`, 'i') } },
        { $push: { downloadLimits: { courseId: compositeCourseId, downloadedCount: 0, allowedCount: 1 } } }
      );
    }
  }
}

const accessGroupOf = (course) => String(course?.accessGroup || '').trim();

// The given courses plus every course that shares a Shared access ID (Course.accessGroup) with one of them.
export async function withAccessGroups(courses) {
  const list = courses || [];
  const groups = [...new Set(list.map(accessGroupOf).filter(Boolean).map((g) => g.toLowerCase()))];
  if (groups.length === 0) return list;

  const siblings = await Course.find({ accessGroup: { $in: groups.map((g) => new RegExp(`^${escapeRegExp(g)}$`, 'i')) } });
  const byId = new Map([...list, ...siblings].map((c) => [String(c._id), c]));
  return [...byId.values()];
}

// Grants the purchased courses - and every course linked to them by a Shared access ID - to one student.
export async function grantCourseAccess(userId, courses) {
  await grantCoursesToUsers({ _id: userId }, await withAccessGroups(courses));
}

// Run when an admin gives a course a Shared access ID (or changes it): everyone who already owns any course
// in that group gets the whole group, including courses linked to it after they bought. Returns how many
// students gained access to something.
export async function syncAccessGroup(course) {
  const group = await withAccessGroups([course]);
  if (group.length < 2) return 0;

  const ids = group.map((c) => c._id);
  const missingSomething = { $and: [{ purchasedCourses: { $in: ids } }, { purchasedCourses: { $not: { $all: ids } } }] };
  const gaining = await User.countDocuments(missingSomething);
  if (gaining > 0) await grantCoursesToUsers({ purchasedCourses: { $in: ids } }, group);
  return gaining;
}

// Owning a subject unlocks every MCQ test in it, present and future (see McqSubjectPricing).
export async function grantMcqSubjectAccess(userId, subject) {
  await User.updateOne({ _id: userId }, { $addToSet: { purchasedMcqSubjects: subject } });
}

// Legacy single-test MCQ purchases (only reachable through old pending UPI requests).
export async function grantMcqTestAccess(userId, mcqTestObjectId) {
  await User.updateOne({ _id: userId }, { $addToSet: { purchasedMcqTests: mcqTestObjectId } });
}
