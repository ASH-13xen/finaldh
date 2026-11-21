// Practice Studio: AI feedback on how a spoken answer sounded. The browser already measured pace, pauses
// and pitch; Gemini listens for what those can't catch - every "um" and "uh" (browser speech recognition
// drops them), hedging, tone and confidence - and gives three specific tips.
import { generateJson } from './gemini.js';

const SYSTEM = `You are a UPSC Civil Services interview coach who works on DELIVERY: how an answer sounds, not only what it says. You are warm, specific and honest. Never invent facts about the candidate.`;

const clamp10 = (n) => Math.max(1, Math.min(10, Math.round(Number(n) || 0)));
const str = (s, n = 400) => String(s || '').trim().slice(0, n);

// audio: { buffer, mimeType }; question: the question answered; lang: 'en' | 'hi' (language of the feedback);
// device: what the browser measured (wpm, long pauses...), so the AI doesn't contradict the numbers.
export const analyzeAnswer = async ({ audio, question, lang = 'en', device = {} }) => {
  const prompt = `Interview question: "${str(question, 300)}"
Measured on the candidate's device: ${JSON.stringify({ wpm: device.wpm, longPauses: device.longPauses, durationSec: device.durationSec, startDelaySec: device.startDelaySec })}.
Listen to the recorded answer and return JSON:
{"transcript":"verbatim, including filler sounds (um, uh, er, hmm), repeated words, false starts, and Hindi fillers (matlab, toh, haan, wo, yaani, na) exactly as spoken",
"fillers":[{"word":"um","count":3}],
"hedges":["phrases that signal uncertainty, e.g. 'I think maybe'"],
"tone":{"label":"calm|assertive|confident|nervous|hesitant|defensive|over-casual|monotonous","note":"one sentence"},
"confidence":1-10,"fluency":1-10,"clarity":1-10,"content":1-10,
"contentNote":"one sentence on structure and relevance to the question",
"tips":["three short, specific things to do differently next time"]}
${lang === 'hi' ? 'Write "note", "contentNote" and "tips" in Hindi (Devanagari). Keep the transcript in the language spoken.' : 'Write the feedback in clear, simple English.'}
If the recording has no speech, return an empty transcript and say so in the tips.`;
  const raw = await generateJson({
    system: SYSTEM,
    prompt,
    parts: [{ inlineData: { data: audio.buffer.toString('base64'), mimeType: audio.mimeType } }],
    temperature: 0.3,
    // With audio, gemini-3.6-flash answers JSON mode with an empty reply at thinking 'low' (measured
    // 2026-11-17); 'medium' adds ~700 thinking tokens (about Rs0.2) and returns clean JSON.
    maxOutputTokens: 3500,
    thinking: 'medium',
    retries: 1
  });
  const fillers = (Array.isArray(raw?.fillers) ? raw.fillers : [])
    .map((f) => ({ word: str(f?.word, 30), count: Math.max(0, Math.min(200, Number(f?.count) || 0)) }))
    .filter((f) => f.word && f.count)
    .slice(0, 12);
  return {
    transcript: str(raw?.transcript, 6000),
    fillers,
    fillerTotal: fillers.reduce((a, f) => a + f.count, 0),
    hedges: (Array.isArray(raw?.hedges) ? raw.hedges : []).map((h) => str(h, 80)).filter(Boolean).slice(0, 10),
    tone: { label: str(raw?.tone?.label, 30).toLowerCase(), note: str(raw?.tone?.note, 300) },
    scores: { confidence: clamp10(raw?.confidence), fluency: clamp10(raw?.fluency), clarity: clamp10(raw?.clarity), content: clamp10(raw?.content) },
    contentNote: str(raw?.contentNote, 400),
    tips: (Array.isArray(raw?.tips) ? raw.tips : []).map((tip) => str(tip, 300)).filter(Boolean).slice(0, 3)
  };
};
