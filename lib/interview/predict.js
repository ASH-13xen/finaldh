// Predicted interview questions for one student's DAF, each backed by evidence from past transcripts.
// The evidence (and so the likelihood shown to the student) always comes from the corpus; Gemini, when
// available, only rewrites it into questions tailored to this student and adds clearly-labelled new angles.
import crypto from 'crypto';
import { normalizeText, tokenize, uniq, canonicalOptional, canonicalState } from './text.js';
import { HOOK_TYPES } from './taxonomy.js';
import { searchFamilies, familiesByHookValue, templatesFor, topFamilies, familyCosine } from './corpusIndex.js';
import { aiAvailable, generateJson, embedTexts } from './gemini.js';
import { matchKeyword } from './keywords.js';
import { translateTexts } from './translate.js';
import { prepKey } from './prepKey.js';

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
    if (e.institution) add('education', e.institution, `College · ${e.institution}`, { isCollege: true });
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
const PREDICTOR_VERSION = 5;

// How often boards asked about this DAF item when candidates listed it (CSE 2020-2025), from the corpus
// meta: the item's own rate when the bank has 8+ interviews with it ("Cricket: 66% of 300"), else the
// rate for its area ("hobbies: 91%"). Also the families boards used most for the item.
// A DAF item as the bank's keyword for it: { kind: hobby|college|discipline|job|state|optional, label, it }
// (it = the keyword's stats in the meta, when it has any), or null when the bank has no keyword for it.
export const keywordFor = (idx, item) => {
  const meta = idx.meta;
  if (!meta) return null;
  const K = meta.keywordTable;
  let kind = null;
  let label = '';
  switch (item.type) {
    case 'hobby':
    case 'eca':
      kind = 'hobby';
      label = matchKeyword(K, 'hobby', item.value);
      break;
    case 'education':
      if (item.isCollege) { kind = 'college'; label = matchKeyword(K, 'education', item.value, { col: 2 }); } else { kind = 'discipline'; label = matchKeyword(K, 'education', item.value, { col: 1 }); }
      break;
    case 'work':
      kind = 'job';
      label = matchKeyword(K, 'work', [item.role, item.value].filter(Boolean).join(', ')) || matchKeyword(K, 'work', item.role || item.value);
      break;
    case 'home':
      kind = 'state';
      label = canonicalState(item.value) || '';
      break;
    case 'optional':
      kind = 'optional';
      label = canonicalOptional(item.value) || '';
      break;
    default:
      break;
  }
  if (!kind || !label) return null;
  const it = meta.items?.[`${kind}:${label.toLowerCase()}`] || null;
  return { kind, label: it?.label || label, it };
};

export const rateFor = (idx, item) => {
  const meta = idx.meta;
  if (!meta) return null;
  const kw = keywordFor(idx, item);
  const kind = kw?.kind || null;
  const label = kw?.label || '';
  const it = kw?.it || null;
  if (it && it.askedPct != null) {
    return { scope: 'item', kind, label: it.label, askedPct: it.askedPct, avgQuestions: it.avgQuestions, interviews: it.interviews, questions: it.questions, families: it.families || [] };
  }
  const area = { hobby: 'hobby', eca: 'hobby', education: 'education', work: 'work', home: 'home', optional: 'optional' }[item.type];
  const a = area ? meta.areas?.[area] : null;
  if (!a) return null;
  return { scope: 'area', kind: area, label: it?.label || label || '', askedPct: a.pct, avgQuestions: a.avgQuestions, interviews: a.listed, families: it?.families || [] };
};


// Where a prediction comes from, as the student sees it.
const sourceOf = (kind) => (kind === 'new' ? 'new' : kind === 'ai' || kind === 'pattern' ? 'tailored' : 'past');

