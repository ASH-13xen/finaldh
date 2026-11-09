// The mock-interview board. A session is planned up front from the student's predictions (so every
// question can say where it came from), then driven one answer at a time: with Gemini the board reacts to
// each answer (follow-up or move on) and scores it; without Gemini it uses the follow-ups real boards
// asked after the same question in past transcripts, and gives length/structure feedback.
import InterviewQuestion from '../../models/InterviewQuestion.js';
import { normalizeText, uniq } from './text.js';
import { HOOK_TYPES, TOPIC_LABELS } from './taxonomy.js';
import { searchFamilies } from './corpusIndex.js';
import { aiAvailable, generateJson } from './gemini.js';

export const PANEL = [
  { id: 'chairman', label: 'Chairperson', lanes: ['intro', 'motivation', 'service', 'name'], focus: 'Your background, motivation and overall personality' },
  { id: 'm1', label: 'Member 1', lanes: ['home'], focus: 'Your home state and district' },
  { id: 'm2', label: 'Member 2', lanes: ['education', 'work', 'optional'], focus: 'Your education, work and optional' },
  { id: 'm3', label: 'Member 3', lanes: ['hobby', 'eca'], focus: 'Your hobbies and achievements' },
  { id: 'm4', label: 'Member 4', lanes: ['current'], focus: 'Current affairs and national issues' }
];

// The qualities UPSC says the Personality Test assesses.
export const TRAITS = [
  ['alertness', 'Mental alertness'],
  ['assimilation', 'Critical powers of assimilation'],
  ['exposition', 'Clear and logical exposition'],
  ['judgement', 'Balance of judgement'],
  ['interests', 'Variety and depth of interest'],
  ['leadership', 'Social cohesion and leadership'],
  ['integrity', 'Intellectual and moral integrity']
];

const MAX_FOLLOW_UPS = 2;
const CA_TOPICS = ['ir', 'economy', 'polity', 'scitech', 'environment', 'society', 'security', 'agriculture'];
// When a DAF lane is empty (no work experience, no hobbies listed) the member asks general questions.
const FALLBACK_TOPICS = { m1: ['society', 'history', 'environment'], m2: ['polity', 'economy', 'scitech'], m3: ['society', 'ethics', 'sports'], chairman: ['ethics', 'polity'] };

const yearsLabel = (years) => {
  const ys = uniq(years || []).sort();
  if (!ys.length) return '';
  return ys.length === 1 ? `${ys[0]}` : `${ys[0]}–${ys[ys.length - 1]}`;
};

const familySource = (f, kind = 'family', label) => ({
  kind,
  family: f.id || f.familyId || null,
  familyText: f.text,
  timesAsked: f.timesAsked ?? f.transcriptCount ?? 0,
  years: f.years || [],
  hookType: (f.hookTypes || [])[0] || '',
  hookValue: (f.hookValues || [])[0] || '',
  label: label || `Asked in ${f.timesAsked ?? f.transcriptCount} past interview${(f.timesAsked ?? f.transcriptCount) === 1 ? '' : 's'} · ${yearsLabel(f.years)}`
});

const predictionSource = (p, group) => {
  const top = p.evidence?.[0];
  return {
    kind: p.kind === 'pattern' ? 'pattern' : p.kind === 'ai' || p.kind === 'new' ? 'predicted' : 'family',
    family: top?.familyId || null,
    familyText: top?.text || '',
    timesAsked: top?.timesAsked || 0,
    years: top?.years || [],
    hookType: group.type,
    hookValue: group.value || '',
    label: group.type === 'intro' || group.type === 'motivation'
      ? p.basisNote
      : `Predicted from your DAF: ${HOOK_TYPES[group.type]?.toLowerCase() || group.type} → ${group.value} · ${p.basisNote}`
  };
};

// Past questions are often written down as notes ("Asked about my hobby"); spoken aloud, the ones that
// read as a question work better, so they are preferred when choosing.
const QUESTION_START = /^(what|why|how|who|which|where|when|is|are|was|were|do|does|did|can|could|should|would|will|have|has|tell|explain|describe|give|name|if|suppose|as a|as an|according|in your)\b/i;
export const questionLike = (text) => /\?\s*$/.test(text) || QUESTION_START.test(String(text).trim());

