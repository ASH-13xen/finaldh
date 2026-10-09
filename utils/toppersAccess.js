import User from '../models/User.js';
import { ALL_SUBJECTS } from '../models/ToppersCopyPricing.js';

const isAdminEmail = (email) =>
  [process.env.ADMIN_EMAIL, process.env.ADMIN_EMAIL1, process.env.ADMIN_EMAIL2]
    .filter(Boolean)
    .map((e) => e.toLowerCase())
    .includes((email || '').toLowerCase());

// Who can open what in Toppers Copy. Admins and buyers of the subject (or the
// all-subjects bundle) get everything; everyone else can browse every topic and question
// title but only open the questions an admin marked freePreview.
export const getToppersAccess = async (userId) => {
  const user = await User.findById(userId).select('email purchasedToppersSubjects').lean();
  const owned = new Set(user?.purchasedToppersSubjects || []);
  return {
    admin: !!user && isAdminEmail(user.email),
    all: owned.has(ALL_SUBJECTS),
    subjects: owned,
  };
};

export const ownsSubject = (access, subject) => access.admin || access.all || access.subjects.has(subject);

export const canOpenQuestion = (access, subject, question) => !!question.freePreview || ownsSubject(access, subject);
