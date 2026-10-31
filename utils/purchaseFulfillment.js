import User from '../models/User.js';
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
export async function grantCourseAccess(userId, courses) {
  if (!courses || courses.length === 0) return;

  await User.updateOne(
    { _id: userId },
    {
      $addToSet: {
        purchasedCourses: { $each: courses.map((c) => c._id) },
        interestedCourses: { $each: courses.map((c) => c.courseId) }
      }
    }
  );

  for (const course of courses) {
    const fileCount = course.fileUrls && course.fileUrls.length > 0 ? course.fileUrls.length : 1;
    for (let i = 0; i < fileCount; i++) {
      const compositeCourseId = fileCount > 1 ? `${course.courseId}_${i}` : course.courseId;
      // Existing limits are matched case-insensitively, as the download check does
      await User.updateOne(
        { _id: userId, 'downloadLimits.courseId': { $not: new RegExp(`^${escapeRegExp(compositeCourseId)}$`, 'i') } },
        { $push: { downloadLimits: { courseId: compositeCourseId, downloadedCount: 0, allowedCount: 1 } } }
      );
    }
  }
}

// Owning a subject unlocks every MCQ test in it, present and future (see McqSubjectPricing).
export async function grantMcqSubjectAccess(userId, subject) {
  await User.updateOne({ _id: userId }, { $addToSet: { purchasedMcqSubjects: subject } });
}

// Legacy single-test MCQ purchases (only reachable through old pending UPI requests).
export async function grantMcqTestAccess(userId, mcqTestObjectId) {
  await User.updateOne({ _id: userId }, { $addToSet: { purchasedMcqTests: mcqTestObjectId } });
}
