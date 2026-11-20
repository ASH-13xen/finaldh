// DAF verification: a student uploads their DAF, an admin verifies it, and only then can the student practise,
// use the free AI uses or buy AI credits. Admins are never gated.
import InterviewProfile from '../../models/InterviewProfile.js';

export const DAF_STATUSES = ['none', 'pending', 'verified', 'rejected'];

export const dafCheckOf = (profile) => {
  const c = profile?.dafCheck || {};
  return {
    status: DAF_STATUSES.includes(c.status) ? c.status : 'none',
    reason: c.reason || '',
    submittedAt: c.submittedAt || null,
    reviewedAt: c.reviewedAt || null
  };
};

export const getDafCheck = async (userId) => dafCheckOf(await InterviewProfile.findOne({ user: userId }).select('dafCheck').lean());

export const isDafVerified = async (userId) => (await getDafCheck(userId)).status === 'verified';

export const setDafCheck = (userId, patch) => InterviewProfile.updateOne(
  { user: userId },
  { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`dafCheck.${k}`, v])), $setOnInsert: { user: userId } },
  { upsert: true }
);

// What a student sees when an action needs a verified DAF.
export const dafGateMessage = (status) => ({
  none: 'Upload your DAF first. Our team verifies it, and then practice and your free credits unlock.',
  pending: 'Your DAF is waiting to be verified by our team. Practice and your credits unlock as soon as it is approved.',
  rejected: 'We could not verify your DAF. Please upload it again from My DAF.'
}[status] || 'Your DAF needs to be verified first.');
