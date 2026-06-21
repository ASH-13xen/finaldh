import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cached parsed syllabus_hierarchy.json and per-subject flattened {section, title} index.
let syllabusLoadPromise = null;
const subjectIndexCache = new Map();

const loadSyllabus = () => {
  if (!syllabusLoadPromise) {
    syllabusLoadPromise = (async () => {
      const syllabusPath = path.join(__dirname, '../syllabus_hierarchy.json');
      const content = await fs.readFile(syllabusPath, 'utf8');
      return JSON.parse(content);
    })();
  }
  return syllabusLoadPromise;
};

// Returns the raw sections array (gsModules or optionalSubjects entry) for a subject, or null.
const getSubjectOutline = (fullSyllabus, subject) => {
  if (fullSyllabus.gsModules && fullSyllabus.gsModules[subject]) {
    return fullSyllabus.gsModules[subject];
  }
  if (fullSyllabus.optionalSubjects && fullSyllabus.optionalSubjects[subject]) {
    return fullSyllabus.optionalSubjects[subject];
  }
  return null;
};

// Builds (and caches) a flat list of { section, title, sectionLower, titleLower } entries for a subject.
const getSubjectIndex = async (subject) => {
  if (subjectIndexCache.has(subject)) {
    return subjectIndexCache.get(subject);
  }

  const fullSyllabus = await loadSyllabus();
  const outline = getSubjectOutline(fullSyllabus, subject);

  const entries = [];
  if (outline) {
    for (const sec of outline) {
      const section = sec.section || 'General';
      for (const topic of (sec.topics || [])) {
        const title = topic.title || '';
        entries.push({ section, title, sectionLower: section.toLowerCase(), titleLower: title.toLowerCase() });
      }
    }
  }

  subjectIndexCache.set(subject, entries);
  return entries;
};

// Resolves a single raw tag string against the syllabus for a subject using plain string matching
// (exact match, then substring containment). No AI/network calls. Falls back to an unmatched tag
// so the admin can see and fix it.
export const resolveTag = async (subject, rawTag) => {
  const trimmed = (rawTag || '').trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const entries = await getSubjectIndex(subject);

  // 1. Exact topic title match
  const exactTitle = entries.find(e => e.titleLower === lower);
  if (exactTitle) {
    return { section: exactTitle.section, title: exactTitle.title, matched: true };
  }

  // 2. Exact section name match
  const exactSection = entries.find(e => e.sectionLower === lower);
  if (exactSection) {
    return { section: exactSection.section, title: '', matched: true };
  }

  // 3. Substring containment against topic titles (either direction)
  const fuzzyTitle = entries.find(e => e.titleLower && (e.titleLower.includes(lower) || lower.includes(e.titleLower)));
  if (fuzzyTitle) {
    return { section: fuzzyTitle.section, title: fuzzyTitle.title, matched: true };
  }

  // 4. Substring containment against section names (either direction)
  const fuzzySection = entries.find(e => e.sectionLower && (e.sectionLower.includes(lower) || lower.includes(e.sectionLower)));
  if (fuzzySection) {
    return { section: fuzzySection.section, title: '', matched: true };
  }

  // 5. Unmatched - keep raw value visible so admin can fix the CSV
  return { section: 'General', title: trimmed, matched: false };
};

// Resolves a CSV "tags" cell (semicolon-separated) into { tags, rawTags }. Semicolon, not
// comma, is the separator because section/topic names themselves can contain commas
// (e.g. "Fundamentals of Sociology, Science, and Research").
export const resolveTagsCell = async (subject, cellValue) => {
  const rawTags = (cellValue || '')
    .split(';')
    .map(t => t.trim())
    .filter(Boolean);

  // Dedupe raw tags case-insensitively while preserving first-seen casing
  const seen = new Set();
  const dedupedRawTags = [];
  for (const t of rawTags) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRawTags.push(t);
    }
  }

  const tags = [];
  for (const rawTag of dedupedRawTags) {
    const resolved = await resolveTag(subject, rawTag);
    if (resolved) tags.push(resolved);
  }

  return { tags, rawTags: dedupedRawTags };
};
