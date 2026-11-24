// Predicted interview questions for one student's DAF, each backed by evidence from past transcripts.
// The corpus search is cheap and broad (it only finds raw material); Gemini then writes every question the
// student sees - about 95 in all, each worded for their DAF, with likely follow-ups - citing the evidence it
// used, which is where the likelihood shown comes from. Raw search results are never shown as they are; when
// AI is off, only real questions asked to candidates with the same DAF entry are, and only if they name
// nothing outside this DAF.
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

// Bump when the prediction logic changes, so saved predictions are rebuilt. (6: every question written by AI
// for the DAF, ~95 per student, with follow-ups; raw search results no longer shown.)
export const PREDICTOR_VERSION = 6;
export const PREVIOUS_PREDICTOR_VERSION = 5;

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

export const profileHash = (profile, idx, v = PREDICTOR_VERSION) => crypto
  .createHash('sha1')
  .update(JSON.stringify({ v, items: profileItems(profile).map((i) => i.key), fb: profile.familyBackground || '', notes: profile.otherNotes || '', n: idx.stats.families, t: idx.templates.length, sem: idx.stats.semantic }))
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

// ---- What reaches the student ----
// About 95 predicted questions per student: OPENING_COUNT each for the opening and "why civil services", the
// rest shared across the DAF items (between 4 and 15 each).
const TARGET_QUESTIONS = 95;
const OPENING_COUNT = 6;
export const questionsPerItem = (itemCount) => Math.max(4, Math.min(15, Math.ceil((TARGET_QUESTIONS - 2 * OPENING_COUNT) / Math.max(1, itemCount))));
const isOpening = (g) => g.type === 'intro' || g.type === 'motivation';

// The candidate's DAF as one lowercase text, to check a question names nothing that isn't in it.
export const dafTextOf = (profile) => normalizeText(JSON.stringify([profile.homeState, profile.homeDistrict, profile.hometown, profile.education, profile.work, profile.optional, profile.hobbies, profile.achievements, profile.servicePreference, profile.familyBackground, profile.languages, profile.otherNotes]));

