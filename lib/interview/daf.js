// The student's DAF, filled in on the website's form: cleaning what the form sends. Also turns a
// recorded voice answer into text (for browsers without built-in speech recognition).
import { generateText } from './gemini.js';
import { canonicalOptional, canonicalState, uniq } from './text.js';

const str = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (v, n = 15, len = 100) => uniq((Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map((x) => str(x, len)).filter(Boolean)).slice(0, n);

export const SERVICES = ['IAS', 'IFS', 'IPS', 'IRS (IT)', 'IRS (C&IT)', 'IFoS', 'IA&AS', 'IRMS', 'IDAS', 'ICAS', 'IPoS', 'IIS', 'ITS', 'IDES', 'IRPFS', 'Armed Forces HQ', 'DANICS', 'DANIPS', 'Pondicherry CS', 'Pondicherry PS'];

// Whatever the form sent -> the InterviewProfile fields, trimmed and bounded.
export const cleanProfileInput = (b = {}) => ({
  homeState: canonicalState(b.homeState) || str(b.homeState, 60),
  homeDistrict: str(b.homeDistrict, 80),
  hometown: str(b.hometown, 80),
  education: (Array.isArray(b.education) ? b.education : []).slice(0, 6).map((e) => ({
    degree: str(e?.degree, 80), discipline: str(e?.discipline, 120), institution: str(e?.institution, 160), year: str(e?.year, 20)
  })).filter((e) => e.degree || e.discipline || e.institution),
  work: (Array.isArray(b.work) ? b.work : []).slice(0, 6).map((w) => ({
    role: str(w?.role, 120), organization: str(w?.organization, 160), duration: str(w?.duration, 60)
  })).filter((w) => w.role || w.organization),
  optional: canonicalOptional(b.optional) || str(b.optional, 80),
  hobbies: list(b.hobbies),
  achievements: list(b.achievements, 15, 200),
  servicePreference: list(b.servicePreference, 12, 40),
  familyBackground: str(b.familyBackground, 400),
  languages: list(b.languages, 6, 40),
  otherNotes: str(b.otherNotes, 1000)
});

export const isProfileEmpty = (p = {}) =>
  !p.homeState && !p.homeDistrict && !(p.education || []).length && !(p.work || []).length && !p.optional && !(p.hobbies || []).length && !(p.achievements || []).length;

export const transcribeAnswer = async (buffer, mimeType) => generateText({
  system: 'You transcribe a candidate\'s spoken answer in a UPSC interview. Output only the transcript text, nothing else.',
  prompt: 'Transcribe this answer verbatim in English. If parts are in Hindi, write them in Roman script (Hinglish). Remove filler sounds like "umm". If nothing intelligible is said, output an empty string.',
  parts: [{ inlineData: { data: buffer.toString('base64'), mimeType } }],
  temperature: 0,
  maxOutputTokens: 2000
});
