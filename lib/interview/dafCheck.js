// DAF verification: a student uploads their DAF, an admin verifies it, and only then can the student practise,
// use the free AI uses or buy AI credits. Admins are never gated.
import InterviewProfile from '../../models/InterviewProfile.js';
import DafSubmission from '../../models/DafSubmission.js';
import { isProfileEmpty } from './daf.js';

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

// One DAF upload per account, and one more each time an admin rejects it. Students who uploaded before the
// counter existed count as having used their one.
export const uploadsOf = (profile) => {
  const c = profile?.dafCheck || {};
  const used = profile?.dafUploads?.used ?? (c.submittedAt ? 1 : 0);
  const allowed = profile?.dafUploads?.allowed ?? (1 + (c.status === 'rejected' ? 1 : 0));
  return { used, allowed, left: Math.max(0, allowed - used) };
};
// Changing the DAF after it was verified: Rs 50 for one re-upload, which is verified again.
export const DAF_CHANGE_PRICE = 50;
const changeOf = (profile) => profile?.dafChange?.status || 'none';

// Uploading is possible before a DAF is sent (or after it was rejected), or - once verified - with a paid
// change, while an upload is left and no change is waiting.
export const canUploadDaf = (profile) => {
  const status = dafCheckOf(profile).status;
  const left = uploadsOf(profile).left > 0;
  if (status === 'none' || status === 'rejected') return left;
  if (status === 'verified') return left && changeOf(profile) !== 'pending';
  return false;
};

// The roll number: whether an admin has checked one, and a verified student's request to add one (free,
// with proof) when they have none.
export const rollOf = (profile, status) => {
  const checked = !!(profile?.rollCheckedAt && profile?.rollNo);
  const claim = profile?.rollClaim?.status || 'none';
  return {
    checked,
    claim: { status: claim, reason: profile?.rollClaim?.reason || '', submittedAt: profile?.rollClaim?.submittedAt || null },
    canRequest: status === 'verified' && !checked && claim !== 'pending'
  };
};

// The student's uploaded DAF (sent or verified) that can fill in their details: read before (kept with the
// upload) or with its file still stored. Not a filled-in form or a change.
export const readableDaf = (userId) => DafSubmission.findOne({
  user: userId,
  kind: { $nin: ['change', 'roll'] },
  source: { $ne: 'form' },
  status: { $in: ['pending', 'verified'] },
  $or: [{ size: { $gt: 0 } }, { fields: { $type: 'object' } }]
}).sort({ createdAt: -1 }).select('status fields unsure aiReads size').lean();

export const getDafCheck = async (userId) => {
  const p = await InterviewProfile.findOne({ user: userId }).select('dafCheck dafUploads dafChange rollNo rollCheckedAt rollClaim homeState homeDistrict education work optional hobbies achievements').lean();
  const check = dafCheckOf(p);
  const canUpload = canUploadDaf(p);
  // No details yet (say the file couldn't be read when it was sent), but the upload can fill them in.
  const detailsFromFile = ['pending', 'verified'].includes(check.status) && isProfileEmpty(p || {}) && !!(await readableDaf(userId));
  return {
    detailsFromFile,
    ...check,
    canUpload,
    change: { status: changeOf(p), reason: p?.dafChange?.reason || '', submittedAt: p?.dafChange?.submittedAt || null },
    // A verified student with no upload left pays for a change before re-uploading.
    changeNeedsPayment: check.status === 'verified' && !canUpload && changeOf(p) !== 'pending',
    changePrice: DAF_CHANGE_PRICE,
    roll: rollOf(p, check.status)
  };
};

// Uses one upload, atomically; false when none is left.
export const takeDafUpload = async (userId) => {
  const p = await InterviewProfile.findOne({ user: userId }).select('dafCheck dafUploads').lean();
  const { used, allowed, left } = uploadsOf(p);
  if (left < 1) return false;
  const filter = p?.dafUploads?.used != null ? { user: userId, 'dafUploads.used': used } : { user: userId, 'dafUploads.used': { $exists: false } };
  const r = await InterviewProfile.updateOne(filter, { $set: { 'dafUploads.used': used + 1, 'dafUploads.allowed': allowed }, $setOnInsert: { user: userId } }, { upsert: !p });
  return (r.modifiedCount || 0) + (r.upsertedCount || 0) === 1;
};

// A rejected DAF may be uploaded once more.
export const grantDafUpload = async (userId) => {
  const p = await InterviewProfile.findOne({ user: userId }).select('dafCheck dafUploads').lean();
  const { used, allowed } = uploadsOf(p);
  await InterviewProfile.updateOne({ user: userId }, { $set: { 'dafUploads.used': used, 'dafUploads.allowed': allowed + 1 } });
};

export const isDafVerified = async (userId) => (await getDafCheck(userId)).status === 'verified';

export const setDafCheck = (userId, patch) => InterviewProfile.updateOne(
  { user: userId },
  { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`dafCheck.${k}`, v])), $setOnInsert: { user: userId } },
  { upsert: true }
);

// What a student sees when an action needs a verified DAF.
export const dafGateMessage = (status) => ({
  none: 'Upload your DAF first. Our team verifies it, and then practice unlocks.',
  pending: 'Your DAF is waiting to be verified by our team. Practice unlocks as soon as it is approved.',
  rejected: 'We could not verify your DAF. Please upload it again from My DAF.'
}[status] || 'Your DAF needs to be verified first.');
