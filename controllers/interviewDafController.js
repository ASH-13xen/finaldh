// DAF verification. Students upload their DAF (POST /daf/submit); admins open it, then verify or reject it
// (Admin -> DAF Checks). Until it is verified the student can't practise, use the free AI uses or buy credits.
// The file is kept only while it waits for review.
import mongoose from 'mongoose';
import DafSubmission from '../models/DafSubmission.js';
import User from '../models/User.js';
import { getDafCheck, setDafCheck, dafCheckOf, rollOf, readableDaf, takeDafUpload, grantDafUpload, DAF_CHANGE_PRICE } from '../lib/interview/dafCheck.js';
import { findByRoll, normalizeRoll, parseSchedulePdf, replaceSchedule, scheduleInfo } from '../lib/interview/schedule.js';
import InterviewSchedule from '../models/InterviewSchedule.js';
import InterviewProfile from '../models/InterviewProfile.js';
import { isAdminEmail } from '../middlewares/adminMiddleware.js';
import { checkGemini, geminiStatus } from '../lib/interview/gemini.js';
import { extractDaf, isProfileEmpty, cleanProfileInput } from '../lib/interview/daf.js';

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

// Sending a DAF for verification - uploaded or filled in - uses the account's one submission (one more after
// each rejection); nothing while one is waiting. A verified student's is a change: paid for first, verified
// again, and it leaves the current DAF in place until then. Admins (testing) are not limited.
// Returns { user, isChange } or null when it has already answered.
const takeDafSubmission = async (req, res) => {
  const user = await User.findById(req.userId).select('email name fullName').lean();
  const admin = !!user && isAdminEmail(user.email);
  const current = await getDafCheck(req.userId);
  const isChange = current.status === 'verified';
  if (!admin) {
    if (current.status === 'pending') { fail(res, 403, 'Your DAF is waiting to be verified. You can send it again only if our team can’t verify it.', { dafLocked: 'pending', daf: current }); return null; }
    if (isChange && current.change?.status === 'pending') { fail(res, 403, 'Your new DAF is waiting to be verified.', { dafLocked: 'changePending', daf: current }); return null; }
    if (!(await takeDafUpload(req.userId))) {
      if (isChange) fail(res, 402, `Changing your DAF costs ₹${DAF_CHANGE_PRICE}.`, { needPayment: true, price: DAF_CHANGE_PRICE, daf: current });
      else fail(res, 403, 'You have already sent your DAF.', { dafLocked: 'used', daf: current });
      return null;
    }
  } else {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    if (await DafSubmission.countDocuments({ user: req.userId, createdAt: { $gte: since } }) >= SUBMITS_PER_DAY) {
      fail(res, 429, 'You have sent your DAF several times today. Please try again tomorrow.', { limited: true });
      return null;
    }
  }
  // One waiting DAF per student: a new one replaces the old (a waiting roll number request stays).
  await DafSubmission.deleteMany({ user: req.userId, status: 'pending', kind: { $ne: 'roll' } });
  return { user, isChange };
};

const submissionBase = (req, user, isChange) => ({
  kind: isChange ? 'change' : 'first',
  user: req.userId,
  userEmail: user?.email || '',
  userName: user?.fullName || user?.name || ''
});

