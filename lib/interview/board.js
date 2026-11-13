// How the board conducts itself: the interview formats (a fixed number of questions and follow-ups,
// so the cost of an interview is known in advance), the board's temperament, each member's manner, the
// short lines spoken between questions, and how what the camera saw is turned into a remark and a score.
// Everything here works without Gemini; with Gemini the same rules are handed to it as instructions.

// questions = planned questions (the opening included); followUps = the most the board may add.
// minutes is only a safety allowance for an interview left open, not a target.
export const FORMATS = {
  quick: { label: 'Quick drill', questions: 8, followUps: 4, minutes: 25, about: 'about 10 minutes' },
  standard: { label: 'Standard board', questions: 14, followUps: 7, minutes: 45, about: 'about 20 minutes' },
  full: { label: 'Full board', questions: 20, followUps: 10, minutes: 60, about: 'about 30 minutes' }
};
export const DEFAULT_FORMAT = 'standard';
export const formatOf = (key) => FORMATS[key] || FORMATS[DEFAULT_FORMAT];
// Interviews used to be chosen by length.
export const formatFromMinutes = (minutes) => (Number(minutes) <= 10 ? 'quick' : Number(minutes) >= 30 ? 'full' : 'standard');

export const MAX_FOLLOW_UPS_PER_QUESTION = 2;

export const TEMPERAMENTS = {
  cordial: {
    label: 'Cordial',
    blurb: 'Encouraging. Puts you at ease and corrects gently.',
    brief: 'This board is encouraging. Put the candidate at ease, acknowledge what is good in an answer and correct gently. Pushing back is still expected when an answer is wrong or evasive.',
    interruptAfter: 160,
    presenceRemarks: 2
  },
  standard: {
    label: 'Standard',
    blurb: 'Business-like. Brief, firm when you are vague.',
    brief: 'This board is neutral and business-like: brief acknowledgements, little praise, and firm when an answer is vague, evasive or wrong.',
    interruptAfter: 130,
    presenceRemarks: 3
  },
  strict: {
    label: 'Strict',
    blurb: 'A stress board. Sceptical, exacting, quick to challenge.',
    brief: 'This is a stress board. Be exacting and sceptical: challenge assumptions, say so plainly when an answer is vague, evasive, rehearsed or wrong, and rarely praise. Stay professional - never rude, insulting or personal.',
    interruptAfter: 100,
    presenceRemarks: 5
  }
};
export const DEFAULT_TEMPERAMENT = 'standard';
export const temperamentOf = (key) => TEMPERAMENTS[key] || TEMPERAMENTS[DEFAULT_TEMPERAMENT];

// Generic manners, not portraits of anyone. Used to keep the five voices from sounding like one person.
export const PERSONAS = {
  chairman: 'courteous and measured; sets the tone; interested in motivation, integrity and the whole person',
  m1: 'knows the candidate\'s home state well; wants ground-level specifics - names, numbers, local problems - not generalities',
  m2: 'an academic; precise, dislikes loose definitions, asks "what exactly do you mean" and tests the fundamentals of the candidate\'s subject and work',
  m3: 'conversational and curious; tests whether hobbies and achievements are genuine by asking for depth and recent developments',
  m4: 'a sceptical policy mind; plays devil\'s advocate on current affairs and expects a balanced view that still takes a stand'
};

export const MOODS = ['pleased', 'neutral', 'sceptical', 'displeased'];

export const speakerName = (asker) => (asker === 'chairman' ? 'Chairperson' : `Member ${String(asker).slice(1)}`);

// A stable pick from a list, so the same turn always gets the same line (the line is spoken later by
// a separate request, and both must agree).
const pick = (list, n) => list[Math.abs(Math.floor(n)) % list.length];

// ------------------------------------------------------------------ lines between questions

// India is where the candidates are; the greeting follows the time there.
export const greetingLine = (now = new Date()) => {
  const hour = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes() + 330) / 60) % 24;
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `Good ${part}. Please take your seat.`;
};

const HANDOVER_FROM_CHAIR = ['{m}, please.', 'Over to {m}.', '{m} will take it from here.'];
const HANDOVER_BETWEEN = ['Thank you. {m}, please.', '{m}, please.', 'Let us hear from {m}.'];
export const handoverLine = (from, to, n = 0) =>
  pick(from === 'chairman' ? HANDOVER_FROM_CHAIR : HANDOVER_BETWEEN, n).replace('{m}', speakerName(to));

