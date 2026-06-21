// Plain free-text tag matching for the Progress feature.
// Deliberately separate from syllabusTagMatcher.js (which resolves tags against
// syllabus_hierarchy.json for the MCQ feature) - this feature has no syllabus lookup,
// it just compares two arbitrary admin-entered strings.

export const normalizeTagString = (str) => (str || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const splitTagValues = (tagCell) => {
  const seen = new Set();
  const values = [];
  for (const raw of (tagCell || '').split(';')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }
  return values;
};

export const tagsMatch = (a, b) => {
  const normA = normalizeTagString(a);
  const normB = normalizeTagString(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  return normA.includes(normB) || normB.includes(normA);
};

// Matches against the union of tag values across multiple questions' tag cells at once
// (e.g. every question a user has completed in a file), not just one question at a time.
export const findMatchingPyqsForTagCells = (tagCells, pyqs) => {
  const seen = new Set();
  const tagValues = [];
  for (const cell of tagCells) {
    for (const value of splitTagValues(cell)) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tagValues.push(value);
    }
  }
  if (tagValues.length === 0) return [];

  const matched = new Map();
  for (const pyq of pyqs) {
    const isMatch = tagValues.some((tagValue) => tagsMatch(tagValue, pyq.section));
    if (isMatch) matched.set(String(pyq._id), pyq);
  }

  return Array.from(matched.values()).sort((a, b) => (b.year || 0) - (a.year || 0));
};