// POST /daf/submit (multipart "file"): the student's DAF upload. One call stores the file for an admin to
// verify and has AI read it, so the student can check the details (returned as fields) before saving them.
export const submitDaf = async (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose your DAF file (PDF or a photo).');
  try {
    const taken = await takeDafSubmission(req, res);
    if (!taken) return;
    const { user, isChange } = taken;
    const sub = await DafSubmission.create({
      ...submissionBase(req, user, isChange),
      fileName: String(req.file.originalname || 'daf').slice(0, 160),
      mimeType: req.file.mimetype,
      size: req.file.size,
      file: req.file.buffer
    });
    if (isChange) {
      await InterviewProfile.updateOne({ user: req.userId }, { $set: { dafChange: { status: 'pending', submissionId: sub._id, submittedAt: new Date(), reviewedAt: null, reason: '', fields: null, appliedAt: null } } });
    } else {
      await setDafCheck(req.userId, { status: 'pending', submissionId: sub._id, submittedAt: new Date(), reviewedAt: null, reason: '' });
    }
    // AI reads it to fill in the form; if it can't, the student fills it in from the file instead.
    let read = { aiUnavailable: true };
    if (await checkGemini()) {
      try {
        const { fields, unsure } = await extractDaf(req.file.buffer, req.file.mimetype);
        read = { fields, unsure, empty: isProfileEmpty(fields) };
        // Kept with the upload: if the student leaves before saving the details, they can come back to them.
        await DafSubmission.updateOne({ _id: sub._id }, { $set: { fields, unsure, aiReads: 1, ...(fields.rollNo ? { rollNo: fields.rollNo } : {}) } });
      } catch (err) {
        console.warn('[interview] reading an uploaded DAF failed:', String(err?.message || err).slice(0, 200));
        read = { readFailed: true };
      }
    }
    res.json({ daf: await getDafCheck(req.userId), stored: true, change: isChange, ...read });
  } catch (err) {
    console.error('[interview] submitDaf error:', err);
    fail(res, 500, 'Could not upload your DAF. Please try again.');
  }
};

// POST /daf/read: fills in the details of a student who has none yet from the DAF they uploaded - say it
// couldn't be read automatically when they sent it (AI was off). What was read is kept with the upload, so
// coming back to it is free; a file is read by AI at most MAX_AI_READS times.
const MAX_AI_READS = 3;
export const readMyDaf = async (req, res) => {
  try {
    const profile = await InterviewProfile.findOne({ user: req.userId }).lean();
    if (profile && !isProfileEmpty(profile)) return fail(res, 409, 'Your DAF details are already filled in.');
    const sub = await readableDaf(req.userId);
    if (!sub) return fail(res, 404, 'There is no uploaded DAF to read. Please fill in the details by hand.', { noFile: true });
    if (sub.fields && !isProfileEmpty(sub.fields)) return res.json({ fields: sub.fields, unsure: sub.unsure || [], saved: true });
    if (!(sub.size > 0) || (sub.aiReads || 0) >= MAX_AI_READS) return fail(res, 422, 'We couldn’t read your DAF. Please fill in the details by hand.', { readFailed: true });
    if (!(await checkGemini())) return fail(res, 503, 'Reading your DAF automatically isn’t available right now. Please fill in the details by hand, or try again later.', { aiUnavailable: true });
    const full = await DafSubmission.findById(sub._id).select('+file mimeType').lean();
    if (!full?.file) return fail(res, 422, 'We couldn’t read your DAF. Please fill in the details by hand.', { readFailed: true });
    await DafSubmission.updateOne({ _id: sub._id }, { $inc: { aiReads: 1 } });
    try {
      const buf = Buffer.isBuffer(full.file) ? full.file : Buffer.from(full.file.buffer || full.file);
      const { fields, unsure } = await extractDaf(buf, full.mimeType);
      // A waiting upload also gets the roll number read from it, for the admin's check.
      await DafSubmission.updateOne({ _id: sub._id }, { $set: { fields, unsure, ...(fields.rollNo && sub.status === 'pending' ? { rollNo: fields.rollNo } : {}) } });
      res.json({ fields, unsure, empty: isProfileEmpty(fields) });
    } catch (err) {
      if (err?.name === 'GeminiUnavailableError') return fail(res, 503, 'Reading your DAF automatically isn’t available right now. Please fill in the details by hand, or try again later.', { aiUnavailable: true });
      console.warn('[interview] reading a stored DAF failed:', String(err?.message || err).slice(0, 200));
      fail(res, 502, 'We couldn’t read your DAF. Please fill in the details by hand.', { readFailed: true });
    }
  } catch (err) {
    console.error('[interview] readMyDaf error:', err);
    fail(res, 500, 'Could not read your DAF. Please try again.');
  }
};