const INTERRUPTS = {
  cordial: ['Thank you, I think we have your point. Let us move on.', 'That is helpful, thank you. In the interest of time, let us move on.'],
  standard: ['Thank you, that will do. Let us move on.', 'I will stop you there. Please keep your answers brief.'],
  strict: ['That is enough. You were asked a simple question.', 'I will stop you there. Be brief and to the point.']
};
export const interruptLine = (temperament, n = 0) => pick(INTERRUPTS[temperament] || INTERRUPTS.standard, n);

const REACTIONS = {
  pass: {
    cordial: ['That is alright. Let us move on.', 'No problem. It is better to say so than to guess.'],
    standard: ['Alright. Moving on.', 'Very well.'],
    strict: ['You should know this. Moving on.', 'That is a basic question. Let us move on.']
  },
  passDaf: {
    cordial: ['That is fine, but do read up on it. It is in your own form.', 'Alright. Since it is in your form, please prepare it well.'],
    standard: ['It is from your own form. You should be prepared on it.', 'You wrote this in your form. Please come prepared.'],
    strict: ['This is from your own form. That is not acceptable at this level.', 'You cannot pass on what you wrote yourself. Moving on.']
  },
  passAgain: {
    cordial: ['You have passed a few now. Do try, even if you are not fully sure.', 'Please attempt an answer. We are interested in how you think.'],
    standard: ['You have passed several questions. Please attempt an answer.', 'We would like to hear you try. Moving on.'],
    strict: ['You are passing too many questions. An officer cannot keep saying "I do not know".', 'Another pass. The board expects you to attempt an answer.']
  },
  brief: {
    cordial: ['Thank you. A little more detail would help next time.', 'Alright. Do feel free to elaborate.'],
    standard: ['That was rather brief.', 'You could have said more. Moving on.'],
    strict: ['That is hardly an answer.', 'One line will not do. Moving on.']
  },
  long: {
    cordial: ['Thank you. Do try to be a little more concise.', 'A full answer, thank you. Shorter is fine too.'],
    standard: ['Please keep your answers crisp.', 'Thank you. Briefer answers, please.'],
    strict: ['Far too long. Come to the point.', 'You are taking too long to say very little.']
  },
  fine: {
    cordial: ['Thank you, that is helpful.', 'Good. Thank you.', 'I see, thank you.', 'Alright, thank you.'],
    standard: ['Thank you.', 'Alright.', 'I see.', 'Noted.'],
    strict: ['Alright.', 'Hmm.', 'Let us see.', 'Moving on.']
  }
};

// The asking member's spoken reaction when Gemini is not writing it.
export const cannedReaction = ({ temperament, skipped, words, daf, passes, n = 0 }) => {
  const t = REACTIONS.fine[temperament] ? temperament : DEFAULT_TEMPERAMENT;
  const kind = skipped ? (passes >= 3 ? 'passAgain' : daf ? 'passDaf' : 'pass') : words < 20 ? 'brief' : words > 230 ? 'long' : 'fine';
  const mood = skipped ? (daf || passes >= 3 ? 'displeased' : 'neutral') : kind === 'fine' ? 'neutral' : 'sceptical';
  return { text: pick(REACTIONS[kind][t], n), mood, kind };
};

// ------------------------------------------------------------------ what the camera saw

const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// The browser sends numbers only (the video never leaves the device). Anything odd is dropped.
// Shares are 0..1 of the time the face was in view.
export const cleanBehaviour = (b) => {
  if (!b || typeof b !== 'object') return null;
  const out = {
    tracked: !!b.tracked, // false = the camera or the tracker was not available for this answer
    seconds: round(num(b.seconds, 0, 3600), 0),
    absent: round(num(b.absent, 0, 1)), // share of the answer with no face in view
    eyeContact: round(num(b.eyeContact, 0, 1)), // share of the answer spent facing the board (out of view counts as not)
    lookAways: round(num(b.lookAways, 0, 200), 0), // times the gaze left for 2 s or more
    longestAway: round(num(b.longestAway, 0, 600), 0), // seconds
    down: round(num(b.down, 0, 1)), // looking down (often: reading)
    lean: round(num(b.lean, 0, 1)), // head tilted or off to a side
    slump: round(num(b.slump, 0, 1)), // sunk lower than at the start
    near: round(num(b.near, 0, 1)), // much closer to or further from the camera than at the start
    restless: round(num(b.restless, 0, 1)), // share of the time spent shifting about
    smile: round(num(b.smile, 0, 1)),
    wpm: round(num(b.wpm, 0, 400), 0),
    fillers: round(num(b.fillers, 0, 500), 0)
  };
  if (!out.tracked) return { tracked: false, wpm: out.wpm, fillers: out.fillers, seconds: out.seconds };
  return out;
};

