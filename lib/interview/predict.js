// Predicted interview questions for one student's DAF, each backed by evidence from past transcripts.
// The evidence (and so the likelihood shown to the student) always comes from the corpus; Gemini, when
// available, only rewrites it into questions tailored to this student and adds clearly-labelled new angles.
import crypto from 'crypto';
import { normalizeText, tokenize, uniq } from './text.js';
import { HOOK_TYPES } from './taxonomy.js';
import { searchFamilies, familiesByHookValue, templatesFor, topFamilies } from './corpusIndex.js';
import { aiAvailable, generateJson, embedTexts } from './gemini.js';

const CURRENT_YEAR = new Date().getFullYear();

// Words people put in a DAF -> what the transcripts call the same thing.
const EXPANSIONS = {
  gaming: 'gaming video games online gaming esports e sports pubg bgmi game',
  'video games': 'gaming video games online gaming esports',
  esports: 'esports e sports gaming online gaming',
  cricket: 'cricket ipl bcci test cricket world cup',
  football: 'football fifa isl',
  chess: 'chess grandmaster',
  reading: 'reading books novel author',
  books: 'books reading novel author',
  music: 'music singing song raga',
  singing: 'singing music song raga',
  dance: 'dance dancing classical dance',
  travelling: 'travelling travel tourism trekking',
  traveling: 'travelling travel tourism trekking',
  photography: 'photography photographs camera',
  cooking: 'cooking food cuisine recipe',
  yoga: 'yoga meditation',
  writing: 'writing poetry blog novel',
  poetry: 'poetry poem poems poet',
  painting: 'painting art artist',
  movies: 'movies cinema films film',
  ncc: 'ncc national cadet corps',
  nss: 'nss national service scheme',
  psir: 'psir political science international relations',
  'public administration': 'public administration pub ad',
  engineering: 'engineering engineer',
  'computer science': 'computer science software coding programming',
  mbbs: 'mbbs doctor medical medicine',
  farmer: 'farmer farmers farming agriculture msp crop',
  teacher: 'teacher teachers teaching school education',
  doctor: 'doctor doctors medical health hospital',
  businessman: 'business businessman trader shop msme',
  'government servant': 'government servant employee officer bureaucracy',
  army: 'army armed forces soldier defence',
  police: 'police policing constable',
  lawyer: 'lawyer advocate court judiciary',
  homemaker: 'homemaker housewife women unpaid work'
};

const expand = (value) => {
  const v = normalizeText(value);
  return EXPANSIONS[v] || v;
};

const recency = (lastYear) => Math.max(0.7, 1 - (CURRENT_YEAR - 1 - (lastYear || 2020)) * 0.05);

const KIND_WEIGHT = { direct: 1.5, pattern: 1.2, related: 0.8, area: 0.6 };

export const likelihoodFrom = (evidence) => {
  if (!evidence.length) return 'new';
  const strength = evidence.reduce((s, e) => s + (e.timesAsked || 1) * (KIND_WEIGHT[e.kind] || 0.6), 0);
  if (strength >= 6) return 'high';
  if (strength >= 2.5) return 'medium';
  return 'low';
};

const yearsLabel = (years) => {
  const ys = uniq(years).sort();
  if (!ys.length) return '';
  return ys.length === 1 ? `${ys[0]}` : `${ys[0]}–${ys[ys.length - 1]}`;
};

