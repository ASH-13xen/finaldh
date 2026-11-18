// Board mood: how candidates described the board's atmosphere - cordial, neutral or tough. Lines about the
// mood are picked out of each transcript locally (the parsed "experience" summary and raw lines with mood
// words, minus questions put to the candidate such as "How do you handle stress?"); Gemini labels only those
// lines (scripts/interview/pipeline.mjs mood). Interviews that say nothing about the mood stay unlabelled.
export const MOODS = ['cordial', 'neutral', 'tough'];

const MOOD_WORDS = /\b(cordial|friendly|warm|smil\w*|laugh\w*|relax\w*|comfortable|pleasant|polite|cooperative|supportive|encourag\w*|calm|patient|kind|stress\w*|strict|grill\w*|tough|aggressive|hostile|rude|intimidat\w*|pressur\w*|sarcas\w*|cold|interrupt\w*|irritat\w*|annoy\w*|angry|harsh|cross[- ]question\w*)\b/i;
const ASKER = /^\s*(q\s*\d*|ch(airman|airperson)?|m\s*\d|member\s*\d?|lady|sir|madam)\s*[:\-–)]/i;

export const moodLines = (t) => {
  const out = [];
  const exp = String(t.experience || '').replace(/\s+/g, ' ').trim();
  if (exp && MOOD_WORDS.test(exp)) out.push(exp.slice(0, 300));
  for (const line of String(t.rawText || '').split(/\n+/)) {
    const l = line.replace(/\s+/g, ' ').trim();
    if (l.length < 12 || l.length > 260 || !MOOD_WORDS.test(l)) continue;
    if (/\?\s*["')\]]?\s*$/.test(l)) continue; // a question put to the candidate
    if (ASKER.test(l) && l.includes('?')) continue;
    if (!out.includes(l)) out.push(l);
    if (out.length >= 4) break;
  }
  return out;
};

export const MOOD_SYSTEM = 'You read UPSC interview transcripts written by candidates and judge how they described the interview board\'s behaviour.';
export const moodPrompt = (batch) => `For each interview below, judge the board's overall atmosphere as the candidate describes it:
- "cordial": friendly, supportive, smiling, relaxed, encouraging
- "neutral": formal, mixed, matter-of-fact
- "tough": stressful, grilling, sarcastic, hostile, interrupting
- "unknown": the lines don't describe the board's behaviour (for example a question about stress, or a topic word)
Return JSON {"r":{"<id>":"cordial|neutral|tough|unknown"}} with every id.
${batch.map((x) => `ID ${x.key}:\n${x.lines.map((l) => `  - ${l}`).join('\n')}`).join('\n')}`;

// Per board: how many interviews were labelled each way.
export const moodByBoard = (transcripts, moods) => {
  const out = {};
  for (const t of transcripts) {
    const b = t.profile?.board;
    const m = moods[t.key];
    if (!b || !MOODS.includes(m)) continue;
    out[b] = out[b] || { cordial: 0, neutral: 0, tough: 0, n: 0 };
    out[b][m] += 1;
    out[b].n += 1;
  }
  return out;
};
