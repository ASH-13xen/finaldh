import { isAdminEmail } from '../middlewares/adminMiddleware.js';

// The ONLY place that decides whether a user may read/download a course.
//
// Access comes from User.purchasedCourses (ObjectIds), which is written exclusively by admin-approved
// purchases and by the admin user editor. It used to be decided by User.interestedCourses, but the
// self-service profile endpoint could write that list, so any student could grant themselves any
// course. Set LEGACY_INTERESTED_ACCESS=true only as a temporary bridge while migrating old accounts
// (see scripts/report_course_access.mjs) - the self-service write path stays closed either way.
export function userHasCourseAccess(user, course) {
  if (!user || !course) return false;
  if (isAdminEmail(user.email)) return true;

  const owned = (user.purchasedCourses || []).some((id) => String(id) === String(course._id));
  if (owned) return true;

  if (process.env.LEGACY_INTERESTED_ACCESS === 'true') {
    const interested = Array.isArray(user.interestedCourses) ? user.interestedCourses : [];
    return interested.some((cid) => String(cid).toLowerCase() === String(course.courseId).toLowerCase());
  }
  return false;
}
