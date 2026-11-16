// Short texts (interview questions) into Hindi through Gemini. Each translation is cached in
// InterviewAiCache under a hash of the English text, so a question is paid for once and then shared by
// every student who sees it.
import crypto from 'crypto';
import InterviewAiCache from '../../models/InterviewAiCache.js';
import { generateJson } from './gemini.js';

export const textHash = (s) => crypto.createHash('sha1').update(String(s || '').trim()).digest('hex').slice(0, 20);

const PROMPT = {
  hi: `Translate each UPSC Civil Services interview question into natural, polite Hindi (Devanagari), the way a Hindi-medium interview board member would ask it.
Keep acronyms and proper nouns as they are commonly written in Hindi (DAF, UPSC, IAS, ISRO, NITI Aayog, names of people and places).
Return JSON {"t":["..."]} with exactly one translation per input, in the same order.`
};

const BATCH = 50;

// texts -> Map(text -> translation or null). Never throws: a failed batch just stays untranslated.
export const translateTexts = async (texts, lang = 'hi') => {
  const out = new Map();
  if (!PROMPT[lang]) return out;
  const all = [...new Set((texts || []).map((t) => String(t || '').trim()).filter(Boolean))];
  if (!all.length) return out;
  const keyOf = (t) => `tr:${lang}:${textHash(t)}`;
  const cached = await InterviewAiCache.find({ key: { $in: all.map(keyOf) } }).lean();
  const byKey = new Map(cached.map((c) => [c.key, c.data]));
  const todo = [];
  for (const t of all) {
    const hit = byKey.get(keyOf(t));
    if (hit) out.set(t, hit);
    else todo.push(t);
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const res = await generateJson({
        prompt: `${PROMPT[lang]}\n\nInputs:\n${batch.map((t, n) => `${n + 1}. ${t}`).join('\n')}`,
        temperature: 0.2,
        maxOutputTokens: 8000,
        thinking: 'low'
      });
      const rows = Array.isArray(res?.t) ? res.t : [];
      if (rows.length !== batch.length) continue;
      const docs = [];
      batch.forEach((t, n) => {
        const tr = String(rows[n] || '').trim().slice(0, 600);
        if (!tr) return;
        out.set(t, tr);
        docs.push({ key: keyOf(t), data: tr });
      });
      if (docs.length) await InterviewAiCache.insertMany(docs, { ordered: false }).catch(() => {});
    } catch (err) {
      if (err.name === 'GeminiUnavailableError') break;
    }
  }
  return out;
};