// POST /daf/form (multipart "fields" = the DAF form as JSON, "rollNo", "file" = proof of the roll number): a
// DAF filled in by hand, sent for verification like an upload. A filled-in DAF has no file, so the roll number
// and its proof (an e-summon letter, admit card or the DAF page showing it) are both required: the admin checks
// them before verifying.
export const submitDafForm = async (req, res) => {
  let fields;
  try { fields = cleanProfileInput(JSON.parse(String(req.body?.fields || '{}'))); } catch { return fail(res, 400, 'Could not read the form. Please try again.'); }
  delete fields.rollNo; // it travels on its own, with its proof
  if (isProfileEmpty(fields)) return fail(res, 400, 'Fill in your DAF first.');
  const typed = String(req.body?.rollNo || '').replace(/\D/g, '');
  const roll = normalizeRoll(typed);
  if (!typed) return fail(res, 400, 'Add your roll number: it’s needed to send a DAF you fill in.', { needRoll: true });
  if (!roll) return fail(res, 400, 'A roll number has 7 digits.', { needRoll: true });
  if (!req.file) return fail(res, 400, 'Attach a proof of your roll number: it’s needed to send a DAF you fill in.', { needProof: true });
  try {
    const taken = await takeDafSubmission(req, res);
    if (!taken) return;
    const { user, isChange } = taken;
    const proof = req.file;
    const sub = await DafSubmission.create({
      ...submissionBase(req, user, isChange),
      source: 'form',
      fields,
      rollNo: roll,
      fileName: proof ? String(proof.originalname || 'proof').slice(0, 160) : '',
      mimeType: proof?.mimetype || '',
      size: proof?.size || 0,
      ...(proof ? { file: proof.buffer } : {})
    });
    const now = new Date();
    if (isChange) {
      // The current DAF stays until the new one is verified; then these details replace it.
      await InterviewProfile.updateOne({ user: req.userId }, { $set: { dafChange: { status: 'pending', submissionId: sub._id, submittedAt: now, reviewedAt: null, reason: '', fields, appliedAt: null } } });
    } else {
      await InterviewProfile.updateOne({ user: req.userId }, { $set: { ...fields, source: 'manual', detailsSavedAt: now }, $setOnInsert: { user: req.userId } }, { upsert: true });
      await setDafCheck(req.userId, { status: 'pending', submissionId: sub._id, submittedAt: now, reviewedAt: null, reason: '' });
    }
    res.json({ daf: await getDafCheck(req.userId), stored: true, change: isChange });
  } catch (err) {
    console.error('[interview] submitDafForm error:', err);
    fail(res, 500, 'Could not send your DAF. Please try again.');
  }
};

// POST /daf/roll (multipart "file" = the proof, "rollNo"): a verified student with no checked roll number asks
// to add one, free. An admin checks the proof (an e-summon letter, admit card or the DAF page showing it) on
// DAF Checks, like a DAF; until then nothing changes for the student.
export const submitRollClaim = async (req, res) => {
  const roll = normalizeRoll(req.body?.rollNo);
  if (!roll) return fail(res, 400, 'A roll number has 7 digits.');
  if (!req.file) return fail(res, 400, 'Attach a proof of your roll number (PDF or a photo).');
  try {
    const user = await User.findById(req.userId).select('email name fullName').lean();
    const p = await InterviewProfile.findOne({ user: req.userId }).select('dafCheck rollNo rollCheckedAt rollClaim').lean();
    const state = rollOf(p, dafCheckOf(p).status);
    if (dafCheckOf(p).status !== 'verified') return fail(res, 403, 'Your DAF needs to be verified first.', { dafLocked: dafCheckOf(p).status });
    if (state.checked) return fail(res, 409, 'Your roll number is already on your verified DAF.');
    if (state.claim.status === 'pending') return fail(res, 409, 'Your roll number is already waiting for verification.');
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    if (await DafSubmission.countDocuments({ user: req.userId, kind: 'roll', createdAt: { $gte: since } }) >= SUBMITS_PER_DAY) {
      return fail(res, 429, 'You have sent your roll number several times today. Please try again tomorrow.', { limited: true });
    }
    const sub = await DafSubmission.create({
      kind: 'roll',
      rollNo: roll,
      user: req.userId,
      userEmail: user?.email || '',
      userName: user?.fullName || user?.name || '',
      fileName: String(req.file.originalname || 'proof').slice(0, 160),
      mimeType: req.file.mimetype,
      size: req.file.size,
      file: req.file.buffer
    });
    await InterviewProfile.updateOne({ user: req.userId }, { $set: { rollClaim: { status: 'pending', submissionId: sub._id, submittedAt: new Date(), reviewedAt: null, reason: '' } } });
    res.json({ daf: await getDafCheck(req.userId) });
  } catch (err) {
    console.error('[interview] submitRollClaim error:', err);
    fail(res, 500, 'Could not send your roll number. Please try again.');
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
  createdAt: s.createdAt,
  kind: s.kind || 'first',
  source: s.source || 'file',
  fields: s.source === 'form' ? s.fields || null : null,
  rollNo: s.rollNo || '',
  detailsMissing: !!s.detailsMissing,
  schedule: s.schedule || null
});

