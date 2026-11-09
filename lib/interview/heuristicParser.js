// No-AI parser for the community interview-transcript compilations (one PDF per year, already turned into
// page texts by scripts/interview/extract_pages.py). It splits a year into transcripts, reads each
// transcript's profile block (board, date, optional, hobbies...) and its questions grouped by who asked.
//
// The compilations are hand-typed by hundreds of people, so this is best-effort: the Gemini parser
// (scripts/interview/pipeline.mjs parse --engine gemini) is the accurate one, and it uses this parser's
// transcript boundaries to cut the text into chunks.
import { canonicalBoard, canonicalOptional, canonicalState, stateMentions, splitList, uniq } from './text.js';

// ------------------------------------------------------------------ line clean-up

const NOISE_LINE = [
  /^\d{1,4}$/, // page numbers
  /^@?cse_?ptt\s*20\d\d$/i,
  /^interview transcripts?\s*(cse\s*)?(20\d\d)?(\s*session)?$/i,
  /^https?:\/\/t\.me\/\S+$/i,
  /^@\w+$/,
  /^[\p{P}\p{S}\s]+$/u // lines of only punctuation / emoji / arrows
];

// The 2024 compilation copies Telegram posts; each post (one transcript) starts with this header.
const POST_HEADER = /^interview transcripts?\s*\(cspt[-\s]*20\d\d\)/i;

// The 2021 compilation lost its punctuation in an encoding mix-up: ':' became '¦', '/' '²', and
// parentheses '¬ ... soft-hyphen'. Only undone where the file shows the pattern, so a real soft hyphen
// elsewhere isn't turned into ')'.
const repairEncoding = (text) =>
  text.replace(/¦/g, ':').replace(/²/g, '/').replace(/¬/g, '(').replace(/­/g, ')').replace(/ª/g, "'");

// ------------------------------------------------------------------ line classifiers

const SEP = '[:\\-–—|=>]';

// key regex source -> profile field. 'strong' keys count as a profile line only when followed by a
// separator ("Name: X"); 'weak' keys also count without one when a neighbouring line is a profile line.
const HEADER_KEYS = [
  ['candidate from', 'home', 'weak'],
  ['date (?:and|&) (?:session|time)(?: of interview)?', 'date', 'weak'],
  ['(?:interview )?date(?: of (?:the )?interview| of pt)?', 'date', 'weak'],
  ['(?:interview )?(?:board|panel)(?: name| chair(?:man|person)?)?', 'board', 'weak'],
  ['optional(?: subject)?', 'optional', 'weak'],
  ['daf(?: details| keywords?| key ?words| pointers| highlights| summary| profile)?', 'keywords', 'weak'],
  ['key ?words?(?: from daf| in daf)?', 'keywords', 'weak'],
  ['hobb(?:y|ies)(?: (?:and|&|/) interests?)?', 'hobbies', 'weak'],
  ['interests?', 'hobbies', 'strong'],
  ['sports?', 'hobbies', 'strong'],
  ['grad(?:uation)?(?: (?:college|stream|year|details))?', 'education', 'weak'],
  ['post ?grad(?:uation)?', 'education', 'weak'],
  ['college(?: name)?', 'education', 'weak'],
  ['educational? (?:background|qualification|details)', 'education', 'weak'],
  ['education', 'education', 'strong'],
  ['(?:academic )?qualifications?', 'education', 'weak'],
  ['academics?', 'education', 'strong'],
  ['profession(?: \\(if any\\))?', 'work', 'weak'],
  ['work ?ex(?:perience|p)?', 'work', 'weak'],
  ['job(?: profile)?', 'work', 'strong'],
  ['occupation', 'work', 'strong'],
  ['home ?state', 'home', 'weak'],
  ['home ?town', 'home', 'weak'],
  ['(?:native |home )?(?:place|district|state|city)', 'home', 'strong'],
  ['domicile', 'home', 'strong'],
  ['background', 'keywords', 'strong'],
  ['name', 'name', 'weak'],
  ['session', 'date', 'strong'],
  ['attempts?(?: no)?', 'attempt', 'strong'],
  ['service ?pref(?:erence)?s?', 'service', 'weak'],
  ['cadre ?pref(?:erence)?s?', 'service', 'strong'],
  ['achievements?', 'achievements', 'weak'],
  ['(?:extra ?curricular(?: activities)?|eca|positions? of responsibility|por)', 'achievements', 'weak'],
  ['(?:your )?experience(?: in (?:the )?interview)?', 'experience', 'strong'],
  ['(?:interview )?(?:duration|time(?: taken)?|length)', 'duration', 'strong'],
  ['(?:utility of )?mocks?(?: \\(if any\\))?', 'experience', 'strong'],
  ['roll ?(?:no|number)', 'name', 'strong'],
  ['gender', 'skip', 'strong'],
  ['age', 'skip', 'strong'],
  ['medium', 'skip', 'strong'],
  ['languages?', 'skip', 'strong']
].map(([src, field, strength]) => ({
  field,
  strength,
  withSep: new RegExp(`^[\\s*•●▪◦°·\\-–>#_]*(?:${src})\\s*${SEP}+\\s*(.*)$`, 'i'),
  bare: new RegExp(`^[\\s*•●▪◦°·\\-–>#_]*(?:${src})\\s+(\\S.*)$`, 'i')
}));

