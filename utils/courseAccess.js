import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import Course from '../models/Course.js';

// The ONLY place that decides whether a user owns / may read / may download a course.
//
// Access comes from User.purchasedCourses (ObjectIds), which is written exclusively by admin-approved
// purchases and by the admin user editor. It used to be decided by User.interestedCourses, but the
// self-service profile endpoint could write that list, so any student could grant themselves any
// course. Set LEGACY_INTERESTED_ACCESS=true only as a temporary bridge while migrating old accounts
// (see scripts/report_course_access.mjs) - the self-service write path stays closed either way.

const sameCourseId = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Does this account own the course? This is what the student is SHOWN as theirs (see ownedCourseIds).
export function userOwnsCourse(user, course) {
  if (!user || !course) return false;

  const owned = (user.purchasedCourses || []).some((id) => String(id) === String(course._id));
  if (owned) return true;

  if (process.env.LEGACY_INTERESTED_ACCESS === 'true') {
    const interested = Array.isArray(user.interestedCourses) ? user.interestedCourses : [];
    return interested.some((cid) => sameCourseId(cid, course.courseId));
  }
  return false;
}

export function userHasCourseAccess(user, course) {
  if (!user || !course) return false;
  if (isAdminEmail(user.email)) return true;
  return userOwnsCourse(user, course);
}

// courseIds of the courses this account owns. Every user payload sent to the frontend carries this, and
// the dashboard / purchase pages list courses from it - NOT from interestedCourses. Because it is built
// from the same rule as the download check, a student can never be shown a course that then answers
// "Access denied: You have not purchased this course" (which is what happened when a bulk grant only
// wrote interestedCourses).
export function ownedCourseIds(user, courses) {
  return (courses || []).filter((c) => userOwnsCourse(user, c)).map((c) => c.courseId);
}

export async function ownedCourseIdsFor(user) {
  const courses = await Course.find({}).select('_id courseId');
  return ownedCourseIds(user, courses);
}

// Courses named by a list of interestedCourses entries. Matched case-insensitively, like everywhere
// else those entries are compared, so "Essay" and "ESSAY" both mean the ESSAY course.
export function coursesMatchingTags(tags, courses) {
  const wanted = (tags || []).map((t) => String(t).trim().toLowerCase());
  return (courses || []).filter((c) => wanted.includes(String(c.courseId).trim().toLowerCase()));
}
