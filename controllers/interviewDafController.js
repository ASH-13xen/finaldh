// DAF verification. Students upload their DAF (POST /daf/submit); admins open it, then verify or reject it
// (Admin -> DAF Checks). Until it is verified the student can't practise, use the free AI uses or buy credits.
// The file is kept only while it waits for review.
import mongoose from 'mongoose';
import DafSubmission from '../models/DafSubmission.js';
import User from '../models/User.js';
import { getDafCheck, setDafCheck, dafCheckOf } from '../lib/interview/dafCheck.js';
import InterviewProfile from '../models/InterviewProfile.js';

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const SUBMITS_PER_DAY = 6;

// ------------------------------------------------------------------ students

export const getDafStatus = async (req, res) => {
  try {
    res.json({ daf: await getDafCheck(req.userId) });
  } catch (err) {
    console.error('[interview] getDafStatus error:', err);
    fail(res, 500, 'Could not load your DAF status.');
  }
};

// POST /daf/submit (multipart "file"): stores the DAF for an admin to verify. A verified student uploading
// again is just refreshing their details - their verification stays.
export const submitDaf = async (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose your DAF file (PDF or a photo).');
  try {
    const current = await getDafCheck(req.userId);
    if (current.status === 'verified') return res.json({ daf: current, stored: false });
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    if (await DafSubmission.countDocuments({ user: req.userId, createdAt: { $gte: since } }) >= SUBMITS_PER_DAY) {
      return fail(res, 429, 'You have uploaded your DAF several times today. Please try again tomorrow.', { limited: true });
    }
    const user = await User.findById(req.userId).select('email name fullName').lean();
    // One waiting upload per student: a new one replaces the old.
    await DafSubmission.deleteMany({ user: req.userId, status: 'pending' });
    const sub = await DafSubmission.create({
      user: req.userId,
      userEmail: user?.email || '',
      userName: user?.fullName || user?.name || '',
      fileName: String(req.file.originalname || 'daf').slice(0, 160),
      mimeType: req.file.mimetype,
      size: req.file.size,
      file: req.file.buffer
    });
    await setDafCheck(req.userId, { status: 'pending', submissionId: sub._id, submittedAt: new Date(), reviewedAt: null, reason: '' });
    res.json({ daf: await getDafCheck(req.userId), stored: true });
  } catch (err) {
    console.error('[interview] submitDaf error:', err);
    fail(res, 500, 'Could not upload your DAF. Please try again.');
  }
};

// ------------------------------------------------------------------ admins

const summary = (s) => ({
  id: String(s._id),
  user: String(s.user),
  userEmail: s.userEmail,
  userName: s.userName,
  status: s.status,
  fileName: s.fileName,
  mimeType: s.mimeType,
  size: s.size,
  hasFile: !!s.hasFile,
  reason: s.reason,
  reviewedBy: s.reviewedBy,
  reviewedAt: s.reviewedAt,
  createdAt: s.createdAt
});

export const adminListDaf = async (req, res) => {
  try {
    const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [items, counts] = await Promise.all([
      DafSubmission.aggregate([
        { $match: { status } },
        { $sort: { createdAt: status === 'pending' ? 1 : -1 } },
        { $limit: 300 },
        { $project: { hasFile: { $gt: [{ $ifNull: ['$size', 0] }, 0] }, user: 1, userEmail: 1, userName: 1, status: 1, fileName: 1, mimeType: 1, size: 1, reason: 1, reviewedBy: 1, reviewedAt: 1, createdAt: 1 } }
      ]),
      DafSubmission.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);
    res.json({ items: items.map(summary), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
  } catch (err) {
    console.error('[interview] adminListDaf error:', err);
    fail(res, 500, 'Could not load the DAF uploads.');
  }
};

// The uploaded file itself, for the admin to look at (only while it hasn't been reviewed).
export const adminGetDafFile = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Not found.');
  try {
    const s = await DafSubmission.findById(req.params.id).select('+file mimeType fileName').lean();
    if (!s?.file) return fail(res, 404, 'This file has been removed after review.');
    const buf = Buffer.isBuffer(s.file) ? s.file : Buffer.from(s.file.buffer || s.file);
    res.setHeader('Content-Type', s.mimeType || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(s.fileName || 'daf')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    console.error('[interview] adminGetDafFile error:', err);
    fail(res, 500, 'Could not open the file.');
  }
};

const decide = (status) => async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Not found.');
  try {
    const reason = status === 'rejected' ? String(req.body?.reason || '').trim().slice(0, 300) : '';
    if (status === 'rejected' && !reason) return fail(res, 400, 'Say why, so the student knows what to fix.');
    const s = await DafSubmission.findById(req.params.id);
    if (!s) return fail(res, 404, 'Not found.');
    if (s.status !== 'pending') return fail(res, 409, `This upload was already ${s.status}.`);
    const now = new Date();
    // The file is not kept once it has been reviewed.
    await DafSubmission.updateOne({ _id: s._id }, { $set: { status, reason, reviewedBy: req.adminUser?.email || '', reviewedAt: now, size: 0 }, $unset: { file: 1 } });
    await setDafCheck(s.user, { status, reason, reviewedAt: now });
    res.json({ ok: true, daf: dafCheckOf((await InterviewProfile.findOne({ user: s.user }).select('dafCheck').lean())) });
  } catch (err) {
    console.error('[interview] DAF review error:', err);
    fail(res, 500, 'Could not save that.');
  }
};

export const adminVerifyDaf = decide('verified');
export const adminRejectDaf = decide('rejected');