// Weighted shuffle: earlier (more likely) items are still favoured, but sessions differ.
const pickSome = (items, n, textOf = (it) => it.question || it.text || '') => {
  const pool = items.map((it, i) => ({ it, w: Math.random() * (1 / (1 + i * 0.35)) * (questionLike(textOf(it)) ? 1 : 0.25) }));
  pool.sort((a, b) => b.w - a.w);
  return pool.slice(0, n).map((p) => p.it);
};

const allocate = (total, focusTypes) => {
  // Chairperson opens and closes; members share the rest, more for the lanes the student wants to drill.
  const weights = { chairman: 1.1, m1: 1, m2: 1, m3: 1, m4: 1 };
  for (const p of PANEL) if (p.lanes.some((l) => focusTypes.includes(l))) weights[p.id] += 0.9;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  const out = {};
  let used = 0;
  for (const p of PANEL) { out[p.id] = Math.max(1, Math.floor((total * weights[p.id]) / sum)); used += out[p.id]; }
  for (const id of ['m4', 'm2', 'm3', 'm1', 'chairman']) { if (used >= total) break; out[id] += 1; used += 1; }
  return out;
};

// Past follow-ups to these families: the question asked right after a member question, when the
// transcript marked it as a follow-up.
const pastFollowUps = async (familyIds) => {
  const ids = uniq(familyIds.filter(Boolean).map(String));
  if (!ids.length) return new Map();
  const members = await InterviewQuestion.find({ family: { $in: ids }, hidden: { $ne: true } }).select('transcript order family').limit(600).lean();
  if (!members.length) return new Map();
  const next = await InterviewQuestion.find({ $or: members.map((m) => ({ transcript: m.transcript, order: m.order + 1 })), followUp: true, trivial: { $ne: true }, hidden: { $ne: true } })
    .select('transcript order text').lean();
  const byPos = new Map(next.map((q) => [`${q.transcript}:${q.order}`, q.text]));
  const out = new Map();
  for (const m of members) {
    const t = byPos.get(`${m.transcript}:${m.order + 1}`);
    if (!t) continue;
    const k = String(m.family);
    if (!out.has(k)) out.set(k, []);
    if (out.get(k).length < 4 && !out.get(k).includes(t)) out.get(k).push(t);
  }
  return out;
};