export const adminListDaf = async (req, res) => {
  try {
    const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [items, counts] = await Promise.all([
      DafSubmission.aggregate([
        { $match: { status } },
        { $sort: { createdAt: status === 'pending' ? 1 : -1 } },
        { $limit: 300 },
        { $project: { hasFile: { $gt: [{ $ifNull: ['$size', 0] }, 0] }, user: 1, userEmail: 1, userName: 1, status: 1, fileName: 1, mimeType: 1, size: 1, reason: 1, reviewedBy: 1, reviewedAt: 1, createdAt: 1, kind: 1, rollNo: 1, source: 1, fields: 1 } }
      ]),
      DafSubmission.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);
    // Waiting: the roll number read from the file or typed by the student (a suggestion for the admin to
    // check). Reviewed: the one the admin saved when verifying. Either way checked against UPSC's schedule.
    const profiles = status === 'pending' ? await InterviewProfile.find({ user: { $in: items.map((i) => i.user) } }).select('user rollNo homeState homeDistrict education work optional hobbies achievements').lean() : [];
    const rollOfUser = new Map(profiles.map((p) => [String(p.user), p.rollNo || '']));
    // A waiting student who hasn't filled in their DAF details yet (they can after verification, from My DAF).
    const noDetails = new Set(profiles.filter((p) => isProfileEmpty(p)).map((p) => String(p.user)));
    for (const i of items) {
      const firstUpload = (i.kind || 'first') === 'first' && i.source !== 'form';
      if (status === 'pending' && firstUpload && (!rollOfUser.has(String(i.user)) || noDetails.has(String(i.user)))) i.detailsMissing = true;
    }
    for (const i of items) i.rollNo = normalizeRoll(i.rollNo || rollOfUser.get(String(i.user)) || '');
    const rolls = [...new Set(items.map((i) => i.rollNo).filter(Boolean))];
    const rows = rolls.length ? await InterviewSchedule.find({ roll: { $in: rolls } }).lean() : [];
    const byRoll = new Map(rows.map((r) => [r.roll, r]));
    const loaded = (await InterviewSchedule.estimatedDocumentCount()) > 0;
    for (const i of items) {
      const r = i.rollNo ? byRoll.get(i.rollNo) : null;
      i.schedule = r
        ? { found: true, name: r.name, date: r.date, day: r.day, session: r.session, reportingTime: r.reportingTime }
        : { found: false, loaded, noRoll: !i.rollNo };
    }
    // Whether uploads are being read automatically right now (and Google's reason when not).
    const aiOn = await checkGemini();
    const ai = geminiStatus();
    res.json({ items: items.map(summary), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), schedule: await scheduleInfo(), ai: { available: aiOn, configured: ai.configured, billingBlocked: ai.billingBlocked, reason: aiOn ? '' : ai.lastError } });
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
    if (!s?.file) return fail(res, 404, 'No file was kept for this entry (reviewed before files were kept).');
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
    // Verifying saves the roll number the admin checked against the DAF ('' = verify without one). It is the
    // only way a verified student gets a roll number, so it is required (an old admin page sends none).
    let roll = '';
    if (status === 'verified') {
      if (req.body?.rollNo === undefined) return fail(res, 400, 'Reload this page: verifying now needs the roll number from the DAF.');
      const raw = String(req.body.rollNo || '').replace(/\D/g, '');
      roll = normalizeRoll(raw);
      if (raw && !roll) return fail(res, 400, 'A roll number has 7 digits.');
    }
    const s = await DafSubmission.findById(req.params.id);
    if (!s) return fail(res, 404, 'Not found.');
    if (s.status !== 'pending') return fail(res, 409, `This upload was already ${s.status}.`);
    if (s.kind === 'roll' && status === 'verified' && !roll) return fail(res, 400, 'Enter the roll number to approve it.');
    const now = new Date();
    const checkedRoll = { rollNo: roll, rollCheckedAt: roll ? now : null };
    // The file stays, so admins can look at it again later (or delete the entry).
    await DafSubmission.updateOne({ _id: s._id }, { $set: { status, reason, reviewedBy: req.adminUser?.email || '', reviewedAt: now, ...(status === 'verified' ? { rollNo: roll } : {}) } });
    if (s.kind === 'change') {
      // A change: verified -> the new details replace the current ones (if the student has saved them;
      // otherwise when they do). Rejected -> the current DAF stays and they may upload once more.
      const p = await InterviewProfile.findOne({ user: s.user }).select('dafChange').lean();
      const fields = p?.dafChange?.fields;
      const $set = { 'dafChange.status': status, 'dafChange.reason': reason, 'dafChange.reviewedAt': now };
      if (status === 'verified' && fields) Object.assign($set, fields, { 'dafChange.appliedAt': now, 'dafChange.fields': null, detailsSavedAt: now });
      if (status === 'verified') Object.assign($set, checkedRoll);
      await InterviewProfile.updateOne({ user: s.user }, { $set });
    } else if (s.kind === 'roll') {
      // A roll number request: approved -> the roll number the admin checked becomes theirs. Rejected -> the
      // student may ask again (it's free).
      const $set = { 'rollClaim.status': status, 'rollClaim.reason': reason, 'rollClaim.reviewedAt': now };
      if (status === 'verified') Object.assign($set, checkedRoll);
      await InterviewProfile.updateOne({ user: s.user }, { $set });
    } else {
      await setDafCheck(s.user, { status, reason, reviewedAt: now });
      if (status === 'verified') await InterviewProfile.updateOne({ user: s.user }, { $set: checkedRoll });
    }
    // A rejected DAF may be uploaded once more.
    if (status === 'rejected' && s.kind !== 'roll') await grantDafUpload(s.user);
    res.json({ ok: true, daf: dafCheckOf((await InterviewProfile.findOne({ user: s.user }).select('dafCheck').lean())) });
  } catch (err) {
    console.error('[interview] DAF review error:', err);
    fail(res, 500, 'Could not save that.');
  }
};

