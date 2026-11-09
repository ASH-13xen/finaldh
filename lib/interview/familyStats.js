// Keeps a family's statistics in step with its member questions after an admin edit (merge, move, hide,
// board fix). Families left with no visible members are hidden rather than deleted, so links keep working.
import InterviewQuestion from '../../models/InterviewQuestion.js';
import InterviewFamily from '../../models/InterviewFamily.js';
import { representativeText } from './families.js';
import { uniq } from './text.js';
import { invalidateCorpusIndex } from './corpusIndex.js';

const countBy = (arr) => {
  const m = {};
  for (const x of arr) if (x !== undefined && x !== null && x !== '') m[x] = (m[x] || 0) + 1;
  return m;
};
const topKeys = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

export const recomputeFamilies = async (familyIds, { keepText = false } = {}) => {
  const ids = uniq((familyIds || []).filter(Boolean).map(String));
  for (const id of ids) {
    const fam = await InterviewFamily.findById(id);
    if (!fam) continue;
    const members = await InterviewQuestion.find({ family: id, hidden: { $ne: true } }).select('text year board topics hooks asker qtype shelfLife transcript').lean();
    if (!members.length) {
      fam.size = 0;
      fam.transcriptCount = 0;
      fam.hidden = true;
      await fam.save();
      continue;
    }
    const years = members.map((m) => m.year);
    if (!keepText) fam.text = representativeText(members.map((m) => m.text));
    fam.size = members.length;
    fam.transcriptCount = new Set(members.map((m) => String(m.transcript))).size;
    fam.years = uniq(years).sort();
    fam.yearCounts = countBy(years);
    fam.firstYear = Math.min(...years);
    fam.lastYear = Math.max(...years);
    const boardCounts = countBy(members.map((m) => m.board));
    fam.boardCounts = Object.entries(boardCounts).map(([board, n]) => ({ board, n }));
    fam.boards = topKeys(boardCounts, 12);
    fam.topics = topKeys(countBy(members.flatMap((m) => m.topics || [])), 2);
    fam.hookTypes = topKeys(countBy(members.flatMap((m) => (m.hooks || []).map((h) => h.type))), 4);
    fam.hookValues = topKeys(countBy(members.flatMap((m) => (m.hooks || []).map((h) => h.value))), 12);
    fam.askers = countBy(members.map((m) => m.asker));
    fam.qtype = topKeys(countBy(members.map((m) => m.qtype)), 1)[0] || 'other';
    fam.shelfLife = topKeys(countBy(members.map((m) => m.shelfLife)), 1)[0] || 'evergreen';
    fam.hidden = false;
    await fam.save();
  }
  invalidateCorpusIndex();
};