// "Father: farmer; Mother is a teacher" -> [{ label: 'Father: farmer', value: 'farmer' }, ...].
// Boards ask about what the parents do, not who they are.
const RELATION = /^(father|mother|parents?|brother|sister|husband|wife|spouse|grandfather|grandmother)\b\s*(?:[:\-–]|is an?\b|is\b|was an?\b|was\b|works? as an?\b|works? as\b|works? in\b|runs an?\b|runs\b)?\s*(.*)$/i;
export const familyItems = (text) => {
  const out = [];
  for (const raw of String(text || '').split(/[;,\n/]|\band\b/i)) {
    const part = raw.replace(/\s+/g, ' ').trim();
    if (!part) continue;
    const m = part.match(RELATION);
    const value = (m ? m[2] : part).replace(/^(a|an|the|retired|late)\s+/i, '').replace(/[.]+$/, '').trim();
    if (value.length < 3 || /^(n\/?a|none|nil|no|not applicable)$/i.test(value)) continue;
    out.push({ value, label: m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}: ${value}` : value });
  }
  return out.slice(0, 4);
};

// What a DAF looks like to the predictor: one item per thing a board could ask about.
export const profileItems = (profile = {}) => {
  const items = [];
  const add = (type, value, label, extra = {}) => {
    const v = String(value || '').trim();
    if (!v && !['intro', 'motivation'].includes(type)) return;
    items.push({ key: `${type}:${normalizeText(v) || type}`, type, value: v, label: label || v, ...extra });
  };
  add('intro', '', 'Opening & introduction');
  add('motivation', '', 'Why civil services');
  if (profile.homeState) add('home', profile.homeState, `Home state · ${profile.homeState}`);
  if (profile.homeDistrict) add('home', profile.homeDistrict, `Home district · ${profile.homeDistrict}`);
  if (profile.hometown && normalizeText(profile.hometown) !== normalizeText(profile.homeDistrict)) add('home', profile.hometown, `Hometown · ${profile.hometown}`);
  for (const e of profile.education || []) {
    const main = e.discipline || e.degree;
    if (main) add('education', main, [e.degree, e.discipline].filter(Boolean).join(' · ') || main, { institution: e.institution || '' });
    if (e.institution) add('education', e.institution, `College · ${e.institution}`);
  }
  for (const w of profile.work || []) {
    const main = w.organization || w.role;
    if (main) add('work', main, [w.role, w.organization].filter(Boolean).join(' at ') || main, { role: w.role || '' });
  }
  if (profile.optional) add('optional', profile.optional, `Optional · ${profile.optional}`);
  for (const h of profile.hobbies || []) add('hobby', h, h);
  for (const a of profile.achievements || []) add('eca', a, a);
  if ((profile.servicePreference || []).length) add('service', profile.servicePreference.join(', '), `Service preference · ${profile.servicePreference.slice(0, 3).join(', ')}`);
  for (const f of familyItems(profile.familyBackground)) add('family', f.value, `Family · ${f.label}`);
  // Everyone lists Hindi and English; boards ask about the others.
  for (const l of profile.languages || []) if (!/^(hindi|english)$/i.test(String(l).trim())) add('language', l, `Language · ${l}`);
  const seen = new Set();
  return items.filter((it) => (seen.has(it.key) ? false : seen.add(it.key)));
};

// Bump when the prediction logic changes, so saved predictions are rebuilt.
const PREDICTOR_VERSION = 3;

export const profileHash = (profile, idx) => crypto
  .createHash('sha1')
  .update(JSON.stringify({ v: PREDICTOR_VERSION, items: profileItems(profile).map((i) => i.key), fb: profile.familyBackground || '', notes: profile.otherNotes || '', n: idx.stats.families, t: idx.templates.length, sem: idx.stats.semantic }))
  .digest('hex')
  .slice(0, 16);

// Accepts a raw index family or a search summary (which calls the count timesAsked).
const evidenceOf = (f, kind) => ({
  kind,
  familyId: f.id,
  text: f.text,
  timesAsked: f.transcriptCount ?? f.timesAsked ?? 1,
  years: f.years,
  lastYear: f.lastYear,
  boards: (f.boards || []).filter(Boolean).slice(0, 3)
});

// Evidence for one DAF item, strongest first.
const gatherEvidence = (idx, item, queryVec) => {
  const out = [];
  const seen = new Set();
  const push = (f, kind) => {
    if (!f || seen.has(f.id)) return;
    seen.add(f.id);
    out.push(evidenceOf(f, kind));
  };

  if (item.type === 'intro' || item.type === 'motivation') {
    for (const f of topFamilies(idx, { hookType: item.type }, 12)) push(f, 'direct');
    return { evidence: out, templates: [] };
  }

  // 1. Asked to past candidates who had this same item in their DAF
  for (const f of familiesByHookValue(idx, item.value, item.type).slice(0, 12)) push(f, 'direct');
  // 2. Past questions that mention it (words, and meaning when embeddings exist)
  const { items: hits } = searchFamilies(idx, { q: expand(item.value), queryVec, limit: 25 });
  const tokens = new Set(tokenize(expand(item.value)));
  for (const f of hits) {
    const mentions = tokenize(f.text).some((t) => tokens.has(t));
    if (mentions || f.score >= 0.5) push(f, 'related');
  }
  // 3. What boards ask about this kind of DAF item in general ("Why did you choose X as optional?")
  const templates = templatesFor(idx, item.type, 6).map((t) => ({
    kind: 'pattern',
    text: t.text.replace('{X}', item.value),
    template: t.text,
    timesAsked: t.transcriptCount,
    years: t.years,
    lastYear: t.years[t.years.length - 1],
    values: t.values.slice(0, 5),
    familyIds: t.familyIds.slice(0, 5)
  }));
  // Only personal questions about the same DAF area ("What do you do in your free time?"), not every
  // question that happened to be asked to someone with an item of this kind.
  if (out.length < 6) {
    for (const f of topFamilies(idx, { hookType: item.type }, 30)) {
      if (f.hookTypes[0] === item.type && /\b(you|your)\b/i.test(f.text)) push(f, 'area');
      if (out.length >= 10) break;
    }
  }
  return { evidence: out, templates };
};

const basisNote = (kind, ev, item) => {
  const yrs = yearsLabel(ev.years);
  const n = ev.timesAsked;
  const times = `${n} interview${n === 1 ? '' : 's'}`;
  switch (kind) {
    case 'direct':
      return item.type === 'intro' || item.type === 'motivation'
        ? `Asked in ${times} (${yrs})`
        : `Asked in ${times} to candidates with “${item.value}” in their DAF (${yrs})`;
    case 'pattern':
      return `Boards asked this about ${ev.values.slice(0, 3).join(', ')} and others — ${times} (${yrs})`;
    case 'related':
      return `Similar question asked in ${times} (${yrs})`;
    default:
      return `Common question on ${HOOK_TYPES[item.type]?.toLowerCase() || 'this area'} — ${times} (${yrs})`;
  }
};

// Rank the evidence itself into predictions (the no-AI path, and the base the AI path builds on).
const evidencePredictions = (item, evidence, templates, limit = 8) => {
  const preds = [];
  for (const ev of evidence) {
    preds.push({
      question: ev.text,
      kind: ev.kind,
      evidence: [ev],
      score: (KIND_WEIGHT[ev.kind] || 0.6) * (1 + Math.log(1 + ev.timesAsked)) * recency(ev.lastYear),
      basisNote: basisNote(ev.kind, ev, item)
    });
  }
  for (const t of templates) {
    preds.push({
      question: t.text,
      kind: 'pattern',
      evidence: [t],
      score: KIND_WEIGHT.pattern * (1 + Math.log(1 + t.timesAsked)) * recency(t.lastYear),
      basisNote: basisNote('pattern', t, item)
    });
  }
  preds.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return preds.filter((p) => {
    const k = normalizeText(p.question);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit).map((p, i) => ({ ...p, id: `${item.key}#${i}`, likelihood: likelihoodFrom(p.evidence) }));
};

const AI_SYSTEM = `You prepare UPSC Civil Services interview (Personality Test) candidates. You predict the questions the board is likely to ask about each item in the candidate's DAF, using evidence from real past interview transcripts (2020-2024).
- Write each question the way a board member would ask it: short, direct, Indian English.
- Ground questions in the evidence you are given and cite the evidence ids in "basis". Rephrase evidence for this candidate (use their actual hobby/state/college).
- You may add at most two "fresh angle" questions per item about recent developments (laws, schemes, events) you are confident about; these get "basis": [].
- Never claim a question was asked before unless it cites evidence. Never invent statistics.
- "tip": one line on what a strong answer covers.`;

// Gemini writes a few DAF items per request and the requests run side by side: one big request took
// over 25 seconds, too long for a student waiting to enter the interview room.
const AI_ITEMS_PER_REQUEST = 4;
const aiPredictions = async (profile, groups) => {
  const batches = [];
  for (let i = 0; i < groups.length; i += AI_ITEMS_PER_REQUEST) batches.push(groups.slice(i, i + AI_ITEMS_PER_REQUEST));
  const done = await Promise.allSettled(batches.map((batch) => aiPredictionBatch(profile, batch)));
  const failed = done.filter((d) => d.status === 'rejected');
  if (failed.length === done.length && failed.length) throw failed[0].reason;
  return done.flatMap((d) => (d.status === 'fulfilled' ? d.value : []));
};

const aiPredictionBatch = async (profile, groups) => {
  const payload = groups.map((g) => ({
    item: g.key,
    area: HOOK_TYPES[g.type] || g.type,
    value: g.value || g.label,
    evidence: [
      ...g._evidence.slice(0, 10).map((e, i) => ({ id: `${g.key}|e${i}`, text: e.text, timesAsked: e.timesAsked, years: yearsLabel(e.years), match: e.kind })),
      ...g._templates.slice(0, 4).map((t, i) => ({ id: `${g.key}|t${i}`, text: t.template, timesAsked: t.timesAsked, years: yearsLabel(t.years), match: 'template', askedFor: t.values.join(', ') }))
    ]
  }));
  const prompt = `Candidate DAF summary:
${JSON.stringify({
    homeState: profile.homeState, homeDistrict: profile.homeDistrict, hometown: profile.hometown,
    education: profile.education, work: profile.work, optional: profile.optional, hobbies: profile.hobbies,
    achievements: profile.achievements, servicePreference: profile.servicePreference, familyBackground: profile.familyBackground,
    languages: profile.languages, otherNotes: String(profile.otherNotes || '').slice(0, 600) || undefined
  })}

DAF items with evidence from past transcripts:
${JSON.stringify(payload)}

Return JSON: {"items":[{"item":"<item key>","questions":[{"question":"","basis":["<evidence id>"],"angle":"daf-depth|current-affairs|opinion|situational|factual","tip":""}]}]}
Give 4-6 questions per item, most likely first.`;
  const res = await generateJson({ system: AI_SYSTEM, prompt, temperature: 0.5, maxOutputTokens: 6000 });
  return Array.isArray(res?.items) ? res.items : [];
};

// Full prediction set for a profile. Returns the object stored in InterviewProfile.predictionCache.data.
export const buildPredictions = async (idx, profile, { useAI = aiAvailable() } = {}) => {
  const items = profileItems(profile);
  let queryVecs = null;
  if (useAI && idx.vectors) {
    try {
      const terms = items.map((it) => expand(it.value || it.label));
      queryVecs = await embedTexts(terms, { taskType: 'RETRIEVAL_QUERY' });
    } catch { queryVecs = null; }
  }

  const groups = items.map((item, i) => {
    const { evidence, templates } = gatherEvidence(idx, item, queryVecs?.[i] || null);
    return {
      key: item.key,
      type: item.type,
      typeLabel: HOOK_TYPES[item.type] || item.type,
      value: item.value,
      label: item.label,
      evidenceCount: evidence.length + templates.length,
      _evidence: evidence,
      _templates: templates,
      predictions: evidencePredictions(item, evidence, templates)
    };
  });

  let aiUsed = false;
  if (useAI) {
    try {
      const ai = await aiPredictions(profile, groups.filter((g) => g.type !== 'intro'));
      for (const entry of ai) {
        const g = groups.find((x) => x.key === entry.item);
        if (!g || !Array.isArray(entry.questions)) continue;
        const lookup = (id) => {
          const [, ref] = String(id).split('|');
          if (!ref) return null;
          const n = Number(ref.slice(1));
          return ref[0] === 'e' ? g._evidence[n] : ref[0] === 't' ? g._templates[n] : null;
        };
        const preds = entry.questions.filter((q) => q?.question).slice(0, 6).map((q, i) => {
          const evidence = (q.basis || []).map(lookup).filter(Boolean);
          const top = evidence[0];
          return {
            id: `${g.key}#ai${i}`,
            question: String(q.question).slice(0, 300),
            kind: evidence.length ? 'ai' : 'new',
            angle: q.angle || '',
            tip: String(q.tip || '').slice(0, 240),
            evidence,
            likelihood: likelihoodFrom(evidence),
            basisNote: top ? basisNote(top.kind, top, g) : 'New angle — not seen in past transcripts',
            score: 0
          };
        });
        if (preds.length) {
          // Keep the strongest raw past questions after the tailored ones, so the evidence stays visible.
          const tailoredFamilies = new Set(preds.flatMap((p) => p.evidence.map((e) => e.familyId)).filter(Boolean));
          const raw = g.predictions.filter((p) => !p.evidence.some((e) => tailoredFamilies.has(e.familyId))).slice(0, 3);
          g.predictions = [...preds, ...raw];
          aiUsed = true;
        }
      }
    } catch (err) {
      if (err.name !== 'GeminiUnavailableError') console.warn('[interview] AI predictions failed, using evidence only:', err.message);
    }
  }

  const general = topFamilies(idx, { shelfLife: 'evergreen', minAsked: 3 }, 12).map((f) => ({
    ...f,
    basisNote: `Asked in ${f.timesAsked} interviews (${yearsLabel(f.years)})`
  }));

  return {
    generatedAt: new Date().toISOString(),
    aiUsed,
    corpus: { transcripts: idx.stats.transcripts, years: idx.stats.years },
    groups: groups.map(({ _evidence, _templates, ...g }) => g),
    general
  };
};