export const adminVerifyDaf = decide('verified');

// DELETE /admin/daf/:id: removes an entry and its file. A waiting one is undone as if it was never sent (the
// student can send it again); a reviewed one leaves the student's verification as it is.
export const adminDeleteDaf = async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 404, 'Not found.');
  try {
    const s = await DafSubmission.findById(req.params.id).select('user status kind').lean();
    if (!s) return fail(res, 404, 'Not found.');
    if (s.status === 'pending') {
      const p = await InterviewProfile.findOne({ user: s.user }).select('dafCheck dafChange rollClaim').lean();
      const mine = (ref) => ref && String(ref) === String(s._id);
      if (s.kind === 'roll') {
        if (mine(p?.rollClaim?.submissionId)) await InterviewProfile.updateOne({ user: s.user }, { $set: { 'rollClaim.status': 'none', 'rollClaim.submissionId': null } });
      } else if (s.kind === 'change') {
        if (mine(p?.dafChange?.submissionId)) {
          await InterviewProfile.updateOne({ user: s.user }, { $set: { 'dafChange.status': 'none', 'dafChange.submissionId': null, 'dafChange.fields': null } });
          await grantDafUpload(s.user); // they paid for it: the change can be sent again
        }
      } else if (mine(p?.dafCheck?.submissionId) && p?.dafCheck?.status === 'pending') {
        await setDafCheck(s.user, { status: 'none', submissionId: null, submittedAt: null, reviewedAt: null, reason: '' });
        await grantDafUpload(s.user);
      }
    }
    await DafSubmission.deleteOne({ _id: s._id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview] adminDeleteDaf error:', err);
    fail(res, 500, 'Could not delete that entry.');
  }
};