// Build the question plan for a new session.
export const planSession = async (idx, predictions, { minutes = 20, focus = [], useAI = aiAvailable() } = {}) => {
  const totalQuestions = Math.max(6, Math.min(35, Math.round(minutes * 0.95)));
  const planned = Math.max(5, Math.round(totalQuestions * (useAI ? 0.65 : 0.8)));
  const groups = predictions?.groups || [];
  const focusTypes = uniq(groups.filter((g) => focus.includes(g.key)).map((g) => g.type));
  const per = allocate(planned - 1, focusTypes); // -1: the opening question
  const used = new Set();
  const take = (text) => {
    const k = normalizeText(text);
    if (!k || used.has(k)) return false;
    used.add(k);
    return true;
  };

  const plan = [];
  const push = (asker, text, source) => plan.push({ slot: plan.length, asker, text, source, followUps: [] });

  // Opening: a warm-up the chairperson asks in most transcripts.
  const intro = groups.find((g) => g.type === 'intro');
  const opening = intro?.predictions?.length ? pickSome(intro.predictions.slice(0, 5), 1)[0] : null;
  if (opening && take(opening.question)) push('chairman', opening.question, { ...predictionSource(opening, intro), kind: 'opening' });
  else push('chairman', 'Please tell us a little about yourself.', { kind: 'opening', label: 'The usual opening question', timesAsked: 0, years: [] });

  for (const member of PANEL) {
    let want = per[member.id] || 0;
    const blocks = [];
    if (member.id === 'm4') {
      // Recent national/international issues boards asked about, newest first.
      const maxYear = Math.max(...(idx.stats.years.length ? idx.stats.years : [2024]));
      const recent = searchFamilies(idx, { filters: { minAsked: 1 }, sort: 'asked', limit: 400 }).items
        .filter((f) => f.topics.some((t) => CA_TOPICS.includes(t)) && f.lastYear >= maxYear - 1 && f.qtype !== 'personal');
      for (const f of pickSome(recent.slice(0, 120), want * 2)) {
        if (want <= 0) break;
        if (!take(f.text)) continue;
        blocks.push(['m4', f.text, familySource(f, 'family', `Asked in ${f.timesAsked} interview${f.timesAsked === 1 ? '' : 's'} · ${TOPIC_LABELS[f.topics[0]] || ''} · ${yearsLabel(f.years)}`)]);
        want -= 1;
      }
    } else {
      const lanes = groups.filter((g) => member.lanes.includes(g.type) && g.type !== 'intro');
      // Spread the member's questions over their DAF items, focused items first.
      lanes.sort((a, b) => (focus.includes(b.key) ? 1 : 0) - (focus.includes(a.key) ? 1 : 0));
      let round = 0;
      while (want > 0 && round < 6) {
        let added = false;
        for (const g of lanes) {
          if (want <= 0) break;
          const candidates = g.predictions.filter((p) => !used.has(normalizeText(p.question)));
          const choice = candidates.length ? pickSome(candidates.slice(0, 4), 1)[0] : null;
          if (choice && take(choice.question)) { blocks.push([member.id, choice.question, predictionSource(choice, g)]); want -= 1; added = true; }
        }
        if (!added) break;
        round += 1;
      }
      if (want > 0) {
        const topics = FALLBACK_TOPICS[member.id] || ['polity'];
        const pool = searchFamilies(idx, { filters: { minAsked: 2, shelfLife: 'evergreen' }, sort: 'asked', limit: 300 }).items
          .filter((f) => f.topics.some((t) => topics.includes(t)) && f.qtype !== 'personal');
        for (const f of pickSome(pool.slice(0, 80), want * 2)) {
          if (want <= 0) break;
          if (!take(f.text)) continue;
          blocks.push([member.id, f.text, familySource(f)]);
          want -= 1;
        }
      }
    }
    for (const [asker, text, source] of blocks) push(asker, text, source);
  }

  // Past follow-ups for each family-backed question, used when Gemini isn't available.
  const fu = await pastFollowUps(plan.map((p) => p.source.family));
  for (const p of plan) if (p.source.family) p.followUps = fu.get(String(p.source.family)) || [];
  return plan;
};

// ------------------------------------------------------------------ answering

const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

const pastNoteFor = async (familyId) => {
  if (!familyId) return '';
  const q = await InterviewQuestion.findOne({ family: familyId, note: { $gt: '' }, hidden: { $ne: true } }).select('note year').lean();
  return q ? `A ${q.year} candidate: “${q.note.slice(0, 220)}”` : '';
};

export const basicFeedback = (answer, skipped) => {
  if (skipped) return { score: null, verdict: 'Passed. Saying “I am not aware of this, sir” honestly is better than guessing — boards respect it.', strengths: [], improve: [], betterAnswer: '' };
  const w = wordCount(answer);
  if (w < 25) return { score: null, verdict: `Short answer (${w} words). Aim for 45–90 seconds: your main point, one example, a balanced close.`, strengths: [], improve: ['Add a concrete example or data point', 'End with a balanced conclusion'], betterAnswer: '' };
  if (w > 220) return { score: null, verdict: `Long answer (${w} words). Boards prefer crisp answers — lead with your main point and stop when it is made.`, strengths: ['Detailed'], improve: ['State your main point in the first sentence', 'Cut background the board did not ask for'], betterAnswer: '' };
  return { score: null, verdict: `Good length (${w} words). Check that it had a clear point, an example and balance.`, strengths: ['Reasonable length'], improve: [], betterAnswer: '' };
};

const BOARD_SYSTEM = `You run a realistic UPSC Civil Services Personality Test (interview) board: a Chairperson and four Members. They are generic roles - never claim to be, or name, any real person.
Speak formal, courteous Indian English. Ask one question at a time, at most 35 words, never a list.
Probe like a real board: ask for specifics, examples, the other side of an argument; politely push back on weak or one-sided answers; accept "I don't know" gracefully and move on.
Evaluate answers like an experienced board: substance and accuracy, structure, balance of judgement, honesty, presence of mind. 5/10 is an average aspirant answer, 8+ is excellent.`;

