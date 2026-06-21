// One-time tagging pass for the 5 imported MCQ papers (see import_test_papers.mjs).
// Each question is classified into exactly one syllabus SECTION (no topic) by reading its
// question text, restricted to the candidate sections of the GS module that matches the
// paper's subject (Economics -> GS-3, Geography -> GS-1, Polity -> GS-2). Classification was
// done by hand (reading every question), not by string-matching, since the question text rarely
// contains the section name verbatim.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import McqTest from '../models/McqTest.js';
import McqQuestion from '../models/McqQuestion.js';

dotenv.config();

const economicsAll = (() => {
  const m = {};
  for (let i = 1; i <= 100; i++) m[i] = 'Economy';
  return m;
})();

const geography1All = (() => {
  const m = {};
  for (let i = 1; i <= 100; i++) m[i] = 'Geography';
  return m;
})();

const geography2 = (() => {
  const m = {};
  for (let i = 1; i <= 100; i++) m[i] = 'Geography';
  m[2] = 'Society';
  m[4] = 'Indian Culture';
  m[68] = 'Society';
  m[69] = 'Society';
  return m;
})();

const polity1 = {
  1: 'Indian Constitution', 2: 'Polity', 3: 'Polity', 4: 'Indian Constitution', 5: 'Polity',
  6: 'Indian Constitution', 7: 'Polity', 8: 'Polity', 9: 'Polity', 10: 'Polity',
  11: 'Indian Constitution', 12: 'Social Justice', 13: 'Indian Constitution', 14: 'Indian Constitution', 15: 'Polity',
  16: 'Indian Constitution', 17: 'Indian Constitution', 18: 'Indian Constitution', 19: 'Polity', 20: 'Indian Constitution',
  21: 'Indian Constitution', 22: 'Indian Constitution', 23: 'Indian Constitution', 24: 'Indian Constitution', 25: 'Indian Constitution',
  26: 'Indian Constitution', 27: 'Indian Constitution', 28: 'Indian Constitution', 29: 'Indian Constitution', 30: 'Indian Constitution',
  31: 'Indian Constitution', 32: 'Indian Constitution', 33: 'Indian Constitution', 34: 'Indian Constitution', 35: 'Indian Constitution',
  36: 'Indian Constitution', 37: 'Indian Constitution', 38: 'Indian Constitution', 39: 'Indian Constitution', 40: 'Polity',
  41: 'Indian Constitution', 42: 'Indian Constitution', 43: 'Indian Constitution', 44: 'Indian Constitution', 45: 'International Relations',
  46: 'Indian Constitution', 47: 'Indian Constitution', 48: 'Indian Constitution', 49: 'Indian Constitution', 50: 'Indian Constitution',
  51: 'Polity', 52: 'Indian Constitution', 53: 'Indian Constitution', 54: 'Indian Constitution', 55: 'Polity',
  56: 'Polity', 57: 'Indian Constitution', 58: 'Governance', 59: 'Polity', 60: 'Indian Constitution',
  61: 'Polity', 62: 'Polity', 63: 'Polity', 64: 'Polity', 65: 'Indian Constitution',
  66: 'Polity', 67: 'Polity', 68: 'Polity', 69: 'Social Justice', 70: 'Indian Constitution',
  71: 'Polity', 72: 'Indian Constitution', 73: 'Indian Constitution', 74: 'Indian Constitution', 75: 'Indian Constitution',
  76: 'Indian Constitution', 77: 'Indian Constitution', 78: 'Indian Constitution', 79: 'Indian Constitution', 80: 'Indian Constitution',
  81: 'Indian Constitution', 82: 'Polity', 83: 'Governance', 84: 'Polity', 85: 'Polity',
  86: 'Indian Constitution', 87: 'Polity', 88: 'Polity', 89: 'Indian Constitution', 90: 'Indian Constitution',
  91: 'Indian Constitution', 92: 'Indian Constitution', 93: 'Indian Constitution', 94: 'Indian Constitution', 95: 'Indian Constitution',
  96: 'Indian Constitution', 97: 'Indian Constitution', 98: 'Governance', 99: 'Indian Constitution', 100: 'Polity'
};

const polity2 = {
  1: 'Indian Constitution', 2: 'Indian Constitution', 3: 'Polity', 4: 'Indian Constitution', 5: 'Social Justice',
  6: 'Governance', 7: 'Polity', 8: 'Governance', 9: 'Indian Constitution', 10: 'Governance',
  11: 'Polity', 12: 'Indian Constitution', 13: 'Governance', 14: 'Governance', 15: 'Indian Constitution',
  16: 'Polity', 17: 'Indian Constitution', 18: 'Indian Constitution', 19: 'Indian Constitution', 20: 'Polity',
  21: 'Indian Constitution', 22: 'Indian Constitution', 23: 'Indian Constitution', 24: 'Polity', 25: 'Indian Constitution',
  26: 'Indian Constitution', 27: 'Indian Constitution', 28: 'Indian Constitution', 29: 'Governance', 30: 'Polity',
  31: 'Indian Constitution', 32: 'Indian Constitution', 33: 'Indian Constitution', 34: 'Governance', 35: 'Governance',
  36: 'Governance', 37: 'Governance', 38: 'Indian Constitution', 39: 'Governance', 40: 'Social Justice',
  41: 'Social Justice', 42: 'Polity', 43: 'Governance', 44: 'Governance', 45: 'Polity',
  46: 'Polity', 47: 'Polity', 48: 'Polity', 49: 'Indian Constitution', 50: 'Social Justice',
  51: 'Polity', 52: 'Governance', 53: 'Polity', 54: 'Social Justice', 55: 'International Relations',
  56: 'Polity', 57: 'Social Justice', 58: 'Social Justice', 59: 'Polity', 60: 'Indian Constitution',
  62: 'Indian Constitution', 63: 'Governance', 64: 'Governance', 65: 'Polity', 67: 'Governance',
  69: 'Indian Constitution', 70: 'Indian Constitution', 71: 'Polity', 72: 'Polity', 73: 'Social Justice',
  75: 'International Relations', 77: 'Polity', 78: 'Governance', 79: 'Governance', 80: 'Indian Constitution',
  81: 'Indian Constitution', 82: 'Polity', 83: 'Indian Constitution', 84: 'Polity', 85: 'Governance',
  86: 'Social Justice', 87: 'Governance', 88: 'Governance', 89: 'International Relations', 90: 'Social Justice'
};

const PLAN = [
  { title: 'Economics Paper 1', map: economicsAll },
  { title: 'Geography Paper 1', map: geography1All },
  { title: 'Geography Paper 2', map: geography2 },
  { title: 'Polity Paper 1', map: polity1 },
  { title: 'Polity Paper 2', map: polity2 }
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  for (const { title, map } of PLAN) {
    const test = await McqTest.findOne({ title });
    if (!test) {
      console.log(`SKIP (test not found): ${title}`);
      continue;
    }

    const questions = await McqQuestion.find({ test: test._id });
    let updated = 0;
    let unmapped = 0;

    for (const q of questions) {
      const section = map[q.order];
      if (!section) {
        unmapped++;
        continue;
      }
      q.tags = [{ section, title: '', matched: true }];
      q.rawTags = [section];
      await q.save();
      updated++;
    }

    console.log(`${title}: tagged ${updated} question(s), ${unmapped} had no mapping (unexpected).`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Tagging failed:', err);
  process.exit(1);
});
