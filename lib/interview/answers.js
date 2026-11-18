// A first-person answer drafted from the student's own DAF ("Why did you leave your job at GoTo?"). It uses
// only what the DAF says; anything personal it can't know is left as a [bracketed] gap for the student to
// fill, and three pointers say how to make it their own. One AI credit each (lib/interview/credits.js).
import { generateJson } from './gemini.js';

const SYSTEM = `You help a UPSC Civil Services interview (Personality Test) candidate prepare. You write in the candidate's own voice: first person, honest, specific and calm, like a well-prepared candidate speaking - not an essay. You use only facts from the candidate's DAF; you never invent achievements, numbers, names, places or experiences. Where the answer needs a personal detail the DAF doesn't give, you write a short placeholder in square brackets, e.g. [the moment you decided].`;

const str = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (x, n, len) => (Array.isArray(x) ? x.map((v) => str(v, len)).filter(Boolean).slice(0, n) : []);

// The DAF as plain lines for the prompt (only fields the student filled in).
export const dafLines = (p = {}) => [
  p.homeState && `Home state: ${p.homeState}${p.homeDistrict ? `, district ${p.homeDistrict}` : ''}${p.hometown ? `, hometown ${p.hometown}` : ''}`,
  ...(p.education || []).map((e) => `Education: ${[e.degree, e.discipline, e.institution, e.year].filter(Boolean).join(', ')}`),
  ...(p.work || []).map((w) => `Work: ${[w.role, w.organization, w.duration].filter(Boolean).join(', ')}`),
  p.optional && `Optional subject: ${p.optional}`,
  (p.hobbies || []).length && `Hobbies: ${p.hobbies.join(', ')}`,
  (p.achievements || []).length && `Achievements / ECA: ${p.achievements.join('; ')}`,
  (p.servicePreference || []).length && `Service preference: ${p.servicePreference.join(', ')}`,
  p.familyBackground && `Family background: ${p.familyBackground}`,
  (p.languages || []).length && `Languages: ${p.languages.join(', ')}`,
  p.otherNotes && `Other notes: ${p.otherNotes}`
].filter(Boolean).map((l) => str(l, 400));

export const draftAnswer = async ({ question, profile, approach = null, lang = 'en' }) => {
  const prompt = `Interview question: "${str(question, 300)}"
The candidate's DAF:
${dafLines(profile).map((l) => `- ${l}`).join('\n') || '- (nothing filled in yet)'}
${approach?.gist ? `What the board is testing: ${approach.gist}\n` : ''}${approach?.structure?.length ? `A good structure: ${approach.structure.join(' -> ')}\n` : ''}
Write the answer the candidate could give, 120-170 words, in natural spoken ${lang === 'hi' ? 'Hindi (Devanagari)' : 'Indian English'}. Use their DAF where it fits; no clichés ("since childhood I dreamt..."), no exaggeration. Do not make up feelings, events or small personal details (how they slept, a family story, a teacher's name): if the answer needs one, leave a [bracketed] gap.
Return JSON {"answer":"...","pointers":["3 short ways to make this answer truly their own"],"followUps":["2 follow-up questions a board would likely ask next"]}`;
  const raw = await generateJson({ system: SYSTEM, prompt, temperature: 0.5, maxOutputTokens: 3000, thinking: 'low', retries: 1 });
  const answer = str(raw?.answer, 2000);
  if (!answer) throw new Error('The AI returned no answer.');
  return { text: answer, pointers: list(raw?.pointers, 3, 240), followUps: list(raw?.followUps, 2, 240), at: new Date() };
};
