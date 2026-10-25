// Course ownership rule (utils/courseAccess.js). Pure functions - needs no database.
//
// Regression for the Oct 2026 lock-out: a bulk grant wrote only interestedCourses, so ~300 students were
// SHOWN Prelims Master File on their dashboard while every download answered "Access denied: You have not
// purchased this course". What a student is shown and what they may download must come from one rule.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_EMAIL = 'admin@test.dev';
delete process.env.ADMIN_EMAIL1;
delete process.env.ADMIN_EMAIL2;
delete process.env.LEGACY_INTERESTED_ACCESS;

const { userOwnsCourse, userHasCourseAccess, ownedCourseIds, coursesMatchingTags } = await import('../utils/courseAccess.js');

const PMF = { _id: 'c-pmf', courseId: 'Prelims Master File' };
const ESSAY = { _id: 'c-essay', courseId: 'ESSAY' };
const MMF = { _id: 'c-mmf', courseId: 'MMF' };
const COURSES = [PMF, ESSAY, MMF];

const buyer = { email: 'buyer@test.dev', purchasedCourses: ['c-pmf'], interestedCourses: ['Prelims Master File'] };
const tagOnly = { email: 'tagonly@test.dev', purchasedCourses: [], interestedCourses: ['Prelims Master File', 'Essay', 'GS4'] };
const ownedNoTag = { email: 'notag@test.dev', purchasedCourses: ['c-mmf'], interestedCourses: [] };
const nobody = { email: 'nobody@test.dev' };
const admin = { email: 'Admin@Test.dev', purchasedCourses: [], interestedCourses: [] };

test('a buyer is shown the course and may download it', () => {
  assert.deepEqual(ownedCourseIds(buyer, COURSES), ['Prelims Master File']);
  assert.equal(userHasCourseAccess(buyer, PMF), true);
  assert.equal(userHasCourseAccess(buyer, ESSAY), false);
});

test('an interestedCourses entry alone is neither shown as owned nor downloadable', () => {
  assert.deepEqual(ownedCourseIds(tagOnly, COURSES), []);
  assert.equal(userHasCourseAccess(tagOnly, PMF), false);
});

test('a purchased course is shown even when the interestedCourses entry is missing', () => {
  assert.deepEqual(ownedCourseIds(ownedNoTag, COURSES), ['MMF']);
  assert.equal(userHasCourseAccess(ownedNoTag, MMF), true);
});

test('for every student, "shown as owned" and "may download" always agree', () => {
  const check = () => {
    for (const user of [buyer, tagOnly, ownedNoTag, nobody]) {
      const shown = ownedCourseIds(user, COURSES);
      for (const course of COURSES) {
        assert.equal(shown.includes(course.courseId), userHasCourseAccess(user, course), `${user.email} / ${course.courseId}`);
      }
    }
  };
  check();
  process.env.LEGACY_INTERESTED_ACCESS = 'true';
  try {
    check();
    // the bridge matches entries case-insensitively, and the dashboard list follows it
    assert.deepEqual(ownedCourseIds(tagOnly, COURSES), ['Prelims Master File', 'ESSAY']);
  } finally {
    delete process.env.LEGACY_INTERESTED_ACCESS;
  }
});

test('admins may open any course without it being listed as their purchase', () => {
  assert.equal(userHasCourseAccess(admin, PMF), true);
  assert.equal(userOwnsCourse(admin, PMF), false);
  assert.deepEqual(ownedCourseIds(admin, COURSES), []);
});

test('missing user or course is always refused', () => {
  assert.equal(userHasCourseAccess(null, PMF), false);
  assert.equal(userHasCourseAccess(buyer, null), false);
  assert.deepEqual(ownedCourseIds(null, COURSES), []);
});

test('admin editor entries map to courses case-insensitively and ignore non-course tags', () => {
  assert.deepEqual(coursesMatchingTags(['essay', ' MMF ', 'GS4', 'PYQ Analytics (PYQs Based Test Series)'], COURSES), [ESSAY, MMF]);
  assert.deepEqual(coursesMatchingTags([], COURSES), []);
  assert.deepEqual(coursesMatchingTags(undefined, COURSES), []);
});
