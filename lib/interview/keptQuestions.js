// Predicted questions a student has already worked on - a status set, saved, a written answer or a note, or
// practised aloud - stay exactly as they are when their predictions are rebuilt.
import InterviewPrep from '../../models/InterviewPrep.js';
import PracticeAttempt from '../../models/PracticeAttempt.js';

export const attemptedKeys = async (userId) => {
  const [prep, practised] = await Promise.all([
    InterviewPrep.findOne({ user: userId }).select('items.key items.status items.saved items.draft items.note').lean(),
    PracticeAttempt.distinct('questionKey', { user: userId, questionKey: { $ne: '' } })
  ]);
  const keys = new Set(practised);
  for (const i of prep?.items || []) {
    if (i.saved || i.draft || (i.note && i.note.trim()) || (i.status && i.status !== 'todo')) keys.add(i.key);
  }
  return keys;
};

// From saved predictions: item key -> the predictions whose question the student worked on.
export const keptFrom = (cache, keys) => {
  const out = new Map();
  if (!keys?.size) return out;
  for (const g of cache?.data?.groups || []) {
    const ps = (g.predictions || []).filter((p) => keys.has(p.key));
    if (ps.length) out.set(g.key, ps);
  }
  return out;
};

export const keptQuestions = async (userId, cache) => keptFrom(cache, await attemptedKeys(userId));