// Tiers: "Almost certain" only for the opening staples and the strongest evidence in DAF areas boards ask
// about in 80%+ of interviews; AI-only angles are never above "Worth preparing".
const tierOf = (p, item, rate, rank) => {
  if (p.kind === 'new') return 'worth';
  if (item.type === 'intro' || item.type === 'motivation') return rank < 3 ? 'certain' : 'likely';
  if (p.likelihood === 'high' && (rate?.askedPct || 0) >= 80 && rank < 2) return 'certain';
  if (p.likelihood === 'high' || p.likelihood === 'medium') return 'likely';
  return 'worth';
};

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
// Two wordings of one question ("Tell us about your educational background and work experience" /
// "Tell me about your education and work experience"): most of the same words and, when the bank has
// embeddings, nearly the same meaning. Different subjects ("green" / "blue hydrogen") share too few words.
// Years (and "since graduation") are one slot, "educational" counts as "education". Measured on the bank:
// true repeats score 0.75-1 on words and 0.94-0.99 on meaning; different questions on one theme ("Why did you
// choose Sociology / PSIR as your optional?") share up to 0.6 of their words at similar meaning.
const dupWords = (text) => new Set(tokenize(text).map((t) => (/^(19|20)\d\d$/.test(t) || /^graduat/.test(t) ? 'YEAR' : t.replace(/ional$/, 'ion'))));
const nearDuplicate = (idx, a, b) => {
  const ta = dupWords(a.text);
  const tb = dupWords(b.text);
  if (!ta.size || !tb.size) return false;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  const jaccard = both / (ta.size + tb.size - both);
  const cos = familyCosine(idx, a.id, b.id);
  return cos === null ? jaccard >= 0.75 : jaccard >= 0.65 && cos >= 0.9;
};