// Names a past question carries from the candidate it was asked to ("You studied Sanskrit in class 10th",
// "How is Fergusson College doing now?"): capitalised words that aren't in this DAF and aren't national or
// common terms. (Acronyms like GST or NEP count as national terms.)
const NATIONAL = new Set(`india indian indians bharat delhi new parliament constitution supreme court high prime minister president vice
governor chief government union lok sabha rajya niti aayog rbi reserve bank article act mission scheme yojana policy national
international world covid olympic olympics games asian commonwealth cup english hindi god mahatma gandhi nehru ambedkar sardar
patel civil services service board sir madam district collector magistrate officer army navy air force election commission
china pakistan america russia independence republic day budget digital make startup smart city cities swachh atmanirbhar
viksit amrit kaal`.split(/\s+/));
export const foreignNames = (text, dafText) => {
  const out = [];
  const re = /\b([A-Z][A-Za-z'-]{2,})\b/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const word = m[1];
    if (/(^|[.?!:;]\s+)$/.test(text.slice(0, m.index))) continue; // a capital starting a sentence
    if (/^[A-Z]{2,6}$/.test(word)) continue;
    const w = word.toLowerCase();
    if (NATIONAL.has(w) || dafText.includes(w)) continue;
    out.push(word);
  }
  return out;
};

// Questions about a job, for a candidate whose DAF lists no work experience.
const JOB_QUESTION = /\b(job|jobs|company|employer|corporate|resign\w*|quit\w*|salary|package|workplace|colleagues)\b/i;
const hasWork = (profile) => (profile.work || []).some((w) => w && (w.role || w.organization));

// A real past question shown as it was asked (when AI can't write the questions): only one asked to
// candidates with this same DAF entry (or a usual opener), naming nothing outside this DAF.
export const fitsAsAsked = (question, profile, dafText = dafTextOf(profile)) => !foreignNames(question, dafText).length && (hasWork(profile) || !JOB_QUESTION.test(question));

export const AI_SYSTEM = `You prepare UPSC Civil Services interview (Personality Test) candidates. For each item in the candidate's DAF, write the questions an interview board is most likely to ask THIS candidate, using evidence from real past interview transcripts (2020-2025).

Who the question is for
- Every question must be about this candidate and this DAF item, worded for them (their actual state, district, college, subjects, hobby, achievement).
- Keep each question on its own item: a question under a sports achievement is about that sport, the achievement or sports policy - not about other parts of the DAF (home district, agriculture, religion, other hobbies) unless the link is natural and specific.
- If little evidence fits an item, write from the item itself (what the candidate did, the activity, related national issues) rather than stretching unrelated evidence.
- Never mention a place, institution, language, subject, sport, job, person or event that is not in the candidate's DAF, unless it is a well-known national topic tied to the item (a law, scheme, national body or current event).
- If the DAF lists no work experience, never ask about a job, workplace or leaving a job.
- Don't assume what the DAF doesn't say (someone who watches cricket analysis may not play cricket).

Using the evidence
- Evidence marked "direct" was asked to past candidates with this same DAF entry: it is the strongest signal. Use every direct question that fits, rewritten for this candidate, before anything else.
- Other evidence was matched loosely and may be about another topic. Use it only if it genuinely fits this item; otherwise ignore it and don't cite it.
- Evidence was asked to other candidates: never carry over their names, places, languages or facts.
- "template" evidence is a common question shape: use it only when it fits the item ("What position do you play?" fits a sport the candidate plays, not travelling or watching videos).
- Cite the ids of the evidence each question is based on in "basis". Never claim a question was asked before unless it cites evidence. Never invent statistics.

Writing
- Write each question the way a board member would ask it: short, natural, Indian English - one question, not two.
- Refer to long, list-like or cut-off DAF entries naturally ("your commerce subjects", "your science stream in Class 12", "your U-19 football medal"); never paste the entry word for word.
- A college or university is an institution: ask about it as one (its history and standing, the candidate's time there, the city and region) - never as a subject or a career.
- Opening and "why civil services" items: keep the board's usual openers, worded for this candidate's background (degree, subjects, work or no work, home state).
- No two questions should ask the same thing, within an item or across items.
- At most two "fresh angle" questions per item about recent developments you are confident about; these get "basis": [].
- "tip": one line on what a strong answer covers.
- "followUps": two short follow-up questions the board would likely ask next, given this candidate's DAF.`;

// The request for a few DAF items. Each item says how many questions to write ("count").
export const predictionPrompt = (profile, groups, lang) => {
  const payload = groups.map((g) => ({
    item: g.key,
    area: HOOK_TYPES[g.type] || g.type,
    value: g.value || g.label,
    count: g._count,
    evidence: [
      ...g._evidence.slice(0, 14).map((e, i) => ({ id: `${g.key}|e${i}`, text: e.text, timesAsked: e.timesAsked, years: yearsLabel(e.years), match: e.kind })),
      ...g._templates.slice(0, 4).map((t, i) => ({ id: `${g.key}|t${i}`, text: t.template, timesAsked: t.timesAsked, years: yearsLabel(t.years), match: 'template', askedFor: t.values.join(', ') }))
    ]
  }));
  return `Candidate DAF summary:
${JSON.stringify({
    homeState: profile.homeState, homeDistrict: profile.homeDistrict, hometown: profile.hometown,
    education: profile.education, work: profile.work, optional: profile.optional, hobbies: profile.hobbies,
    achievements: profile.achievements, servicePreference: profile.servicePreference, familyBackground: profile.familyBackground,
    languages: profile.languages, otherNotes: String(profile.otherNotes || '').slice(0, 600) || undefined
  })}${hasWork(profile) ? '' : '\nWork experience: none.'}

DAF items with evidence from past transcripts:
${JSON.stringify(payload)}

Return JSON: {"items":[{"item":"<item key>","questions":[{"question":"","basis":["<evidence id>"],"angle":"daf-depth|current-affairs|opinion|situational|factual","tip":"","followUps":["",""]}]}]}
For each item write exactly its "count" questions, most likely first.${lang === 'hi' ? '\nWrite every "question", "tip" and follow-up in Hindi (Devanagari), the way a Hindi-medium interview board would ask; keep acronyms and names as commonly written.' : ''}`;
};

// Gemini writes about QUESTIONS_PER_REQUEST questions per request and the requests run side by side (one
// big request is too slow for a student waiting on the screen).
const QUESTIONS_PER_REQUEST = 24;
const aiPredictions = async (profile, groups, lang) => {
  const batches = [];
  let cur = [];
  let n = 0;
  for (const g of groups) {
    if (cur.length && n + g._count > QUESTIONS_PER_REQUEST) { batches.push(cur); cur = []; n = 0; }
    cur.push(g);
    n += g._count;
  }
  if (cur.length) batches.push(cur);
  const done = await Promise.allSettled(batches.map((batch) => aiPredictionBatch(profile, batch, lang)));
  const failed = done.filter((d) => d.status === 'rejected');
  if (failed.length === done.length && failed.length) throw failed[0].reason;
  return done.flatMap((d) => (d.status === 'fulfilled' ? d.value : []));
};

const aiPredictionBatch = async (profile, groups, lang) => {
  const res = await generateJson({ system: AI_SYSTEM, prompt: predictionPrompt(profile, groups, lang), temperature: 0.5, maxOutputTokens: 9000 });
  return Array.isArray(res?.items) ? res.items : [];
};

const summarize = (groups) => {
  const all = groups.flatMap((g) => g.predictions);
  return {
    items: groups.filter((g) => !isOpening(g)).length,
    questions: all.length,
    certain: all.filter((p) => p.tier === 'certain').length,
    likely: all.filter((p) => p.tier === 'likely').length,
    worth: all.filter((p) => p.tier === 'worth').length,
    past: all.filter((p) => p.source === 'past').length,
    tailored: all.filter((p) => p.source === 'tailored').length,
    ai: all.filter((p) => p.source === 'new').length
  };
};

// Predictions saved by the previous version, shown while AI is off (instead of rebuilding a weaker set):
// for items the AI wrote, only its questions; otherwise only real same-entry questions that fit this DAF.
export const tidyLegacy = (data, profile) => {
  const dafText = dafTextOf(profile);
  const groups = (data.groups || []).map((g) => {
    const byAi = (g.predictions || []).some((p) => p.kind === 'ai' || p.kind === 'new');
    const predictions = (g.predictions || []).filter((p) => (byAi
      ? p.kind === 'ai' || p.kind === 'new'
      : p.kind === 'direct' && fitsAsAsked(p.questionEn || p.question, profile, dafText)));
    return { ...g, predictions };
  });
  return { ...data, groups, summary: summarize(groups) };
};

// Full prediction set for a profile. Returns the object stored in InterviewProfile.predictionCache.data.
// keep: Map of item key -> predictions the student has already worked on (kept as they are, first);
// ai: the function that writes the questions (tests pass their own).
// embed: false skips the query embeddings (a Gemini call), so the evidence depends on the corpus alone.
export const buildPredictions = async (idx, profile, { useAI = aiAvailable(), lang = 'en', keep = null, ai = aiPredictions, embed = true } = {}) => {
  const items = profileItems(profile).map((it) => ({ ...it, rate: rateFor(idx, it) }));
  const perItem = questionsPerItem(items.filter((it) => !isOpening(it)).length);
  const dafText = dafTextOf(profile);
  let queryVecs = null;
  if (useAI && embed && idx.vectors) {
    try {
      const terms = items.map((it) => expand(it.value || it.label));
      queryVecs = await embedTexts(terms, { taskType: 'RETRIEVAL_QUERY' });
    } catch { queryVecs = null; }
  }

  const groups = items.map((item, i) => {
    const { evidence, templates } = gatherEvidence(idx, item, queryVecs?.[i] || null);
    const count = isOpening(item) ? OPENING_COUNT : perItem;
    // Without AI: only real questions asked to candidates with this same entry (or usual openers) that fit
    // this DAF. The rest of the evidence is raw material for the AI only.
    const asAsked = evidence.filter((e) => e.kind === 'direct' && fitsAsAsked(e.text, profile, dafText));
    return {
      _count: count,
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
      predictions: evidencePredictions(item, asAsked, [], count)
    };
  });

  let aiUsed = false;
  if (useAI) {
    try {
      const written = await ai(profile, groups, lang);
      for (const entry of written) {
        const g = groups.find((x) => x.key === entry.item);
        if (!g || !Array.isArray(entry.questions)) continue;
        const lookup = (id) => {
          const [, ref] = String(id).split('|');
          if (!ref) return null;
          const n = Number(ref.slice(1));
          return ref[0] === 'e' ? g._evidence[n] : ref[0] === 't' ? g._templates[n] : null;
        };
        const preds = entry.questions.filter((q) => q?.question).slice(0, g._count + 2).map((q, i) => {
          const evidence = (q.basis || []).map(lookup).filter(Boolean);
          const top = evidence[0];
          return {
            id: `${g.key}#ai${i}`,
            question: String(q.question).slice(0, 300),
            kind: evidence.length ? 'ai' : 'new',
            angle: q.angle || '',
            tip: String(q.tip || '').slice(0, 240),
            followUps: (Array.isArray(q.followUps) ? q.followUps : []).map((f) => String(f || '').trim().slice(0, 200)).filter(Boolean).slice(0, 3),
            evidence,
            likelihood: likelihoodFrom(evidence),
            basisNote: top ? basisNote(top.kind, top, g) : 'New angle — not seen in past transcripts',
            score: 0
          };
        });
        // Only what the AI wrote for this student; the evidence it used shows as "asked in N interviews".
        if (preds.length) {
          g.predictions = preds;
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
        followUps: p.followUps || [],
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

  // Questions the student already worked on stay exactly as they were, first in their item.
  for (const g of groups) {
    const kept = keep?.get(g.key) || [];
    if (!kept.length) continue;
    const keys = new Set(kept.map((p) => p.key));
    g.predictions = [...kept.map((p, i) => ({ ...p, id: `${g.key}#kept${i}`, kept: true })), ...g.predictions.filter((p) => !keys.has(p.key))];
  }

  return {
    generatedAt: new Date().toISOString(),
    aiUsed,
    lang,
    corpus: { transcripts: idx.stats.transcripts, years: idx.stats.years },
    summary: summarize(groups),
    groups: groups.map(({ _evidence, _templates, _item, _count, ...g }) => g),
    general
  };
};
