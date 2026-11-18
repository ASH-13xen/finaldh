// Corpus-wide facts computed once, when the bank is built:
//   areas    - how often boards asked about each DAF area when a candidate listed it
//              ("work experience: asked in 93% of interviews where it was listed, ~4 questions")
//   items    - the same for each clean keyword with enough data (Cricket, IIT Bombay, Software Engineer...)
//   keywords - every keyword with interview and question counts, for browsing the bank by DAF
//   boards   - each board's style: size, DAF share, question mix, follow-up depth, favourite questions
// Stored in InterviewMeta and loaded with the search index.
import { normalizeText } from './text.js';

export const DAF_TYPES = new Set(['home', 'education', 'work', 'optional', 'hobby', 'eca', 'service', 'family', 'language', 'name']);

// Where each kind of keyword sits in a transcript, and which question hooks count as "asked about it".
const ITEM_KINDS = {
  hobby: { list: (n) => n.hobbies, hooks: ['hobby', 'eca'] },
  college: { list: (n) => n.colleges, hooks: ['education'] },
  collegeGroup: { list: (n) => n.collegeGroups, hooks: null },
  discipline: { list: (n) => n.disciplines, hooks: ['education'] },
  degree: { list: (n) => n.degrees, hooks: null },
  job: { list: (n) => n.jobs, hooks: ['work'] },
  sector: { list: (n) => n.sectors, hooks: null },
  state: { list: (n, t) => [t.profile.homeState || n.state].filter(Boolean), hooks: ['home'], area: true },
  optional: { list: (n, t) => [t.profile.optional].filter(Boolean), hooks: ['optional'], area: true }
};

const AREAS = {
  hobby: { has: (t) => t.profile.hobbies.length > 0, hooks: ['hobby', 'eca'] },
  education: { has: (t) => t.profile.education.length > 0, hooks: ['education'] },
  work: { has: (t) => t.profile.work.length > 0, hooks: ['work'] },
  home: { has: (t) => !!(t.profile.homeState || t.profile.home), hooks: ['home'] },
  optional: { has: (t) => !!t.profile.optional, hooks: ['optional'] }
};

const lc = (s) => String(s || '').toLowerCase();
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const round1 = (x) => Math.round(x * 10) / 10;
const top = (counts, n) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);