const profileSummary = (p = {}) => JSON.stringify({
  homeState: p.homeState, homeDistrict: p.homeDistrict, hometown: p.hometown,
  education: (p.education || []).map((e) => [e.degree, e.discipline, e.institution].filter(Boolean).join(', ')),
  work: (p.work || []).map((w) => [w.role, w.organization, w.duration].filter(Boolean).join(', ')),
  optional: p.optional, hobbies: p.hobbies, achievements: p.achievements, servicePreference: p.servicePreference, familyBackground: p.familyBackground
});

const conversation = (turns, n = 12) => turns.slice(-n).map((t) => `${t.asker.toUpperCase()}: ${t.question}\nCANDIDATE: ${t.skipped ? '(passed)' : String(t.answer || '').slice(0, 900)}`).join('\n');

const aiStep = async (session, turn, nextSlot, { followUpsSoFar, minutesLeft }) => {
  const prompt = `Candidate DAF: ${profileSummary(session.profileSnapshot)}

Interview so far:
${conversation(session.turns)}

The ${turn.asker === 'chairman' ? 'Chairperson' : `Member ${turn.asker.slice(1)}`} just asked: "${turn.question}"
Follow-ups already asked on this question: ${followUpsSoFar} (max ${MAX_FOLLOW_UPS}).
Next planned question: ${nextSlot ? `${nextSlot.asker === 'chairman' ? 'Chairperson' : `Member ${nextSlot.asker.slice(1)}`} asks "${nextSlot.text}"` : 'none - the interview is ending'}.
About ${Math.max(0, Math.round(minutesLeft))} minute(s) left.

Return JSON: {"evaluation":{"score":0-10,"verdict":"one sentence","strengths":["..."],"improve":["..."],"betterAnswer":"2-3 sentences on what a strong answer would cover"},
"decision":"follow_up"|"next",
"followUp":"the same speaker's follow-up question, if decision is follow_up",
"nextQuestion":"the next planned question rephrased naturally for this candidate (keep its substance; a short bridge like 'Thank you.' is fine)"}
Choose follow_up only when the answer opens something worth probing and follow-ups so far < ${MAX_FOLLOW_UPS}; choose next if the candidate passed or time is short.`;
  return generateJson({ system: BOARD_SYSTEM, prompt, temperature: 0.6, maxOutputTokens: 3000, retries: 1 });
};

const clampScore = (s) => (Number.isFinite(Number(s)) ? Math.max(0, Math.min(10, Math.round(Number(s) * 10) / 10)) : null);

const cleanFeedback = (e = {}) => ({
  score: clampScore(e.score),
  verdict: String(e.verdict || '').slice(0, 300),
  strengths: (e.strengths || []).map(String).filter(Boolean).slice(0, 4).map((s) => s.slice(0, 200)),
  improve: (e.improve || []).map(String).filter(Boolean).slice(0, 4).map((s) => s.slice(0, 200)),
  betterAnswer: String(e.betterAnswer || '').slice(0, 800)
});

const newTurn = (session, asker, question, source, planSlot) => ({
  idx: session.turns.length,
  asker,
  question: String(question).replace(/\s+/g, ' ').trim().slice(0, 400),
  source,
  planSlot,
  askedAt: new Date()
});

export const closingLine = () => 'Thank you. That brings us to the end of your interview. We wish you all the best.';

// Open the first question of a freshly planned session.
export const openSession = (session) => {
  const first = session.plan[0];
  first.used = true;
  session.turns.push(newTurn(session, first.asker, first.text, first.source, first.slot));
  return session.turns[session.turns.length - 1];
};

