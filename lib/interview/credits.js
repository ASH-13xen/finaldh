// AI credits for the Interview Prep section. Every student gets FREE_AI_USES once; after that, packs are
// bought through Razorpay and added the moment the payment is confirmed (no admin step). One credit = one
// personal AI action: an answer drafted from the student's DAF, or AI feedback on a recorded answer.
// Shared content (predictions, the bank, answer guides, notes, the guide) and the on-device practice report
// stay free. Admins never spend credits.
import InterviewProfile from '../../models/InterviewProfile.js';

export const FREE_AI_USES = 15;
export const CREDIT_PACKS = {
  p40: { id: 'p40', credits: 40, price: 299 },
  p60: { id: 'p60', credits: 60, price: 399 }
};
// A ceiling per student per day, whatever their balance, so one account can't run up the AI bill.
export const AI_USES_PER_DAY = 60;

const today = () => new Date().toISOString().slice(0, 10);

export const balanceOf = (profile) => {
  const free = Math.max(0, FREE_AI_USES - (profile?.credits?.freeUsed || 0));
  const paid = Math.max(0, profile?.credits?.paid || 0);
  return { free, paid, total: free + paid, freeTotal: FREE_AI_USES };
};

export const getBalance = async (userId) => balanceOf(await InterviewProfile.findOne({ user: userId }).select('credits').lean());

const ensureProfile = (userId) => InterviewProfile.updateOne({ user: userId }, { $setOnInsert: { user: userId } }, { upsert: true });

// Takes one credit, free ones first. Returns 'free' | 'paid', or null when the student has none left
// (or hit the daily ceiling: { limited: true }).
export const spendCredit = async (userId) => {
  await ensureProfile(userId);
  const day = today();
  await InterviewProfile.updateOne({ user: userId, 'usage.day': { $ne: day } }, { $set: { 'usage.day': day, 'usage.aiUses': 0, 'usage.predictionRuns': 0, 'usage.transcribes': 0, 'usage.extracts': 0, 'usage.approaches': 0, 'usage.practiceAI': 0 } });
  const underCap = { 'usage.day': day, $or: [{ 'usage.aiUses': { $lt: AI_USES_PER_DAY } }, { 'usage.aiUses': { $exists: false } }] };
  let r = await InterviewProfile.updateOne(
    { user: userId, ...underCap, $and: [{ $or: [{ 'credits.freeUsed': { $lt: FREE_AI_USES } }, { 'credits.freeUsed': { $exists: false } }] }] },
    { $inc: { 'credits.freeUsed': 1, 'usage.aiUses': 1 } }
  );
  if (r.modifiedCount) return { from: 'free' };
  r = await InterviewProfile.updateOne(
    { user: userId, ...underCap, 'credits.paid': { $gt: 0 } },
    { $inc: { 'credits.paid': -1, 'usage.aiUses': 1 } }
  );
  if (r.modifiedCount) return { from: 'paid' };
  const p = await InterviewProfile.findOne({ user: userId }).select('usage credits').lean();
  if ((p?.usage?.aiUses || 0) >= AI_USES_PER_DAY && balanceOf(p).total > 0) return { limited: true };
  return null;
};

// Gives a credit back when the AI call it paid for failed.
export const refundCredit = (userId, spent) => {
  if (!spent?.from) return Promise.resolve();
  const inc = spent.from === 'free' ? { 'credits.freeUsed': -1 } : { 'credits.paid': 1 };
  return InterviewProfile.updateOne({ user: userId }, { $inc: { ...inc, 'usage.aiUses': -1 } });
};

export const addPaidCredits = async (userId, n) => {
  await ensureProfile(userId);
  await InterviewProfile.updateOne({ user: userId }, { $inc: { 'credits.paid': n } });
};