export const computeMeta = ({ transcripts, questions, families }, keywordTable = null) => {
  const byT = new Map();
  for (const q of questions) {
    if (!byT.has(q.transcriptKey)) byT.set(q.transcriptKey, []);
    byT.get(q.transcriptKey).push(q);
  }
  const famCount = new Map(families.map((f) => [f.key, f.transcriptCount]));

  // Areas
  const areas = {};
  for (const [type, a] of Object.entries(AREAS)) {
    let listed = 0;
    let asked = 0;
    let qn = 0;
    for (const t of transcripts) {
      if (!a.has(t)) continue;
      listed++;
      const n = (byT.get(t.key) || []).filter((q) => q.hooks.some((h) => a.hooks.includes(h.type))).length;
      if (n) asked++;
      qn += n;
    }
    areas[type] = { listed, asked, pct: pct(asked, listed), avgQuestions: listed ? round1(qn / listed) : 0 };
  }

  // Items and keyword lists
  const items = {};
  const keywords = {};
  const groupOf = { hobby: new Map(), college: new Map(), job: new Map() };
  if (keywordTable) {
    for (const r of Object.values(keywordTable.hobby || {})) if (r[0]) groupOf.hobby.set(r[0], r[1] || '');
    for (const r of Object.values(keywordTable.education || {})) if (r[2]) groupOf.college.set(r[2], r[3] || '');
    for (const r of Object.values(keywordTable.work || {})) if (r[0]) groupOf.job.set(r[0], r[1] || '');
  }
  for (const [kind, spec] of Object.entries(ITEM_KINDS)) {
    const stat = new Map(); // label -> { listed, asked, qn }
    for (const t of transcripts) {
      const n = t.profile.norm || {};
      const labels = [...new Set((spec.list(n, t) || []).filter(Boolean))];
      if (!labels.length) continue;
      const qs = byT.get(t.key) || [];
      for (const label of labels) {
        if (!stat.has(label)) stat.set(label, { listed: 0, asked: 0, qn: 0 });
        const s = stat.get(label);
        s.listed++;
        if (!spec.hooks) continue;
        const about = qs.filter((q) => q.hooks.some((h) => spec.hooks.includes(h.type) && (spec.area || lc(h.label) === lc(label))));
        if (about.length) s.asked++;
        s.qn += about.length;
      }
    }
    // Questions about each label anywhere in the bank, and the families boards used most for it.
    const aboutCount = new Map();
    const famBy = new Map();
    if (spec.hooks) {
      for (const q of questions) {
        for (const h of q.hooks) {
          if (!spec.hooks.includes(h.type)) continue;
          const label = spec.area && kind === 'optional' ? h.label : h.label;
          if (!label) continue;
          aboutCount.set(label, (aboutCount.get(label) || 0) + 1);
          if (q.familyKey) {
            if (!famBy.has(label)) famBy.set(label, new Map());
            const m = famBy.get(label);
            m.set(q.familyKey, (m.get(q.familyKey) || 0) + 1);
          }
        }
      }
    }
    const list = [];
    for (const [label, s] of stat) {
      if (s.listed < 3) continue;
      const entry = {
        label,
        group: groupOf[kind]?.get(label) || '',
        interviews: s.listed,
        questions: aboutCount.get(label) || 0
      };
      if (spec.hooks && s.listed >= 8) {
        entry.askedPct = pct(s.asked, s.listed);
        entry.avgQuestions = round1(s.qn / s.listed);
      }
      list.push(entry);
      if (spec.hooks) {
        const fams = famBy.get(label);
        items[`${kind}:${lc(label)}`] = {
          kind, label, interviews: s.listed, asked: s.asked,
          askedPct: s.listed >= 8 ? pct(s.asked, s.listed) : null,
          avgQuestions: s.listed >= 8 ? round1(s.qn / s.listed) : null,
          questions: aboutCount.get(label) || 0,
          families: fams ? top(fams, 10).sort((a, b) => (famCount.get(b[0]) || 0) - (famCount.get(a[0]) || 0)).map(([k]) => k) : []
        };
      }
    }
    list.sort((a, b) => b.interviews - a.interviews || a.label.localeCompare(b.label));
    keywords[kind] = list;
  }

  // Boards
  const boardT = new Map();
  for (const t of transcripts) {
    const b = t.profile.board;
    if (!b) continue;
    if (!boardT.has(b)) boardT.set(b, []);
    boardT.get(b).push(t);
  }
  const boards = [];
  for (const [name, ts] of boardT) {
    if (ts.length < 3) continue;
    const qs = ts.flatMap((t) => byT.get(t.key) || []);
    const qtypes = new Map();
    const topics = new Map();
    const fams = new Map();
    const openers = new Map();
    let daf = 0;
    let follow = 0;
    for (const q of qs) {
      if (q.hooks.some((h) => DAF_TYPES.has(h.type))) daf++;
      if (q.followUp) follow++;
      qtypes.set(q.qtype, (qtypes.get(q.qtype) || 0) + 1);
      for (const tp of q.topics || []) topics.set(tp, (topics.get(tp) || 0) + 1);
      if (q.familyKey && !q.trivial) fams.set(q.familyKey, (fams.get(q.familyKey) || 0) + 1);
      if (q.order === 1 && q.familyKey) openers.set(q.familyKey, (openers.get(q.familyKey) || 0) + 1);
    }
    const years = [...new Set(ts.map((t) => t.year))].sort();
    // How candidates described the board (lib/interview/mood.js); only interviews that said something.
    const moodCounts = { cordial: 0, neutral: 0, tough: 0, n: 0 };
    for (const t of ts) if (['cordial', 'neutral', 'tough'].includes(t.mood)) { moodCounts[t.mood] += 1; moodCounts.n += 1; }
    boards.push({
      name,
      initials: name.replace(/\./g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3).toUpperCase(),
      interviews: ts.length,
      years,
      avgQuestions: round1(qs.length / ts.length),
      dafPct: pct(daf, qs.length),
      followUpPct: pct(follow, qs.length),
      qtypes: Object.fromEntries(top(qtypes, 8).map(([k, v]) => [k, pct(v, qs.length)])),
      topics: top(topics, 6).map(([k, v]) => ({ topic: k, pct: pct(v, qs.length) })),
      families: top(fams, 12).filter(([, n]) => n >= 2).map(([k, n]) => ({ key: k, n })),
      openers: top(openers, 5).map(([k, n]) => ({ key: k, n })),
      mood: moodCounts.n ? moodCounts : null
    });
  }
  boards.sort((a, b) => b.interviews - a.interviews);

  return {
    generatedAt: new Date().toISOString(),
    interviews: transcripts.length,
    areas,
    items,
    keywords,
    boards,
    keywordTable: keywordTable || null
  };
};

// "Cricket" in a student's DAF -> the meta item for it, if the bank has enough data.
export const itemFor = (meta, kind, label) => (label ? meta?.items?.[`${kind}:${normalizeText(label) === '' ? '' : lc(label)}`] || null : null);
