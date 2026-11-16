// Current-topic notes. An admin names a topic and gives the pages (or pastes the text) to write from; Gemini
// reads them and writes one note in English and Hindi: why it is in the news, short notes, the questions a
// board may ask with model answers, and which candidates are most likely to be asked. The admin reviews the
// draft and publishes it for every student.
import { generateFromUrls, parseJsonReply } from './gemini.js';

export const CATEGORIES = ['polity', 'economy', 'international', 'environment', 'science', 'society', 'security', 'governance', 'culture', 'sports'];
export const NOTE_QTYPES = ['factual', 'analytical', 'opinion', 'situational', 'daf'];
export const MAX_URLS = 5;
export const MAX_TEXT = 40000;
export const MIN_TEXT = 200;

const str = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (x, n, len) => (Array.isArray(x) ? x.map((v) => str(v, len)).filter(Boolean).slice(0, n) : []);
// Comparable form of a link: no scheme, "www.", trailing slash or fragment, query parameters in order.
export const sameUrlKey = (u) => {
  try {
    const x = new URL(u);
    const params = [...x.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}?${params}`.toLowerCase();
  } catch {
    return String(u || '').trim().toLowerCase();
  }
};
export const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// Up to MAX_URLS distinct http(s) links from a list or a block of text (one per line is what the form sends).
export const cleanUrls = (raw) => {
  const items = Array.isArray(raw) ? raw : String(raw || '').split(/\s+/);
  const out = [];
  for (const item of items) {
    try {
      const url = new URL(String(item || '').trim());
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) continue;
      out.push(url.toString());
    } catch { /* not a link */ }
  }
  return [...new Set(out)].slice(0, MAX_URLS);
};

// One language of a note, trimmed to the shape the screens and the PDF expect. null when unusable.
export const sanitizeLangNote = (n) => {
  if (!n || typeof n !== 'object') return null;
  const sections = (Array.isArray(n.sections) ? n.sections : [])
    .map((s) => ({ heading: str(s?.heading, 60), points: list(s?.points, 8, 400) }))
    .filter((s) => s.heading && s.points.length)
    .slice(0, 8);
  const questions = (Array.isArray(n.questions) ? n.questions : [])
    .map((q) => ({ q: str(q?.q, 300), type: NOTE_QTYPES.includes(q?.type) ? q.type : 'analytical', answer: str(q?.answer, 1600) }))
    .filter((q) => q.q)
    .slice(0, 10);
  const note = { title: str(n.title, 120), why: str(n.why, 600), sections, questions, likelyFor: list(n.likelyFor, 6, 80), keywords: list(n.keywords, 12, 60) };
  return note.title && sections.length ? note : null;
};

export const cleanTags = (tags) => [...new Set(list(tags, 16, 40).map((t) => t.toLowerCase()))];

// "one-nation-one-election-2026-11": readable, stable, and different for a later note on the same topic.
export const noteSlug = (title, date = new Date()) => {
  const base = String(title || 'note').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${base || 'note'}-${date.toISOString().slice(0, 7)}`;
};

// ------------------------------------------------------------------ who a note is "for"

// Words in a DAF that stand for a background a note may be tagged with ("engineering" <- "B.Tech").
const TAG_SYNONYMS = {
  engineering: ['engineer', 'b.tech', 'btech', 'b. tech', 'b.e.', 'm.tech', 'mtech', 'iit ', 'nit '],
  medicine: ['mbbs', 'medical', 'medicine', 'doctor', 'aiims', 'bds', 'nursing', 'pharma'],
  law: ['llb', 'll.b', 'law', 'nlu', 'advocate', 'legal'],
  economics: ['economics', 'economist'],
  agriculture: ['agricultur', 'agri', 'farming', 'horticultur', 'veterinar', 'dairy'],
  banking: ['bank', 'sbi', 'rbi', 'nabard'],
  finance: ['finance', 'chartered accountant', 'commerce', 'b.com', 'accountant', 'audit'],
  management: ['mba', 'management', 'pgdm', 'iim'],
  it: ['software', 'computer', 'information technology', 'developer', 'data scien', 'tcs', 'infosys', 'wipro'],
  teaching: ['teacher', 'teaching', 'lecturer', 'professor', 'b.ed', 'tutor'],
  defence: ['army', 'navy', 'air force', 'defence', 'ncc', 'military'],
  police: ['police', 'capf', 'crpf', 'bsf'],
  journalism: ['journalis', 'media', 'reporter'],
  sports: ['cricket', 'football', 'badminton', 'athlet', 'sports', 'kabaddi', 'hockey', 'chess', 'yoga'],
  environment: ['environment', 'forestry', 'ecology', 'wildlife', 'climate'],
  'political science': ['political science', 'psir', 'politics'],
  'public administration': ['public administration', 'pub ad']
};
export const TAG_VOCABULARY = Object.keys(TAG_SYNONYMS);

export const profileText = (p) => {
  if (!p) return '';
  const parts = [
    p.optional, p.homeState, p.homeDistrict, p.hometown,
    ...(p.education || []).flatMap((e) => [e?.degree, e?.discipline, e?.institution]),
    ...(p.work || []).flatMap((w) => [w?.role, w?.organization]),
    ...(p.hobbies || []), ...(p.achievements || []), ...(p.servicePreference || []), ...(p.languages || [])
  ];
  return ` ${parts.filter(Boolean).join(' | ').toLowerCase()} `;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The note's tags that this DAF matches ([] = not especially for this student).
export const matchTags = (tags, text) => {
  if (!text || !text.trim()) return [];
  return (tags || []).filter((tag) => {
    const words = TAG_SYNONYMS[tag] || [];
    if (words.some((w) => text.includes(w))) return true;
    return tag.length >= 4 && new RegExp(`\\b${escapeRe(tag)}`, 'i').test(text);
  });
};

// ------------------------------------------------------------------ writing a note

const SYSTEM = `You write current-affairs briefs for candidates preparing for the UPSC Civil Services interview (Personality Test). You are accurate, neutral and concise, like a senior mentor's handout. You never invent facts, figures, dates or quotes.`;

const promptFor = ({ topic, urls, text, today }) => `Topic: "${topic}"
Today's date: ${today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.
${urls.length ? `Read these pages; they are your sources for anything recent:\n${urls.map((u) => `- ${u}`).join('\n')}\n` : ''}${text ? `Source text supplied by the editor:\n"""\n${text}\n"""\n` : ''}
Write an interview-preparation note on this topic. Return only JSON:
{"category":"one of: ${CATEGORIES.join(', ')}",
"tags":["6-12 lowercase words for the candidate backgrounds this topic matters most to - prefer these where they fit: ${TAG_VOCABULARY.join(', ')}; also optional subjects, Indian state names and hobbies"],
"sourceTitles":["a short title for each page you read, in the order the pages are listed"],
"en":NOTE,"hi":NOTE}
NOTE = {"title":"headline in sentence case, at most 9 words",
"why":"why it is in the news now, 1-2 sentences, with the month and year",
"sections":[{"heading":"Background","points":[]},{"heading":"Key facts","points":[]},{"heading":"In favour","points":[]},{"heading":"Concerns","points":[]},{"heading":"Way forward","points":[]}],
"questions":[{"q":"","type":"factual|analytical|opinion|situational|daf","answer":""}],
"likelyFor":["2-4 short descriptions of candidates likely to be asked, e.g. 'Economics optional', 'From Punjab', 'Engineers'"],
"keywords":["5-8 terms worth knowing"]}
Rules:
- 3-5 points per section, each under 30 words. Facts first, no filler.
- 6 questions a board could ask, mixing the types, with at least one "daf" question put to a particular background (e.g. "As an engineer, ..."). Each answer: 80-120 words, first person, balanced, ending with a way forward.
- Recent facts (dates, numbers, decisions, names) only from the sources. Background may use well-established knowledge. If you are unsure of a number or a date, leave it out.
- Neutral: give the government's stated position and the main criticisms fairly, without party-political language.
- "hi" is the same note in natural Hindi (Devanagari) as written for Hindi-medium UPSC aspirants; keep acronyms (GDP, RBI) and proper names as Hindi media write them. Hindi headings: पृष्ठभूमि, मुख्य तथ्य, पक्ष में, चिंताएँ, आगे की राह.`;

// topic: what the note is about; urls: pages Gemini should read; text: pasted source text. Throws with a
// message an admin can act on when the sources could not be read or the reply was unusable.
export const generateNote = async ({ topic, urls = [], text = '', today = new Date() }) => {
  const reply = await generateFromUrls({
    system: SYSTEM,
    prompt: promptFor({ topic: str(topic, 140), urls, text: String(text || '').slice(0, MAX_TEXT), today }),
    urls,
    temperature: 0.4,
    maxOutputTokens: 24000,
    thinking: 'low',
    retries: 1
  });
  // Which links Gemini read. It may report a page under a slightly different address (redirects,
  // reordered parameters): an unmatched link still counts as read when Gemini read as many pages on its
  // site as were given there.
  const okUrls = reply.read.filter((r) => r.ok).map((r) => r.url);
  const okKeys = new Set(okUrls.map(sameUrlKey));
  const okPerHost = new Map();
  for (const u of okUrls) okPerHost.set(hostOf(u), (okPerHost.get(hostOf(u)) || 0) + 1);
  const givenPerHost = new Map();
  for (const u of urls) givenPerHost.set(hostOf(u), (givenPerHost.get(hostOf(u)) || 0) + 1);
  const sources = urls.map((url) => ({ url, ok: okKeys.has(sameUrlKey(url)) || (okPerHost.get(hostOf(url)) || 0) >= givenPerHost.get(hostOf(url)) }));
  if (urls.length && !okUrls.length && !text) {
    throw new Error('Gemini could not open any of those links (they may be behind a paywall or block readers). Paste the article text instead.');
  }
  let raw;
  try {
    raw = parseJsonReply(reply.text);
  } catch {
    throw new Error(reply.finishReason === 'MAX_TOKENS' ? 'The note came out too long and was cut off. Try a narrower topic.' : 'The AI reply was not in the expected format. Try again.');
  }
  const en = sanitizeLangNote(raw?.en);
  const hi = sanitizeLangNote(raw?.hi);
  if (!en || !hi) throw new Error(`The AI reply had no usable ${en ? 'Hindi' : 'English'} note. Try again.`);
  const titles = list(raw?.sourceTitles, MAX_URLS, 140);
  return {
    category: CATEGORIES.includes(raw?.category) ? raw.category : 'governance',
    tags: cleanTags(raw?.tags),
    en,
    hi,
    sources: sources.map((s, i) => ({ ...s, title: titles[i] || hostOf(s.url) })).filter((s) => s.ok).map(({ url, title }) => ({ url, title })),
    unread: sources.filter((s) => !s.ok).map((s) => s.url),
    usage: reply.usage,
    read: reply.read
  };
};