// 0-10 for how the candidate carried themselves in one answer; null when nothing was tracked.
// Deliberately forgiving: a webcam only sees roughly where someone is looking.
export const presenceScore = (b, words = 0) => {
  if (!b?.tracked || b.eyeContact == null) return null;
  let s = 10;
  // eyeContact already counts time out of view as looking away, so absence only adds a little more.
  if (b.absent > 0.2) s -= Math.min(1.5, b.absent * 2);
  if (b.eyeContact < 0.7) s -= Math.min(5, (0.7 - b.eyeContact) * 10);
  if (b.down > 0.25) s -= 1.5;
  if (b.longestAway >= 6) s -= 1;
  if (Math.max(b.lean || 0, b.slump || 0) > 0.4) s -= 1;
  if (b.restless > 0.4) s -= 1;
  if (b.wpm && words >= 25 && (b.wpm > 185 || b.wpm < 95)) s -= 0.5;
  if (words >= 40 && b.fillers / words > 0.06) s -= 1;
  return Math.max(0, Math.min(10, Math.round(s * 10) / 10));
};

// The one thing most worth mentioning about this answer, or null. Thresholds are high on purpose:
// the board should only remark on what it could plainly see.
export const presenceIssue = (b, { words = 0, skipped = false } = {}) => {
  if (!b?.tracked || b.eyeContact == null) return null;
  if (!skipped && (b.seconds || 0) < 8) return null; // too short to judge
  if (b.absent > 0.4) return 'absent';
  if (b.down > 0.45 && words >= 25) return 'reading';
  if (b.eyeContact < 0.4 || b.longestAway >= 10) return 'eyeContact';
  if (Math.max(b.slump || 0, b.lean || 0) > 0.6) return 'posture';
  if (b.restless > 0.6) return 'restless';
  return null;
};

export const PRESENCE_ISSUES = {
  absent: { ask: 'the candidate was out of the camera\'s view for much of the answer', label: 'Out of view' },
  reading: { ask: 'the candidate kept looking down, as if reading from notes', label: 'Looking down' },
  eyeContact: { ask: 'the candidate looked away from the board for most of the answer', label: 'Looking away' },
  posture: { ask: 'the candidate was slouching or leaning to one side', label: 'Posture' },
  restless: { ask: 'the candidate kept shifting about restlessly', label: 'Restless' }
};

const PRESENCE_REMARKS = {
  absent: {
    cordial: 'We cannot see you properly. Could you face the camera, please?',
    standard: 'We cannot see you properly. Please face the board.',
    strict: 'We cannot see you. Sit where the board can see you.'
  },
  reading: {
    cordial: 'Do look up at us while you answer, rather than at your notes.',
    standard: 'Are you reading from something? Please answer in your own words.',
    strict: 'You appear to be reading. Put the notes away and answer the board.'
  },
  eyeContact: {
    cordial: 'Do look at us while you speak. It helps the conversation.',
    standard: 'Please look at the board while you answer.',
    strict: 'Look at the board when you speak. You have barely looked at us.'
  },
  posture: {
    cordial: 'Do sit comfortably but upright, please.',
    standard: 'Please sit up straight.',
    strict: 'Sit up straight. This is an interview.'
  },
  restless: {
    cordial: 'Please be at ease. There is no need to be restless.',
    standard: 'Please sit still and take your time.',
    strict: 'Stop fidgeting and answer calmly.'
  }
};
export const presenceRemark = (issue, temperament) => PRESENCE_REMARKS[issue]?.[temperament] || PRESENCE_REMARKS[issue]?.standard || '';

// One line for Gemini describing what was seen, in plain words.
export const describeBehaviour = (b, words = 0) => {
  if (!b) return '';
  const bits = [];
  if (b.tracked && b.eyeContact != null) {
    bits.push(`looked toward the board ${Math.round(b.eyeContact * 100)}% of the time`);
    if (b.lookAways) bits.push(`looked away ${b.lookAways} time(s), longest ${b.longestAway || 0}s`);
    if (b.down > 0.2) bits.push(`looked down ${Math.round(b.down * 100)}% of the time`);
    if (b.absent > 0.15) bits.push(`out of view ${Math.round(b.absent * 100)}% of the time`);
    if (b.slump > 0.3) bits.push('slouched');
    if (b.lean > 0.3) bits.push('leaned to one side');
    if (b.restless > 0.3) bits.push('restless');
    if (b.smile > 0.3) bits.push('smiled easily');
  }
  if (b.wpm && words >= 25) bits.push(`spoke at ${b.wpm} words a minute${b.wpm > 185 ? ' (fast)' : b.wpm < 95 ? ' (slow)' : ''}`);
  if (words >= 25 && b.fillers) bits.push(`${b.fillers} filler word(s)`);
  return bits.join('; ');
};