// Record the answer to the current question and decide what comes next. Mutates the session document.
// Returns { done, turn } where turn is the next question (or null when the interview is over).
export const answerCurrent = async (session, { answer = '', answerMode = 'text', answerSeconds = 0, skipped = false }) => {
  const turn = session.turns[session.turns.length - 1];
  turn.answer = String(answer || '').slice(0, 6000);
  turn.answerMode = answerMode === 'voice' ? 'voice' : 'text';
  turn.skipped = !!skipped || !turn.answer.trim();
  turn.answeredAt = new Date();
  turn.answerSeconds = Math.max(0, Math.min(3600, Math.round(Number(answerSeconds) || 0)));

  const elapsedMin = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
  const minutesLeft = session.durationMinutes - elapsedMin;
  const timeUp = minutesLeft <= 0;
  const followUpsSoFar = session.turns.filter((t) => t.planSlot === turn.planSlot && ['followup', 'generated'].includes(t.source.kind)).length;
  const slot = session.plan.find((p) => p.slot === turn.planSlot);
  const nextSlot = session.plan.find((p) => !p.used) || null;

  let decision = 'next';
  let followUp = '';
  let nextQuestion = '';
  let aiOk = false;
  if (session.aiUsed && aiAvailable()) {
    try {
      const r = await aiStep(session, turn, timeUp ? null : nextSlot, { followUpsSoFar, minutesLeft });
      turn.feedback = cleanFeedback(r.evaluation);
      decision = r.decision === 'follow_up' ? 'follow_up' : 'next';
      followUp = String(r.followUp || '').trim();
      nextQuestion = String(r.nextQuestion || '').trim();
      aiOk = true;
    } catch (err) {
      if (err.name !== 'GeminiUnavailableError') console.warn('[interview] AI step failed, continuing from the plan:', err.message);
    }
  }
  if (!aiOk) {
    turn.feedback = basicFeedback(turn.answer, turn.skipped);
    // A real board's follow-up to the same question, now and then, when the answer had some substance.
    const past = (slot?.followUps || []).filter((q) => !session.turns.some((t) => normalizeText(t.question) === normalizeText(q)));
    if (!turn.skipped && followUpsSoFar < 1 && past.length && wordCount(turn.answer) >= 12 && Math.random() < 0.6) {
      decision = 'follow_up';
      followUp = past[0];
    }
  }
  if (turn.source.family) turn.feedback.pastNote = await pastNoteFor(turn.source.family);

  if (!timeUp && !turn.skipped && decision === 'follow_up' && followUp && followUpsSoFar < MAX_FOLLOW_UPS) {
    const t = newTurn(session, turn.asker, followUp, { kind: aiOk ? 'generated' : 'followup', label: aiOk ? 'Follow-up on your answer' : 'Follow-up a past board asked after this question' }, turn.planSlot);
    session.turns.push(t);
    return { done: false, turn: t };
  }
  if (nextSlot && !timeUp) {
    nextSlot.used = true;
    const t = newTurn(session, nextSlot.asker, nextQuestion || nextSlot.text, nextSlot.source, nextSlot.slot);
    session.turns.push(t);
    return { done: false, turn: t };
  }
  return { done: true, turn: null };
};

// ------------------------------------------------------------------ report

const REPORT_SYSTEM = `You are a senior UPSC interview mentor writing the assessment after a mock Personality Test. Be specific to what the candidate actually said; quote short phrases. Be candid but encouraging. Never invent things the candidate did not say.`;

const sessionStats = (session) => {
  const turns = session.turns.filter((t) => t.answeredAt);
  const answered = turns.filter((t) => !t.skipped);
  const byAsker = {};
  for (const t of turns) byAsker[t.asker] = (byAsker[t.asker] || 0) + 1;
  const words = answered.map((t) => wordCount(t.answer));
  const secs = answered.map((t) => t.answerSeconds).filter((s) => s > 0);
  const end = session.endedAt || new Date();
  return {
    questions: turns.length,
    answered: answered.length,
    skipped: turns.length - answered.length,
    followUps: turns.filter((t) => ['followup', 'generated'].includes(t.source.kind)).length,
    avgWords: words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : 0,
    avgSeconds: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : 0,
    minutes: Math.max(1, Math.round((new Date(end).getTime() - new Date(session.startedAt).getTime()) / 60000)),
    byAsker,
    voiceAnswers: answered.filter((t) => t.answerMode === 'voice').length
  };
};

