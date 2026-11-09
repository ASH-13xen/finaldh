// The board's voices: Gemini text-to-speech, streamed so a question starts playing about a second after
// it is asked instead of after the whole clip is ready. Raw 16-bit mono PCM at 24 kHz is written straight
// to the HTTP response; the browser schedules it with the Web Audio API (frontend lib/interviewSpeech.js).
import { aiAvailable, GeminiUnavailableError } from './gemini.js';

export const TTS_MODEL = process.env.INTERVIEW_TTS_MODEL || 'gemini-3.8-flash-tts';
export const SAMPLE_RATE = 24000;

// One voice per seat, a mix of men and women as on real boards.
const VOICES = {
  chairman: 'Sadaltager',
  m1: 'Kore',
  m2: 'Iapetus',
  m3: 'Sulafat',
  m4: 'Alnilam'
};

// This model reads any instruction placed before the text aloud. Its "director's notes" layout is the
// exception: only the TRANSCRIPT section is spoken, the rest sets the delivery.
const prompt = (text, asker) => `# AUDIO PROFILE: ${asker === 'chairman' ? 'Chairperson' : 'Senior member'} of the UPSC civil services interview board
## THE SCENE: A formal interview room in Dholpur House, New Delhi. A candidate sits across the table.
### DIRECTOR'S NOTES
Style: calm, formal and measured; courteous but authoritative, like an experienced senior civil servant.
Accent: distinctly Indian English, as spoken by senior IAS officers in Delhi - not British, not American.
Pace: unhurried, with natural pauses.
#### TRANSCRIPT
${text}`;

// Splits an SSE body into events whether the server separates them with \r\n\r\n or \n\n.
const nextEvent = (buf) => {
  const m = buf.match(/\r?\n\r?\n/);
  if (!m) return null;
  return { event: buf.slice(0, m.index), rest: buf.slice(m.index + m[0].length) };
};

// Streams `text` spoken in `asker`'s voice into `res`. Throws (before anything is written) when Gemini
// is off or refuses, so the caller can answer with an error and the browser falls back to its own voice.
export const streamSpeech = async (text, asker, res) => {
  if (!aiAvailable()) throw new GeminiUnavailableError('AI voice is not available');
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt(text, asker) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { languageCode: 'en-IN', voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[asker] || VOICES.chairman } } }
      }
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`TTS ${upstream.status}: ${detail.slice(0, 160)}`);
  }

  res.setHeader('Content-Type', `audio/L16; rate=${SAMPLE_RATE}; channels=1`);
  res.setHeader('X-Sample-Rate', String(SAMPLE_RATE));
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders?.();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let ev;
    while ((ev = nextEvent(buf))) {
      buf = ev.rest;
      const line = ev.event.split(/\r?\n/).find((l) => l.startsWith('data: '));
      if (!line) continue;
      let data;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      for (const part of data.candidates?.[0]?.content?.parts || []) {
        if (!part.inlineData?.data) continue;
        const pcm = Buffer.from(part.inlineData.data, 'base64');
        bytes += pcm.length;
        res.write(pcm);
      }
    }
  }
  res.end();
  return { seconds: bytes / 2 / SAMPLE_RATE };
};

export const SAMPLE_LINES = {
  chairman: 'Good morning. Please have a seat. Shall we begin?',
  m1: 'Tell us something about your home district.',
  m2: 'Why did you choose the civil services after your graduation?',
  m3: 'Your form says you enjoy cricket. What has it taught you?',
  m4: 'Let us turn to current affairs.'
};
