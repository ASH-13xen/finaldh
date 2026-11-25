// A student gives their DAF once - uploaded or filled in - and never types or saves its details afterwards:
// what AI reads from an upload IS their details (a first DAF's at once; a paid change's once it is verified).
// When AI can't read an upload (AI off, out of credits, the read failed or found nothing), the student only
// waits while the upload is flagged on the admins' DAF Checks page; once AI works again an admin re-reads it
// ("Redo with AI") and the details are put in place, with a message in the student's inbox.
import DafSubmission from '../../models/DafSubmission.js';
import InterviewProfile from '../../models/InterviewProfile.js';
import Message from '../../models/Message.js';
import { extractDaf, cleanProfileInput, isProfileEmpty } from './daf.js';

// An entry for a verified student who had no details (verified before uploads were kept): nothing to verify.
export const ALREADY_VERIFIED = 'no check needed (already verified)';

// The DAF details in a reading (never a roll number: that is only ever the one an admin checked).
export const detailsFrom = (fields) => {
  const d = cleanProfileInput(fields || {});
  delete d.rollNo;
  return d;
};
const EMPTY_DETAILS = detailsFrom({});

// A new first DAF replaces whatever an earlier, rejected one left (it may have been the wrong file).
export const clearDetails = (userId) => InterviewProfile.updateOne({ user: userId }, { $set: { ...EMPTY_DETAILS, detailsSavedAt: null } });

// A note in the student's inbox (the bell), e.g. when their details are ready.
export const DETAILS_READY = 'Your DAF details are ready: open My DAF in Abhivyakti (Interview Prep) to see them.';
export const CHANGE_APPLIED = 'Your new DAF is verified: your details in Abhivyakti (Interview Prep) are updated. Your predicted questions update when you open them.';
export const notifyStudent = (userId, text) => Message.create({ recipientId: userId, text })
  .catch((err) => console.warn('[interview] inbox note failed:', String(err?.message || err).slice(0, 120)));

// Flags an upload AI couldn't read, with why (admins see it; the student just waits).
export const markUnread = (submissionId, reason) => DafSubmission.updateOne(
  { _id: submissionId },
  { $set: { needsRead: true, readError: String(reason || 'AI could not read it').replace(/\s+/g, ' ').slice(0, 300) } }
);

// The student saved their details themselves (a DAF with no file to read): nothing is waiting to be read.
export const clearUnread = (userId) => DafSubmission.updateMany({ user: userId, needsRead: true }, { $set: { needsRead: false } });

// The stored file read with AI: { fields, unsure }, or null when no file is kept. Throws when AI fails
// (GeminiUnavailableError when it is off).
export const readStoredDaf = async (submissionId) => {
  const s = await DafSubmission.findById(submissionId).select('+file mimeType').lean();
  if (!s?.file) return null;
  const buf = Buffer.isBuffer(s.file) ? s.file : Buffer.from(s.file.buffer || s.file);
  return extractDaf(buf, s.mimeType);
};

// What was read becomes the student's details:
// - a first DAF (or the upload of a verified student who had none): if they have no details yet;
// - a paid change already verified (it couldn't be read before): in place of the old details.
// While a change waits for verification nothing changes yet - verifying applies it. Returns whether applied.
export const applyReading = async (sub, fields) => {
  const read = detailsFrom(fields);
  const now = new Date();
  if (sub.kind === 'change') {
    const r = await InterviewProfile.updateOne(
      { user: sub.user, 'dafChange.submissionId': sub._id, 'dafChange.status': 'verified', 'dafChange.appliedAt': null },
      { $set: { ...read, source: 'upload', detailsSavedAt: now, 'dafChange.appliedAt': now } }
    );
    return r.modifiedCount > 0;
  }
  const p = await InterviewProfile.findOne({ user: sub.user }).lean();
  if (!p || !isProfileEmpty(p)) return false;
  const r = await InterviewProfile.updateOne(
    { _id: p._id, detailsSavedAt: p.detailsSavedAt ?? null },
    { $set: { ...read, source: 'upload', detailsSavedAt: now } }
  );
  return r.modifiedCount > 0;
};

// A reading of an upload (as it is sent, or an admin's Redo with AI): kept with it, its flag cleared, and the
// details put in place where they belong now. A waiting upload also gets the roll number read from it, for the
// admin's check. { notify } tells the student in their inbox when their details changed.
export const storeDafReading = async (sub, { fields, unsure }, { notify = false } = {}) => {
  await DafSubmission.updateOne(
    { _id: sub._id },
    { $set: { fields, unsure: unsure || [], needsRead: false, readError: '', ...(fields.rollNo && sub.status === 'pending' ? { rollNo: fields.rollNo } : {}) }, $inc: { aiReads: 1 } }
  );
  const applied = await applyReading(sub, fields);
  if (applied && notify) await notifyStudent(sub.user, sub.kind === 'change' ? CHANGE_APPLIED : DETAILS_READY);
  return { applied };
};