const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);

// The end-of-interview summary of how the candidate carried themselves. turns: the answered turns.
export const presenceReport = (turns, wordsOf) => {
  const seen = turns.filter((t) => t.behaviour?.tracked && t.behaviour.eyeContact != null);
  const spoken = turns.filter((t) => !t.skipped && t.behaviour?.wpm && wordsOf(t) >= 25);
  if (!seen.length && !spoken.length) return null;
  const avg = (key) => round(mean(seen.map((t) => t.behaviour[key] || 0)));
  const scores = seen.map((t) => t.presence).filter((x) => x != null);
  const words = spoken.reduce((n, t) => n + wordsOf(t), 0);
  const out = {
    tracked: seen.length,
    answers: turns.length,
    score: scores.length ? Math.round(mean(scores) * 10) / 10 : null,
    eyeContact: seen.length ? avg('eyeContact') : null,
    down: seen.length ? avg('down') : null,
    absent: seen.length ? avg('absent') : null,
    slump: seen.length ? avg('slump') : null,
    lean: seen.length ? avg('lean') : null,
    restless: seen.length ? avg('restless') : null,
    smile: seen.length ? avg('smile') : null,
    lookAways: seen.reduce((n, t) => n + (t.behaviour.lookAways || 0), 0),
    longestAway: seen.reduce((n, t) => Math.max(n, t.behaviour.longestAway || 0), 0),
    wpm: spoken.length ? Math.round(mean(spoken.map((t) => t.behaviour.wpm))) : null,
    fillersPer100: words ? Math.round((spoken.reduce((n, t) => n + (t.behaviour.fillers || 0), 0) / words) * 1000) / 10 : null,
    remarks: turns.filter((t) => t.presenceIssue && t.presenceRemarked).length,
    perQuestion: turns.map((t) => ({
      idx: t.idx,
      asker: t.asker,
      eyeContact: t.behaviour?.tracked ? t.behaviour.eyeContact ?? null : null,
      score: t.presence ?? null,
      issue: t.presenceIssue || ''
    })),
    tips: []
  };
  const tip = (s) => { if (out.tips.length < 5) out.tips.push(s); };
  if (out.eyeContact != null && out.eyeContact < 0.6) tip(`You looked toward the board ${Math.round(out.eyeContact * 100)}% of the time. Pick the member who asked and hold their eye while you make your point; glance at the others as you close.`);
  if (out.down != null && out.down > 0.2) tip('You looked down often. It reads as reading or doubt: pause, look up, then speak.');
  if (out.longestAway >= 6) tip(`Your longest look away was ${out.longestAway} seconds. A short glance to think is fine; come back before you start speaking.`);
  if (out.absent != null && out.absent > 0.15) tip('You moved out of the camera\'s view at times. Sit so your head and shoulders stay in frame.');
  if (Math.max(out.slump || 0, out.lean || 0) > 0.3) tip('You slouched or leaned for much of the interview. Sit back in the chair, shoulders level, hands resting in front of you.');
  if (out.restless != null && out.restless > 0.3) tip('You shifted about a good deal. Plant your feet, rest your hands, and let stillness do the work.');
  if (out.wpm && out.wpm > 185) tip(`You spoke at about ${out.wpm} words a minute. Slow to around 140-160 and pause after each point.`);
  if (out.wpm && out.wpm < 95) tip(`You spoke at about ${out.wpm} words a minute. A little more pace will make you sound surer.`);
  if (out.fillersPer100 != null && out.fillersPer100 > 5) tip(`About ${out.fillersPer100} filler words in every 100. Replace "basically" and "actually" with a short silence.`);
  if (out.smile != null && out.smile < 0.03 && seen.length >= 4) tip('You hardly smiled. A pleasant expression at the start and end of an answer makes a board warm to you.');
  if (!out.tips.length && out.score != null) tip('You held the board\'s eye and sat steadily. Keep doing exactly this.');
  return out;
};