// ------------------------------------------------------------------ admins: UPSC's interview schedule

export const adminGetSchedule = async (req, res) => {
  try {
    res.json({ schedule: await scheduleInfo() });
  } catch (err) {
    console.error('[interview] adminGetSchedule error:', err);
    fail(res, 500, 'Could not load the schedule.');
  }
};

// POST /admin/schedule (multipart "file": the PDF UPSC publishes): replaces the stored schedule.
export const adminUploadSchedule = async (req, res) => {
  if (!req.file) return fail(res, 400, 'Choose the schedule PDF.');
  if (req.file.mimetype !== 'application/pdf') return fail(res, 400, 'The schedule must be the PDF UPSC publishes.');
  try {
    const rows = await parseSchedulePdf(req.file.buffer);
    if (rows.length < 20) return fail(res, 400, 'That doesn’t look like UPSC’s interview schedule: no candidate rows were found.');
    res.json({ schedule: await replaceSchedule(rows, String(req.file.originalname || '').slice(0, 160)), rows: rows.length });
  } catch (err) {
    console.error('[interview] adminUploadSchedule error:', err);
    fail(res, 500, 'Could not read that schedule.');
  }
};

// GET /admin/schedule/roll/:roll: one roll number's row, as an admin types it while checking a DAF.
export const adminScheduleRoll = async (req, res) => {
  try {
    const roll = normalizeRoll(req.params.roll);
    if (!roll) return res.json({ found: false, loaded: true, noRoll: true });
    const [r, count] = await Promise.all([findByRoll(roll), InterviewSchedule.estimatedDocumentCount()]);
    res.json(r
      ? { found: true, roll: r.roll, name: r.name, date: r.date, day: r.day, session: r.session, reportingTime: r.reportingTime }
      : { found: false, loaded: count > 0 });
  } catch (err) {
    console.error('[interview] adminScheduleRoll error:', err);
    fail(res, 500, 'Could not check that roll number.');
  }
};

// GET /my-interview: the student's own row of the schedule, matched by the roll number an admin checked
// against their DAF when verifying it. Never anyone else's.
export const getMyInterview = async (req, res) => {
  try {
    const p = await InterviewProfile.findOne({ user: req.userId }).select('rollNo rollCheckedAt rollClaim dafCheck').lean();
    if (dafCheckOf(p).status !== 'verified') return res.json({ found: false });
    // No checked roll number: the student can add one (free, with proof).
    if (!p?.rollNo || !p?.rollCheckedAt) return res.json({ found: false, noRoll: true, claim: p?.rollClaim?.status || 'none' });
    const r = await findByRoll(p.rollNo);
    if (!r) return res.json({ found: false });
    res.json({
      found: true,
      roll: r.roll,
      name: r.name,
      date: r.date,
      day: r.day,
      session: r.session,
      reportingTime: r.reportingTime,
      reportingAt: new Date(`${r.date}T${r.reportingTime}:00+05:30`).toISOString()
    });
  } catch (err) {
    console.error('[interview] getMyInterview error:', err);
    fail(res, 500, 'Could not load your interview date.');
  }
};
export const adminRejectDaf = decide('rejected');