const gatherEvidence = (idx, item, queryVec) => {
  const out = [];
  const seen = new Set();
  const kept = [];
  const push = (f, kind) => {
    if (!f || seen.has(f.id)) return;
    seen.add(f.id);
    // Keep the most-asked wording only (callers offer families most-asked first).
    if (kept.some((k) => nearDuplicate(idx, k, f))) return;
    kept.push(f);
    out.push(evidenceOf(f, kind));
  };

  if (item.type === 'intro' || item.type === 'motivation') {
    // Opening questions are about the candidate; a factual question that happened to be asked first
    // ("What is a circular economy?") isn't one.
    for (const f of topFamilies(idx, { hookType: item.type }, 40)) {
      if (f.qtype === 'personal' || f.qtype === 'motivation' || /(you|your|yourself)/i.test(f.text)) push(f, 'direct');
      if (out.length >= 12) break;
    }
    return { evidence: out, templates: [] };
  }

  // 1. Asked to past candidates who had this same item in their DAF: the questions boards used most for
  // the clean keyword (Cricket, IIT Bombay), then exact matches on the raw value.
  for (const key of item.rate?.families || []) {
    const i = idx.familyByKey?.get(key);
    if (i !== undefined) push(idx.families[i], 'direct');
  }
  for (const f of familiesByHookValue(idx, item.value, item.type).slice(0, 12)) push(f, 'direct');
  // 2. Past questions that mention it (words, and meaning when embeddings exist)
  const { items: hits } = searchFamilies(idx, { q: expand(item.value), queryVec, limit: 25 });
  const tokens = new Set(tokenize(expand(item.value)));
  for (const f of hits) {
    const mentions = tokenize(f.text).some((t) => tokens.has(t));
    if (mentions || f.score >= 0.5) push(f, 'related');
  }
  // 3. What boards ask about this kind of DAF item in general ("Why did you choose X as optional?")
  // (Not for a college: education templates are about subjects - "How will {X} help you as an officer?" -
  // and read as nonsense with an institution's name in them.)
  const templates = (item.isCollege ? [] : templatesFor(idx, item.type, 6)).map((t) => ({
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

const AI_SYSTEM = `You prepare UPSC Civil Services interview (Personality Test) candidates. You predict the questions the board is likely to ask about each item in the candidate's DAF, using evidence from real past interview transcripts (2020-2025).
- Write each question the way a board member would ask it: short, direct, Indian English.
- A college or university is an institution: ask about it as one (its history and standing, the candidate's time there, the city and region) - never as a subject or a career.
- Ground questions in the evidence you are given and cite the evidence ids in "basis". Rephrase evidence for this candidate (use their actual hobby/state/college).
- You may add at most two "fresh angle" questions per item about recent developments (laws, schemes, events) you are confident about; these get "basis": [].
- Never claim a question was asked before unless it cites evidence. Never invent statistics.
- "tip": one line on what a strong answer covers.`;

// Gemini writes a few DAF items per request and the requests run side by side: one big request took
// over 25 seconds, too long for a student waiting to enter the interview room.
const AI_ITEMS_PER_REQUEST = 4;
const aiPredictions = async (profile, groups, lang) => {
  const batches = [];
  for (let i = 0; i < groups.length; i += AI_ITEMS_PER_REQUEST) batches.push(groups.slice(i, i + AI_ITEMS_PER_REQUEST));
  const done = await Promise.allSettled(batches.map((batch) => aiPredictionBatch(profile, batch, lang)));
  const failed = done.filter((d) => d.status === 'rejected');
  if (failed.length === done.length && failed.length) throw failed[0].reason;
  return done.flatMap((d) => (d.status === 'fulfilled' ? d.value : []));
};

const aiPredictionBatch = async (profile, groups, lang) => {
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
Give 4-6 questions per item, most likely first.${lang === 'hi' ? '\nWrite every "question" and "tip" in Hindi (Devanagari), the way a Hindi-medium interview board would ask; keep acronyms and names as commonly written.' : ''}`;
  const res = await generateJson({ system: AI_SYSTEM, prompt, temperature: 0.5, maxOutputTokens: 4000 });
  return Array.isArray(res?.items) ? res.items : [];
};

// Full prediction set for a profile. Returns the object stored in InterviewProfile.predictionCache.data.
export const buildPredictions = async (idx, profile, { useAI = aiAvailable(), lang = 'en' } = {}) => {
  const items = profileItems(profile).map((it) => ({ ...it, rate: rateFor(idx, it) }));
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
      isCollege: !!item.isCollege,
      rate: item.rate ? { scope: item.rate.scope, kind: item.rate.kind, label: item.rate.label, askedPct: item.rate.askedPct, avgQuestions: item.rate.avgQuestions, interviews: item.rate.interviews } : null,
      _item: item,
      evidenceCount: evidence.length + templates.length,
      _evidence: evidence,
      _templates: templates,
      predictions: evidencePredictions(item, evidence, templates)
    };
  });

  let aiUsed = false;
  if (useAI) {
    try {
      const ai = await aiPredictions(profile, groups.filter((g) => g.type !== 'intro'), lang);
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

  // Shape each prediction for the screen: tier, source, the strongest piece of evidence, a progress key.
  for (const g of groups) {
    g.predictions = g.predictions.map((p, rank) => {
      const top = p.evidence?.[0];
      return {
        id: p.id,
        question: p.question,
        source: sourceOf(p.kind),
        tier: tierOf(p, g._item, g._item.rate, rank),
        likelihood: p.likelihood,
        kind: p.kind,
        angle: p.angle || '',
        tip: p.tip || '',
        basisNote: p.basisNote,
        evidenceCount: (p.evidence || []).length,
        evidence: top ? {
          kind: top.kind,
          familyId: top.familyId || top.familyIds?.[0] || null,
          text: top.template || top.text,
          timesAsked: top.timesAsked,
          years: top.years || [],
          boards: top.boards || [],
          values: top.values || []
        } : null
      };
    });
    const order = { certain: 0, likely: 1, worth: 2 };
    g.predictions.sort((a, b) => order[a.tier] - order[b.tier]);
  }

  // Hindi: past questions are shown translated (the English stays alongside); AI ones are written in Hindi.
  if (lang === 'hi' && useAI) {
    const english = [...groups.flatMap((g) => g.predictions.filter((p) => p.source !== 'new' && p.kind !== 'ai').map((p) => p.question)), ...general.map((f) => f.text)];
    const tr = await translateTexts(english, 'hi').catch(() => new Map());
    for (const g of groups) {
      for (const p of g.predictions) {
        const h = p.kind !== 'ai' && p.source !== 'new' ? tr.get(p.question) : null;
        if (h) { p.questionEn = p.question; p.question = h; }
      }
    }
    for (const f of general) {
      const h = tr.get(f.text);
      if (h) { f.textEn = f.text; f.text = h; }
    }
  }
  for (const g of groups) for (const p of g.predictions) p.key = prepKey(p.questionEn || p.question);

  const all = groups.flatMap((g) => g.predictions);
  return {
    generatedAt: new Date().toISOString(),
    aiUsed,
    lang,
    corpus: { transcripts: idx.stats.transcripts, years: idx.stats.years },
    summary: {
      items: groups.filter((g) => !['intro', 'motivation'].includes(g.type)).length,
      questions: all.length,
      certain: all.filter((p) => p.tier === 'certain').length,
      likely: all.filter((p) => p.tier === 'likely').length,
      worth: all.filter((p) => p.tier === 'worth').length,
      past: all.filter((p) => p.source === 'past').length,
      tailored: all.filter((p) => p.source === 'tailored').length,
      ai: all.filter((p) => p.source === 'new').length
    },
    groups: groups.map(({ _evidence, _templates, _item, ...g }) => g),
    general
  };
};