export const buildReport = async (session) => {
  const stats = sessionStats(session);
  const answeredTurns = session.turns.filter((t) => t.answeredAt);
  if (session.aiUsed && aiAvailable() && answeredTurns.some((t) => !t.skipped)) {
    try {
      const transcript = answeredTurns.map((t) => ({
        idx: t.idx, asker: t.asker, question: t.question, answer: t.skipped ? '(passed)' : String(t.answer).slice(0, 1200),
        source: t.source.kind, hasFeedback: !!t.feedback?.score
      }));
      const prompt = `Candidate DAF: ${profileSummary(session.profileSnapshot)}
Mock interview (${stats.minutes} min, ${session.mode} mode):
${JSON.stringify(transcript)}

Return JSON: {"overall":0-10,"summary":"3-4 sentences","traits":[${TRAITS.map(([k]) => `{"key":"${k}","score":0-10,"comment":"one sentence"}`).join(',')}],
"strengths":["3-5 specific strengths"],"improvements":["3-5 specific, actionable improvements"],"dafGaps":["DAF areas where answers were thin and need preparation"],
"perQuestion":[{"idx":0,"score":0-10,"verdict":"","improve":[""],"betterAnswer":""}]}
Include perQuestion entries only for questions where hasFeedback is false and the candidate answered.`;
      const r = await generateJson({ system: REPORT_SYSTEM, prompt, temperature: 0.4, maxOutputTokens: 8000, retries: 1 });
      for (const pq of r.perQuestion || []) {
        const t = session.turns.find((x) => x.idx === Number(pq.idx));
        if (t && !t.skipped && !t.feedback?.score) t.feedback = { ...cleanFeedback(pq), pastNote: t.feedback?.pastNote || '' };
      }
      const traitMap = new Map((r.traits || []).map((t) => [t.key, t]));
      return {
        generatedBy: 'gemini',
        overall: clampScore(r.overall),
        summary: String(r.summary || '').slice(0, 1200),
        traits: TRAITS.map(([key, label]) => ({ key, label, score: clampScore(traitMap.get(key)?.score), comment: String(traitMap.get(key)?.comment || '').slice(0, 300) })),
        strengths: (r.strengths || []).map(String).slice(0, 6),
        improvements: (r.improvements || []).map(String).slice(0, 6),
        dafGaps: (r.dafGaps || []).map(String).slice(0, 6),
        stats
      };
    } catch (err) {
      if (err.name !== 'GeminiUnavailableError') console.warn('[interview] AI report failed, writing the basic report:', err.message);
    }
  }
  const tips = [];
  if (stats.skipped > stats.questions / 3) tips.push('You passed on many questions — revise the DAF areas they came from first.');
  if (stats.avgWords && stats.avgWords < 30) tips.push('Answers were short on average; give a point, an example and a balanced close.');
  if (stats.avgWords > 200) tips.push('Answers ran long on average; lead with your main point.');
  const hooks = uniq(answeredTurns.filter((t) => t.skipped && t.source.hookType).map((t) => HOOK_TYPES[t.source.hookType] || t.source.hookType));
  return {
    generatedBy: 'basic',
    overall: null,
    summary: 'AI scoring is not switched on yet, so this report covers how the interview went and what past candidates were asked. Per-answer scores and trait ratings appear here once AI feedback is enabled.',
    traits: TRAITS.map(([key, label]) => ({ key, label, score: null, comment: '' })),
    strengths: stats.answered ? [`Answered ${stats.answered} of ${stats.questions} questions`] : [],
    improvements: tips,
    dafGaps: hooks,
    stats
  };
};

// What the browser gets: no plan (no spoilers), feedback only when the mode allows it.
export const sessionPayload = (session, { includeReport = true } = {}) => {
  const showFeedback = session.mode === 'practice' || session.status !== 'in-progress';
  const turns = session.turns.map((t) => ({
    idx: t.idx,
    asker: t.asker,
    question: t.question,
    source: session.mode === 'practice' || session.status !== 'in-progress' ? t.source : { kind: t.source.kind === 'opening' ? 'opening' : 'hidden', label: '' },
    answer: t.answer,
    answerMode: t.answerMode,
    skipped: t.skipped,
    answered: !!t.answeredAt,
    answerSeconds: t.answerSeconds,
    feedback: showFeedback ? t.feedback || null : null
  }));
  const plannedLeft = session.plan.filter((p) => !p.used).length;
  return {
    id: String(session._id),
    mode: session.mode,
    inputMode: session.inputMode,
    durationMinutes: session.durationMinutes,
    status: session.status,
    aiUsed: session.aiUsed,
    startedAt: session.startedAt,
    endsAt: new Date(new Date(session.startedAt).getTime() + session.durationMinutes * 60000),
    endedAt: session.endedAt,
    panel: PANEL.map(({ id, label, focus }) => ({ id, label, focus })),
    turns,
    current: session.status === 'in-progress' ? turns[turns.length - 1] || null : null,
    progress: { asked: turns.length, remainingPlanned: plannedLeft, estimatedTotal: turns.length + plannedLeft },
    report: includeReport && session.status === 'completed' ? session.report : null
  };
};
