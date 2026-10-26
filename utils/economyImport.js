// Load parse_economy_master.mjs output into Mongo. Shared by the CLI importer and the admin
// "Import JSON" endpoint.
//
// Upserts by importKey, so re-importing a corrected parse updates topic text in place and keeps
// _ids — which progress, bookmarks and notes point at — plus the admin-added facts / research.
// Topics an admin hand-edited (editedAt set) keep their edited body unless `overwriteEdited`.

import EconomyTopic, { SOURCES } from '../models/EconomyTopic.js';
import EconomyTheme from '../models/EconomyTheme.js';
import { ECONOMY_THEMES } from './economyThemes.js';

const MAX_TOPICS = 5000;
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

export const importKeyOf = (t) =>
  [t.source, (t.sourceTheme || '').toLowerCase(), t.number ?? '', (t.title || '').toLowerCase()]
    .join('|').replace(/\s+/g, ' ').slice(0, 400);

const cleanSpan = (s) => {
  if (!s || typeof s !== 'object') return null;
  const out = { t: clip(s.t, 4000) };
  if (s.b) out.b = 1;
  if (['g', 'c', 'y'].includes(s.hl)) out.hl = s.hl;
  if (['ok', 'no'].includes(s.m)) { out.m = s.m; out.t = ''; }
  return out.t || out.m ? out : null;
};

const cleanBlocks = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .map((b) => ({
    level: Math.max(0, Math.min(3, Number(b?.level) || 0)),
    glyph: typeof b?.glyph === 'string' ? b.glyph.slice(0, 4) : null,
    heading: !!b?.heading,
    spans: (Array.isArray(b?.spans) ? b.spans : []).map(cleanSpan).filter(Boolean),
  }))
  .filter((b) => b.spans.length);

// Validates + normalises; returns { topics, errors }.
export const normaliseParsed = (parsed) => {
  const errors = [];
  const rows = Array.isArray(parsed?.topics) ? parsed.topics : null;
  if (!rows) return { topics: [], errors: ['JSON has no "topics" array — is this parse_economy_master.mjs output?'] };
  if (rows.length > MAX_TOPICS) return { topics: [], errors: [`Too many topics (${rows.length})`] };
  const themeKeys = new Set(ECONOMY_THEMES.map((t) => t.key));
  const topics = [];
  const seen = new Set();
  rows.forEach((t, i) => {
    const title = clip(t?.title, 300).trim();
    if (!title) return errors.push(`#${i}: missing title`);
    if (!SOURCES.includes(t.source)) return errors.push(`#${i} "${title}": bad source "${t.source}"`);
    if (!themeKeys.has(t.themeKey)) return errors.push(`#${i} "${title}": unknown theme "${t.themeKey}"`);
    const doc = {
      themeKey: t.themeKey,
      source: t.source,
      sourceTheme: clip(t.sourceTheme, 200),
      number: Number.isInteger(t.number) ? t.number : null,
      title,
      order: i,
      pages: (Array.isArray(t.pages) ? t.pages : []).filter(Number.isInteger).slice(0, 20),
      blocks: cleanBlocks(t.blocks),
      pyqTags: (Array.isArray(t.pyqTags) ? t.pyqTags : []).map((x) => clip(x, 60)).filter(Boolean).slice(0, 20),
    };
    let key = importKeyOf(doc);
    // the same heading can legitimately repeat inside one part; disambiguate by occurrence
    for (let n = 2; seen.has(key); n++) key = `${importKeyOf(doc)}#${n}`;
    seen.add(key);
    doc.importKey = key;
    topics.push(doc);
  });
  return { topics, errors };
};

export const seedThemes = async () => {
  await EconomyTheme.bulkWrite(ECONOMY_THEMES.map((t) => ({
    updateOne: {
      filter: { key: t.key },
      update: { $setOnInsert: { key: t.key, title: t.title, order: t.order } },
      upsert: true,
    },
  })));
};

// mode 'merge' (default): upsert, leave topics missing from this parse alone.
// mode 'replace': additionally hide topics that are no longer in the parse (never deletes —
// students may have notes on them).
export const importParsed = async (parsed, { mode = 'merge', overwriteEdited = false, dryRun = false } = {}) => {
  const { topics, errors } = normaliseParsed(parsed);
  const existing = await EconomyTopic.find({}).select('importKey editedAt').lean();
  const byKey = new Map(existing.map((e) => [e.importKey, e]));
  const report = {
    parsed: topics.length,
    created: topics.filter((t) => !byKey.has(t.importKey)).length,
    updated: topics.filter((t) => byKey.has(t.importKey)).length,
    keptEdited: topics.filter((t) => byKey.get(t.importKey)?.editedAt && !overwriteEdited).length,
    hidden: 0,
    errors,
  };
  const incoming = new Set(topics.map((t) => t.importKey));
  const stale = mode === 'replace' ? existing.filter((e) => !incoming.has(e.importKey)) : [];
  report.hidden = stale.length;
  if (dryRun || !topics.length) return report;

  await seedThemes();
  const ops = topics.map((t) => {
    const prev = byKey.get(t.importKey);
    const keepBody = prev?.editedAt && !overwriteEdited;
    const { blocks, title, ...meta } = t;
    const set = keepBody ? { ...meta, hidden: false } : { ...meta, title, blocks, hidden: false, editedAt: null };
    return { updateOne: { filter: { importKey: t.importKey }, update: { $set: set }, upsert: true } };
  });
  for (let i = 0; i < ops.length; i += 500) await EconomyTopic.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  if (stale.length) await EconomyTopic.updateMany({ _id: { $in: stale.map((s) => s._id) } }, { $set: { hidden: true } });
  return report;
};