const QUESTIONISH_START = /^(what|why|how|who|whom|whose|which|where|when|is|are|was|were|do|does|did|can|could|should|would|will|shall|have|has|had|tell|explain|describe|discuss|elaborate|define|give|list|enumerate|differentiate|difference|compare|suggest|comment|justify|your|any|as an?|as the|if|suppose|imagine|according|so|then|but|and|also|whats|what's|hows|kya|kaise|kyun|kyu|aap|apne|name (a|any|some|few|the|two|three|five)|asked|question|questions|discussion|about|follow|counter|ok|okay|alright|now|after|in your|from your|at your)\b/i;

// One profile line -> { field, value } (or null). `neighbourIsHeader` lets weak keys through.
const matchHeader = (line, neighbourIsHeader = false) => {
  if (line.length > 220) return null;
  const hasQ = line.includes('?');
  for (const k of HEADER_KEYS) {
    const m = line.match(k.withSep);
    if (m && !(hasQ && m[1].length > 60)) return { field: k.field, value: m[1].trim() };
  }
  if (hasQ || line.length > 120) return null;
  for (const k of HEADER_KEYS) {
    if (k.strength !== 'weak') continue;
    const m = line.match(k.bare);
    if (m && (neighbourIsHeader || k.field === 'board' || k.field === 'optional')) {
      // "Board exams are pointless?" / "Name few rivers" are questions, not profile lines.
      if (QUESTIONISH_START.test(m[1]) && k.field !== 'board') continue;
      return { field: k.field, value: m[1].trim() };
    }
  }
  // "Satyavathi mam board" / "Dinesh Dasa Sir Board"
  const tail = line.match(/^[\s*•\-–]*([A-Za-z.' ]{3,40}?)\s+(?:sir|ma'?am|mam|madam|ji)?\s*(?:board|panel)\s*$/i);
  if (tail && !QUESTIONISH_START.test(tail[1])) return { field: 'board', value: tail[1].trim() };
  return null;
};

const SPEAKER = new RegExp(
  '^[\\s*_#>•\\-–—\\[(]*(?:\\d{1,2}[.)]\\s*)?' +
    '(?:' +
    '(chair\\s*(?:man|men|person|woman|lady|mam|sir)?|cm|ch|cp|c\\.m\\.?)' + // 1 chair
    '|(?:(?:m|member|mem|mbr)\\s*[-.#]?\\s*(\\d)(?!\\d)|(\\d)\\s*(?:st|nd|rd|th)\\s*(?:member|mem|m)\\b)' + // 2 member number ("M2", "2nd member")
    '|((?:lady|female|woman|male|gents?|senior|junior|another|second|first|third|fourth|last)\\s+member|(?:m|member)\\s*[-(]?\\s*(?:lady|male|female|woman|man|sir|ma\'?am|mam|madam)\\)?|member)' + // 3 member, no number
    ')' +
    "(?:\\s*[-(]?\\s*(?:sir|ma'?am|mam|madam|lady|male|female|woman|man|again|\\(.*?\\)))*" +
    '\\s*\\)?\\s*([:\\-–—|)\\].>]*)\\s*(.*)$',
  'i'
);

// Returns { asker, rest } when the line names who is asking ("M2 (lady):", "Chairman Sir -", "CM:").
const matchSpeaker = (line) => {
  if (line.length > 400) return null;
  const m = line.match(SPEAKER);
  if (!m) return null;
  const [, chair, numA, numB, noNum, sep, restRaw] = m;
  const num = numA || numB;
  let rest = (restRaw || '').trim();
  // "Member 1: Lady Member" / "M3 - (male, sir)" only describe who is speaking.
  if (/^[\s(]*(?:(?:lady|female|male|woman|man|gents?|senior|elderly|young|old|sir|ma'?am|mam|madam|again|member|from|left|right|side|ji)[\s,()\-:]*)+$/i.test(rest)) rest = '';
  const shortMarker = chair ? /^(cm|ch|cp|c\.m\.?)$/i.test(chair.trim()) : !!noNum && /^member$/i.test(noNum.trim());
  // "CM of Punjab is?" / "Member of parliament..." - a short marker must be followed by a separator.
  if (shortMarker && rest && !sep && /^[a-z]/.test(rest)) return null;
  if (!sep && rest && /^(of|is|was|has|in|and|asked|told|said|seemed|were|are)\b/i.test(rest) && !num) {
    // "Chairman asked about..." is still the chairman speaking; "Member of..." is not.
    if (!/^(asked|told|said)/i.test(rest)) return null;
  }
  let asker = 'member';
  if (chair) asker = 'chairman';
  else if (num) asker = Number(num) >= 1 && Number(num) <= 5 ? `m${num}` : 'member';
  return { asker, rest };
};

const BULLET = /^\s*(?:\(?\d{1,2}\s*[.):\-]\s*|\d{1,2}\s+(?=[A-Za-z(])|\d{1,2}(?=[A-Z][a-z])|[\-–—•●▪◦°*>→➢➤✓✔·○■□♦❖:⁠]+\s*|q\s*\d{0,2}\s*[.:)\-]\s*|ques(?:tion)?\s*\d{0,2}\s*[.:)\-]\s*|\(?[a-h]\)\s+)/i;

const stripBullets = (s) => {
  let out = s;
  let had = false;
  for (let i = 0; i < 3; i++) {
    const m = out.match(BULLET);
    if (!m || !m[0]) break;
    out = out.slice(m[0].length);
    had = true;
  }
  return { text: out.trim(), had };
};

const ANSWER_START = /^(ans(?:wer)?|my ans(?:wer)?|me|reply|response|i|i'm|im|i've|told|said|replied|answered|explained|mentioned|gave|spoke|talked|tried|could ?n'?t|couldnt|did ?n'?t know)\b[\s:.,\-–]?/i;
const REACTION_START = /^(he|she|they|sir|mam|ma'?am|board|chairman|member|everyone|all)\s+(smiled|nodded|laughed|seemed|was|were|looked|agreed|appreciated|said ok|said okay|was satisfied|wasn'?t satisfied|interrupted|cut me|moved on)/i;
const EPILOGUE_START = /^(experience|overall(?: experience)?|my experience|assessment(?: of the board)?|mocks?|mock interviews?|utility of mocks?|would recommend|won'?t recommend|recommend(?:ation)?s?|duration|time taken|total time|marks|score|result|final (?:thoughts?|words?)|tips?|advice|disclaimer|note|ps|p\.s|overall it was|it was a (?:cordial|good|nice|pleasant)|thank you (?:all|everyone|guys)|best of luck|all the (?:very )?best|wishing)\b/i;
const NOISE_ITEM = /\b(not able to (?:recall|remember)|unable to (?:recall|remember)|can'?t (?:recall|remember)|cannot (?:recall|remember)|don'?t recall|forgot the rest|few more (?:questions? )?(?:i )?(?:don'?t|can'?t|unable)|read (?:out )?(?:my |the )?daf|asked (?:me )?to (?:remove|sit|take off|be comfortable)|remove (?:your )?(?:mask|face ?shield)|wish you (?:all the best|good luck|a safe)|have a safe journey|(?:your |the )?interview is (?:over|done|complete)|you (?:may|can) (?:go|leave)|nice (?:talking|meeting) (?:to|with) you|thank you,? (?:that'?s all|we are done)|mock interviews?|mocks? (?:helped|were|was|are)|telegram|join the channel|best wishes|all the (?:very )?best to|thank you (?:all|everyone|guys)|(?:rest|other|remaining) (?:of the )?(?:questions )?(?:i )?(?:don'?t|do not|can'?t|cannot) (?:remember|recall)|don'?t remember (?:the )?(?:rest|other)|in no particular order|not in (?:the )?(?:same )?(?:order|sequence)|i (?:don'?t|do not) remember)/i;

const LABEL_LINE = /^(\d+\s*)?(follow[\s-]?ups?(?: questions?)?|counter questions?|questions?(?: asked)?(?: by (?:the )?(?:board|panel|members?))?|transcript|interview transcript|q ?& ?a|qna|interview questions?)\s*[:\-–]*\s*$/i;

// "20th April", "7 Jan FN", "Th April" (a date whose number was taken for a list number)
const DATE_LINE = /^(?:\d{1,2}\s*)?(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{2,4})?(?:\s*[,(]?\s*(?:fn|an|forenoon|afternoon|morning|evening)\)?)?$/i;

// PDF debris from the broken 2021 file: "Wh t i" / "t h l"
const isGarbageLine = (line) => {
  if (line.length > 24) return false;
  const words = line.split(' ');
  return words.length >= 2 && words.reduce((n, w) => n + w.length, 0) / words.length < 2.2;
};

const isQuestionText = (t) => {
  if (t.length < 6 || t.length > 420) return false;
  if (NOISE_ITEM.test(t)) return false;
  if (t.includes('?')) return true;
  return QUESTIONISH_START.test(t);
};

const FOLLOW_UP = /^(follow[\s-]?ups?|fu|counter(?: question)?s?|cross(?: question)?|then|so|but|and|also|further|after that|what else|anything else|why so|why not|how so)\b[\s:,.\-–]*/i;

// "1 You waited outside What did you do (I said...) 2 What did you learn 3 BRI - does it excite you"
// -> one line per question. Only consecutive numbers split, so "for 5 hours" and "3 lists" stay intact.
const splitInlineNumbered = (line) => {
  const re = /(?:^|\s)(\d{1,2})\s+(?=[A-Z(])/g;
  const cuts = [];
  let prevNum = null;
  let m;
  while ((m = re.exec(line))) {
    const n = Number(m[1]);
    if (prevNum === null || n === prevNum + 1) {
      cuts.push(m.index + (m[0].startsWith(' ') ? 1 : 0));
      prevNum = n;
    }
  }
  if (cuts.length < 2) return [line];
  const parts = [];
  if (cuts[0] > 0) parts.push(line.slice(0, cuts[0]));
  for (let i = 0; i < cuts.length; i++) parts.push(line.slice(cuts[i], cuts[i + 1]));
  return parts.map((p) => p.trim()).filter(Boolean);
};

// A trailing "(told them about X)" / "(Done but forgot Y)" is the candidate's answer, not the question.
const ANSWER_IN_PARENS = /\(\s*((?:i|me|told|said|explained|answered|replied|gave|done|agreed|disagreed|could ?n'?t|couldnt|did ?n'?t|didnt|was|he|she|they|sir|mam|ma'?am|board|chairman|member|long|discussion|spoke|mentioned|talked|tried|ans)\b[^()]{2,400})\)\s*$/i;

const cleanQuestion = (t) =>
  t
    .replace(/^[)\].,:;!|\-–—\s]+/, '')
    .replace(/^(follow[\s-]?ups?|fu|counter(?: question)?s?|cross(?: question)?)\s*[:\-–.)]+\s*/i, '')
    .replace(/^(q|ques|question)\s*[:.\-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([?,.])/g, '$1')
    .trim();

// ------------------------------------------------------------------ profile block

const mapProfile = (profileLines, epilogue) => {
  const p = {
    name: '', date: '', session: '', boardRaw: '', optionalRaw: '', homeRaw: '',
    keywords: [], hobbies: [], education: [], work: [], achievements: [], service: '', duration: '', notes: []
  };
  for (const { field, value, line } of profileLines) {
    const v = (value || '').trim();
    switch (field) {
      case 'name': if (!p.name && v && !/^(xyz|abc|na|anonymous)$/i.test(v)) p.name = v.slice(0, 60); break;
      case 'date': p.date = p.date ? `${p.date}, ${v}` : v; break;
      case 'board': if (!p.boardRaw) p.boardRaw = v; break;
      case 'optional': if (!p.optionalRaw) p.optionalRaw = v; break;
      case 'home': p.homeRaw = p.homeRaw ? `${p.homeRaw}, ${v}` : v; break;
      case 'keywords': p.keywords.push(...splitList(v)); break;
      case 'hobbies': p.hobbies.push(...splitList(v)); break;
      case 'education': p.education.push(...splitList(v)); break;
      case 'work': if (!/^(n\/?a|no|none|nil|fresher|-)$/i.test(v)) p.work.push(...splitList(v)); break;
      case 'achievements': p.achievements.push(...splitList(v)); break;
      case 'service': p.service = v; break;
      case 'duration': p.duration = v; break;
      case 'experience': if (v) epilogue.push(v); break;
      case 'free': if (line.length <= 140) p.keywords.push(...splitList(line)); else p.notes.push(line); break;
      default: break;
    }
  }
  // The board line often carries the date and session too: "Manoj Soni Sir, Forenoon, 24.08.2021"
  const sessionSrc = `${p.date} ${p.boardRaw}`;
  if (/\b(forenoon|fn|morning|first half)\b/i.test(sessionSrc)) p.session = 'FN';
  else if (/\b(afternoon|an|evening|second half|post ?lunch)\b/i.test(sessionSrc)) p.session = 'AN';

  const board = canonicalBoard(p.boardRaw);
  const optional = canonicalOptional(p.optionalRaw) || canonicalOptional(p.keywords.find((k) => /optional/i.test(k)) || '');
  const allText = [p.homeRaw, ...p.keywords, ...p.education].join(', ');
  const homeState = canonicalState(p.homeRaw) || stateMentions(p.homeRaw)[0] || stateMentions(allText)[0] || '';
  const keywords = uniq(p.keywords.map((k) => k.replace(/^(daf|keywords?)\s*[:\-]\s*/i, '')).filter((k) => !/^(optional|board|date)\b/i.test(k)));
  return {
    name: p.name,
    date: p.date.slice(0, 80),
    session: p.session,
    boardRaw: p.boardRaw.slice(0, 120),
    board,
    optional,
    homeState,
    home: p.homeRaw.slice(0, 120),
    keywords: keywords.slice(0, 30),
    hobbies: uniq(p.hobbies).slice(0, 15),
    education: uniq(p.education).slice(0, 10),
    work: uniq(p.work).slice(0, 10),
    achievements: uniq(p.achievements).slice(0, 15),
    servicePreference: p.service.slice(0, 120),
    duration: p.duration.slice(0, 40),
    notes: p.notes.slice(0, 5)
  };
};

// Replace the candidate's own name (from the "Name:" line) with [name] wherever it is repeated.
const maskName = (text, name) => {
  if (!name) return text;
  let out = text;
  for (const part of name.split(/\s+/).filter((w) => w.length >= 3 && /^[A-Za-z]+$/.test(w))) {
    out = out.replace(new RegExp(`\\b${part}\\b`, 'gi'), '[name]');
  }
  return out;
};

// ------------------------------------------------------------------ main

// pages: [{ page, text }] for one year. Returns [{ year, seq, pageStart, pageEnd, profile, questions,
// experience, rawText }] where questions = [{ order, asker, text, followUp, note, page }].
export const parseYear = (pages, year) => {
  const sample = pages.slice(0, 80).map((p) => p.text).join('\n');
  const broken = (sample.match(/¦/g) || []).length > 3; // the other compilations have none

  const lines = [];
  for (const { page, text } of pages) {
    const src = broken ? repairEncoding(text) : text;
    for (const rawLine of src.split('\n')) {
      // Zero-width characters and C1 control codes (the 2021 file has "1\u0091 You were...") are dropped.
      // eslint-disable-next-line no-control-regex
      const line = rawLine.replace(/[​-‍⁠﻿\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (POST_HEADER.test(line)) { lines.push({ page, line, post: true }); continue; }
      if (NOISE_LINE.some((re) => re.test(line))) continue;
      // Short lines are left alone so "Date: 1 May 2 PM" isn't cut up.
      for (const part of line.length > 50 ? splitInlineNumbered(line) : [line]) lines.push({ page, line: part });
    }
  }

  // Pass 1: mark profile lines. A weak key ("Name Yogi Singh") needs a profile line right next to it.
  const strong = lines.map((l) => (l.post ? null : matchHeader(l.line, false)));
  const header = lines.map((l, i) => {
    if (l.post) return null;
    if (strong[i]) return strong[i];
    const near = !!(strong[i - 1] || strong[i + 1]);
    return near ? matchHeader(l.line, true) : null;
  });

  const transcripts = [];
  let cur = null;

  const start = (page) => {
    cur = { pageStart: page, pageEnd: page, profileLines: [], items: [], epilogue: [], raw: [], asker: null, mode: 'header', sawSpeaker: false };
  };
  const pendingItem = () => cur.items[cur.items.length - 1];
  const questionCount = () => cur.items.filter((it) => it.kind === 'q').length;

  const finishItem = (it) => {
    if (!it || it.done) return;
    it.done = true;
    const text = it.text.trim();
    if (it.forcedNote || ANSWER_START.test(text) || REACTION_START.test(text) || /^\(/.test(text)) { it.kind = 'note'; return; }
    // Bulleted items, and the first line under a speaker, are questions unless they read like a remark.
    if (it.defaultQ && text.length >= 8 && text.length <= 420 && !NOISE_ITEM.test(text) && !LABEL_LINE.test(text)) { it.kind = 'q'; return; }
    it.kind = isQuestionText(text) ? 'q' : 'note';
  };

  const flush = () => {
    if (!cur) return;
    finishItem(pendingItem());
    const profile = mapProfile(cur.profileLines, cur.epilogue);
    const questions = [];
    let lastQ = null;
    let lastBulletStyle = null;
    for (const it of cur.items) {
      if (it.kind === 'q') {
        let text = cleanQuestion(it.text);
        let inlineNote = '';
        const paren = text.match(ANSWER_IN_PARENS);
        if (paren && paren.index > 8) { inlineNote = paren[1].trim(); text = text.slice(0, paren.index).trim(); }
        const followUp = FOLLOW_UP.test(it.text) || (it.bulletStyle === 'dash' && lastBulletStyle === 'number' && lastQ && lastQ.asker === it.asker);
        text = maskName(text, profile.name);
        lastQ = { order: questions.length + 1, asker: it.asker || 'unknown', text, followUp: !!followUp && questions.length > 0, note: maskName(inlineNote, profile.name).slice(0, 600), page: it.page };
        questions.push(lastQ);
        if (it.bulletStyle === 'number') lastBulletStyle = 'number';
        else if (it.bulletStyle !== 'dash') lastBulletStyle = it.bulletStyle;
      } else if (lastQ) {
        const n = maskName(it.text.replace(/^\(|\)$/g, '').trim(), profile.name);
        if (n && !NOISE_ITEM.test(n)) lastQ.note = lastQ.note ? `${lastQ.note} ${n}`.slice(0, 600) : n.slice(0, 600);
      }
    }
    if (questions.length >= 3) {
      const { name, ...publicProfile } = profile;
      transcripts.push({
        year,
        seq: transcripts.length + 1,
        pageStart: cur.pageStart,
        pageEnd: cur.pageEnd,
        profile: publicProfile,
        questions,
        experience: cur.epilogue.join(' ').replace(/\s+/g, ' ').slice(0, 1500),
        rawText: cur.raw.join('\n')
      });
    }
    cur = null;
  };

  start(lines[0]?.page || 1);

  for (let i = 0; i < lines.length; i++) {
    const { page, line, post } = lines[i];
    if (post) { flush(); start(page); cur.raw.push(line); continue; }

    const h = header[i];
    // "Experience: cordial" / "Duration: 25 min" after the questions closes this transcript, not opens one.
    if (h && cur.mode !== 'header' && ['experience', 'duration', 'skip'].includes(h.field)) {
      finishItem(pendingItem());
      cur.mode = 'epilogue';
      cur.epilogue.push(line);
      cur.raw.push(line);
      continue;
    }
    if (h) {
      // A profile line after questions means the next candidate's transcript has started.
      if (cur.mode !== 'header' && (questionCount() >= 2 || (cur.mode === 'epilogue' && questionCount() >= 1))) { flush(); start(page); }
      finishItem(pendingItem());
      cur.mode = 'header';
      cur.profileLines.push({ ...h, line });
      cur.raw.push(line);
      cur.pageEnd = page;
      continue;
    }

    cur.raw.push(line);
    cur.pageEnd = page;
    if (isGarbageLine(line) || LABEL_LINE.test(line) || DATE_LINE.test(line)) continue;
    // A bare chairperson's name between sections ("Suman Sharma") isn't a question.
    if (line.length <= 32 && !line.includes('?') && canonicalBoard(line)) continue;

    const sp = matchSpeaker(line);
    if (sp) {
      finishItem(pendingItem());
      cur.mode = 'body';
      cur.asker = sp.asker;
      cur.sawSpeaker = true;
      if (sp.rest && sp.rest.length > 3) {
        const { text, had } = stripBullets(sp.rest);
        cur.items.push({ text, asker: sp.asker, page, bulletStyle: had ? 'number' : 'inline', defaultQ: true });
      } else {
        cur.lastWasSpeaker = true;
      }
      continue;
    }

    if (cur.mode === 'body' && EPILOGUE_START.test(line) && !line.includes('?')) {
      finishItem(pendingItem());
      cur.mode = 'epilogue';
      cur.epilogue.push(line);
      continue;
    }
    if (cur.mode === 'epilogue') { cur.epilogue.push(line); continue; }

    if (cur.mode === 'header') {
      // Short free-form lines inside the profile block ("PSIR, BIT Mesra, Football, HS- Jharkhand").
      const looksLikeQuestion = line.includes('?') || QUESTIONISH_START.test(stripBullets(line).text);
      if (!looksLikeQuestion && !cur.sawSpeaker && cur.profileLines.length > 0 && line.length <= 160) {
        cur.profileLines.push({ field: 'free', value: '', line });
        continue;
      }
      if (!looksLikeQuestion) continue; // preamble text before the first transcript
      cur.mode = 'body';
    }

    // Body: a new item, or the continuation of a question wrapped onto the next PDF line.
    const { text, had } = stripBullets(line);
    if (!text) continue;
    const prev = pendingItem();
    const prevOpen = prev && !prev.done;
    const prevEndsTerminal = prevOpen && /[?!.)\]]["'”]?\s*$/.test(prev.text);
    const startsNew =
      had || !prevOpen || prevEndsTerminal || cur.lastWasSpeaker ||
      (/^[A-Z]/.test(text) && QUESTIONISH_START.test(text)) ||
      ANSWER_START.test(text) || /^\(/.test(text);
    const afterSpeaker = !!cur.lastWasSpeaker;
    cur.lastWasSpeaker = false;
    if (startsNew) {
      finishItem(prev);
      const bulletStyle = had ? (/^\s*\(?\d/.test(line) ? 'number' : 'dash') : 'plain';
      cur.items.push({ text, asker: cur.asker, page, bulletStyle, defaultQ: had || afterSpeaker });
    } else {
      prev.text = `${prev.text} ${text}`;
    }
  }
  flush();
  return transcripts;
};
