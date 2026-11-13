// Interview-transcript pipeline. Run from backend/:
//
//   python scripts/interview/extract_pages.py "<Downloads>/2020 PT transcripts.pdf" ...   (stage 1, once)
//   node scripts/interview/pipeline.mjs parse                      no-AI parse of every year in data/interview/pages
//   node scripts/interview/pipeline.mjs parse --engine gemini      Gemini parse (needs GEMINI_API_KEY; resumable)
//   node scripts/interview/pipeline.mjs embed                      Gemini embeddings for every question (resumable)
//   node scripts/interview/pipeline.mjs build                      tag + group into families -> data/interview/corpus.json
//   node scripts/interview/pipeline.mjs seed                       load corpus.json into MONGODB_URI (replaces the corpus)
//   node scripts/interview/pipeline.mjs all                        parse + build + seed with whatever is available
//
// Options: --year 2024 (parse one year), --engine heuristic|gemini, --concurrency 4, --uri <mongodb uri>
//
// Everything under data/interview/ is local working data (gitignored): page texts, parses, caches.
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parseYear } from '../../lib/interview/heuristicParser.js';
import { buildCorpus, corpusStats } from '../../lib/interview/corpus.js';
import { normalizeText } from '../../lib/interview/text.js';
import { TOPICS, HOOK_TYPES, QTYPES } from '../../lib/interview/taxonomy.js';
import { generateJson, embedTexts, aiAvailable, checkGemini, geminiStatus, usageTotals, GEMINI_MODEL, EMBEDDING_MODEL, EMBEDDING_DIMS } from '../../lib/interview/gemini.js';

dotenv.config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', '..', 'data', 'interview');
const PAGES = path.join(DATA, 'pages');
const PARSED = path.join(DATA, 'parsed');
const CACHE = path.join(DATA, 'cache');
const EMB_FILE = path.join(DATA, 'embeddings', `${EMBEDDING_MODEL}-${EMBEDDING_DIMS}.jsonl`);
const CORPUS = path.join(DATA, 'corpus.json');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p, data) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data));
};
const exists = (p) => fsSync.existsSync(p);

const pageYears = async () => {
  if (!exists(PAGES)) return [];
  const want = opt('year');
  return (await fs.readdir(PAGES))
    .filter((f) => /^\d{4}\.json$/.test(f))
    .map((f) => Number(f.slice(0, 4)))
    .filter((y) => !want || y === Number(want))
    .sort();
};

// Run fn over items with at most `n` in flight.
const pool = async (items, n, fn) => {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
};

// ------------------------------------------------------------------ parse (heuristic)

const parseHeuristic = async (year) => {
  const { pages } = await readJson(path.join(PAGES, `${year}.json`));
  const transcripts = parseYear(pages, year);
  await writeJson(path.join(PARSED, `${year}.heuristic.json`), { year, engine: 'heuristic', parsedAt: new Date().toISOString(), transcripts });
  const q = transcripts.reduce((n, t) => n + t.questions.length, 0);
  console.log(`${year}: ${transcripts.length} transcripts, ${q} questions (heuristic)`);
};

// ------------------------------------------------------------------ parse (Gemini)

const GEMINI_SYSTEM = `You turn community-typed UPSC Civil Services interview (Personality Test) transcripts into clean JSON.
The text was copied from Telegram posts and PDFs: it has typos, Hinglish, Hindi, broken punctuation, page footers, and the candidate's own notes mixed in.
Rules:
- Keep every question the board asked, in order. One entry per question; split run-on lines that contain several questions.
- The question text: a clean, complete English sentence ending in "?". Translate Hindi/Hinglish to English. Fix spelling. Never invent content that is not in the source.
- The asker: "chairman", "m1".."m5" (member number as written), "member" (a member with no number), or "unknown".
- Follow-up: 1 when it follows up the previous question, else 0.
- The note: what the candidate says they answered, or how the board reacted, in one short sentence ("" if none).
- Remove the candidate's real name anywhere it appears; write [name].
- Skip greetings, "thank you, your interview is over", and the candidate's commentary about mocks/coaching/experience (put a one-line summary of the experience in "experience").`;

const TOPIC_IDS = TOPICS.map((t) => t.id).concat(['personal', 'general']);

const geminiPrompt = (blocks) => `Parse the interview transcripts below. Each block is marked === BLOCK n ===. A block normally holds one candidate's transcript, but may hold two (return both) or only noise (return nothing for it).

Return JSON: {"transcripts":[{
 "block": n,
 "profile": {"board": "chairperson's name without Sir/Madam/Shri", "date": "", "session": "FN|AN|", "optional": "", "homeState": "Indian state", "homeDistrict": "", "education": ["degree, discipline, institution"], "work": ["role, organisation"], "hobbies": [""], "achievements": ["NCC, awards, papers, positions"], "keywords": ["other DAF keywords"], "servicePreference": ""},
 "experience": "",
 "q": [["asker", "question text", 0, "hooks", "topics", "note"]]
}]}
Each entry of "q" is one question, as an array of exactly six items, in this order:
 1. asker
 2. question text
 3. follow-up: 1 or 0
 4. hooks: what in the candidate's DAF (profile) the question was anchored to, as "type:value" pairs joined by "|", e.g. "hobby:cricket|home:meerut"; type is one of ${Object.keys(HOOK_TYPES).join(', ')}; value is the DAF item in lower case ('cricket', 'iit bombay', 'meerut', 'psir'), or empty for the area only ("optional:"); "" for general or current-affairs questions
 5. topics: up to two of ${TOPIC_IDS.join(', ')}, joined by ","
 6. note: "" if none

${blocks.map((b) => `=== BLOCK ${b.n} ===\n${b.text}`).join('\n\n')}`;

// ["m2", "Why PSIR?", 1, "optional:psir|hobby:", "polity", "said..."] -> a question object.
const fromRow = (row) => {
  if (!Array.isArray(row)) return row && typeof row === 'object' ? row : null; // tolerate the old object form
  const [asker, text, followUp, hooks, topics, note] = row;
  return {
    asker: String(asker || 'unknown'),
    text: String(text || ''),
    followUp: followUp === 1 || followUp === true || followUp === '1',
    note: String(note || ''),
    hooks: String(hooks || '').split('|').map((h) => h.trim()).filter(Boolean).map((h) => {
      const k = h.indexOf(':');
      return k < 0 ? { type: h.toLowerCase(), value: '' } : { type: h.slice(0, k).trim().toLowerCase(), value: h.slice(k + 1).trim().toLowerCase() };
    }).filter((h) => HOOK_TYPES[h.type]),
    topics: String(topics || '').split(',').map((t) => t.trim()).filter(Boolean)
  };
};

const parseGemini = async (year) => {
  if (!(await checkGemini())) throw new Error(`Gemini is not available: ${geminiStatus().lastError || 'GEMINI_API_KEY is not set'}`);
  // --limit N parses only the first N chunks into <year>.gemini.pilot.json (to check quality, speed and
  // cost before a full run). The chunk cache is shared, so a later full run reuses the pilot's work.
  const limit = Number(opt('limit', 0)) || 0;
  // Chunk on the heuristic parser's transcript boundaries so a transcript is never cut in half.
  const heurPath = path.join(PARSED, `${year}.heuristic.json`);
  if (!exists(heurPath)) await parseHeuristic(year);
  const { transcripts: heur } = await readJson(heurPath);
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const t of heur) {
    const text = t.rawText.slice(0, 14000);
    if (cur.length && (size + text.length > 12000 || cur.length >= 4)) { chunks.push(cur); cur = []; size = 0; }
    cur.push({ n: cur.length + 1, text, pageStart: t.pageStart, pageEnd: t.pageEnd, heur: t });
    size += text.length;
  }
  if (cur.length) chunks.push(cur);
  if (limit) chunks.splice(limit);

  const cacheDir = path.join(CACHE, 'gemini-parse', String(year));
  const started = Date.now();
  let outChars = 0;
  await fs.mkdir(cacheDir, { recursive: true });
  const results = new Array(chunks.length);
  let done = 0;
  let failed = 0;
  await pool(chunks, Number(opt('concurrency', 4)), async (blocks, ci) => {
    const hash = crypto.createHash('sha1').update(GEMINI_SYSTEM + blocks.map((b) => b.text).join('\n')).digest('hex').slice(0, 12);
    const file = path.join(cacheDir, `${String(ci).padStart(4, '0')}-${hash}.json`);
    if (exists(file)) { results[ci] = { blocks, data: await readJson(file) }; done++; return; }
    try {
      const data = await generateJson({ system: GEMINI_SYSTEM, prompt: geminiPrompt(blocks), temperature: 0.1, maxOutputTokens: 32000, retries: 3 });
      outChars += JSON.stringify(data).length;
      await writeJson(file, data);
      results[ci] = { blocks, data };
    } catch (err) {
      failed++;
      console.warn(`  chunk ${ci} failed: ${String(err.message).slice(0, 160)}`);
      if (err.name === 'GeminiUnavailableError') throw err;
    }
    done++;
    if (done % 20 === 0) console.log(`  ${year}: ${done}/${chunks.length} chunks`);
  });

  // Chunks Gemini couldn't do fall back to the heuristic parse of the same blocks.
  const transcripts = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const r = results[ci];
    const list = Array.isArray(r?.data?.transcripts) ? r.data.transcripts : null;
    if (!list) {
      for (const b of chunks[ci]) transcripts.push(b.heur);
      continue;
    }
    for (const t of list) {
      const block = chunks[ci].find((b) => b.n === Number(t.block)) || chunks[ci][0];
      const qs = (t.q || t.questions || []).map(fromRow).filter((q) => q && q.text);
      if (qs.length < 2) continue;
      transcripts.push({
        pageStart: block.pageStart,
        pageEnd: block.pageEnd,
        profile: t.profile || {},
        experience: t.experience || '',
        rawText: block.text,
        questions: qs.map((q, i) => ({ ...q, order: i + 1 }))
      });
    }
  }
  transcripts.forEach((t, i) => { t.seq = i + 1; });
  const out = path.join(PARSED, `${year}.gemini${limit ? '.pilot' : ''}.json`);
  await writeJson(out, { year, engine: 'gemini', parsedAt: new Date().toISOString(), failedChunks: failed, transcripts });
  const inChars = chunks.reduce((n, c) => n + c.reduce((m, b) => m + b.text.length, 0), 0);
  console.log(`${year}: ${transcripts.length} transcripts, ${transcripts.reduce((n, t) => n + t.questions.length, 0)} questions (gemini, ${failed} chunk(s) fell back) -> ${path.basename(out)}`);
  console.log(`  ${chunks.length} chunks in ${Math.round((Date.now() - started) / 1000)}s; ~${Math.round(inChars / 4 / 1000)}k input tokens of transcript text, ~${Math.round(outChars / 4 / 1000)}k output tokens (new chunks only)`);
  if (usageTotals.calls) console.log(`  billed by ${GEMINI_MODEL} so far: ${usageTotals.calls} calls, ${usageTotals.input} input, ${usageTotals.output} output, ${usageTotals.thinking} thinking tokens`);
};

// ------------------------------------------------------------------ embeddings

const loadEmbeddings = async () => {
  const map = new Map();
  if (!exists(EMB_FILE)) return map;
  const lines = (await fs.readFile(EMB_FILE, 'utf8')).split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const { k, v } = JSON.parse(line);
      // Small Buffers are slices of Node's shared 8 KB pool: copy only this vector's bytes, not
      // `.buffer` (the whole pool), or every vector comes back 2048 floats long and mostly other data.
      const b = Buffer.from(v, 'base64');
      if (b.byteLength !== EMBEDDING_DIMS * 4) continue;
      map.set(k, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    } catch { /* partial last line of an interrupted run */ }
  }
  return map;
};

const embed = async () => {
  if (!aiAvailable()) throw new Error(`Gemini is not available: ${geminiStatus().lastError || 'GEMINI_API_KEY is not set'}`);
  const parsed = await loadParsed();
  const have = await loadEmbeddings();
  const texts = [...new Set(parsed.flatMap((p) => p.transcripts.flatMap((t) => t.questions.map((q) => normalizeText(q.text)))))].filter((k) => k && !have.has(k));
  console.log(`embedding ${texts.length} new question texts (${have.size} cached)`);
  await fs.mkdir(path.dirname(EMB_FILE), { recursive: true });
  const out = fsSync.createWriteStream(EMB_FILE, { flags: 'a' });
  const batches = [];
  for (let i = 0; i < texts.length; i += 100) batches.push(texts.slice(i, i + 100));
  let done = 0;
  await pool(batches, Number(opt('concurrency', 2)), async (batch) => {
    const vecs = await embedTexts(batch, { taskType: 'SEMANTIC_SIMILARITY' });
    batch.forEach((k, i) => out.write(JSON.stringify({ k, v: Buffer.from(vecs[i].buffer).toString('base64') }) + '\n'));
    done += batch.length;
    if (done % 2000 < 100) console.log(`  ${done}/${texts.length}`);
  });
  await new Promise((r) => out.end(r));
  console.log('embeddings done');
};

// ------------------------------------------------------------------ build

// The best parse available for each year: Gemini when it exists, otherwise the heuristic one.
const loadParsed = async () => {
  if (!exists(PARSED)) return [];
  const files = await fs.readdir(PARSED);
  const years = [...new Set(files.map((f) => f.match(/^(\d{4})\./)?.[1]).filter(Boolean))].sort();
  const out = [];
  for (const y of years) {
    const g = path.join(PARSED, `${y}.gemini.json`);
    const h = path.join(PARSED, `${y}.heuristic.json`);
    const p = exists(g) ? g : exists(h) ? h : null;
    if (!p) continue;
    const data = await readJson(p);
    out.push({ year: Number(y), engine: data.engine, transcripts: data.transcripts });
  }
  return out;
};

const build = async () => {
  const parsed = await loadParsed();
  if (!parsed.length) throw new Error('Nothing parsed yet - run `pipeline.mjs parse` first');
  const embeddings = await loadEmbeddings();
  const t0 = Date.now();
  const corpus = buildCorpus(parsed, { embeddings: embeddings.size ? embeddings : null });
  // Family vectors = mean of member vectors (re-normalised); seeded as int8 for the runtime search.
  if (embeddings.size) {
    const sums = new Map();
    for (const q of corpus.questions) {
      const v = embeddings.get(normalizeText(q.text));
      if (!v || !q.familyKey) continue;
      if (!sums.has(q.familyKey)) sums.set(q.familyKey, new Float32Array(v.length));
      const s = sums.get(q.familyKey);
      for (let i = 0; i < v.length; i++) s[i] += v[i];
    }
    for (const f of corpus.families) {
      const s = sums.get(f.key);
      if (!s) continue;
      const n = Math.sqrt(s.reduce((a, x) => a + x * x, 0)) || 1;
      f.vec = Buffer.from(Int8Array.from(s, (x) => Math.round((x / n) * 127)).buffer).toString('base64');
    }
  }
  const stats = corpusStats(corpus);
  await writeJson(CORPUS, { builtAt: new Date().toISOString(), engines: Object.fromEntries(parsed.map((p) => [p.year, p.engine])), stats, ...corpus });
  console.log(`corpus: ${stats.transcripts} transcripts (${corpus.reposts} reposted duplicates left out), ${stats.questions} questions, ${stats.families} families (${stats.repeatedFamilies} asked in 2+ interviews), ${embeddings.size ? 'with' : 'without'} embeddings, ${Date.now() - t0}ms`);
};

// ------------------------------------------------------------------ seed

const seed = async () => {
  if (!exists(CORPUS)) throw new Error('No corpus.json - run `pipeline.mjs build` first');
  const uri = opt('uri', process.env.MONGODB_URI);
  if (!uri) throw new Error('Set MONGODB_URI (or pass --uri)');
  const { default: mongoose } = await import('mongoose');
  const { seedCorpus } = await import('../../lib/interview/seed.js');
  await mongoose.connect(uri);
  const corpus = await readJson(CORPUS);
  const t0 = Date.now();
  const res = await seedCorpus(corpus, { log: (m) => console.log(m) });
  console.log(`seeded ${res.transcripts} transcripts, ${res.questions} questions, ${res.families} families in ${Math.round((Date.now() - t0) / 1000)}s`);
  await mongoose.disconnect();
};

// ------------------------------------------------------------------ main

const main = async () => {
  const engine = opt('engine', 'heuristic');
  switch (cmd) {
    case 'parse':
      for (const y of await pageYears()) {
        if (engine === 'gemini') await parseGemini(y);
        else await parseHeuristic(y);
      }
      break;
    case 'embed': await embed(); break;
    case 'build': await build(); break;
    case 'seed': await seed(); break;
    case 'all':
      for (const y of await pageYears()) await parseHeuristic(y);
      if (aiAvailable()) {
        for (const y of await pageYears()) await parseGemini(y);
        await embed();
      } else {
        console.log(`(Gemini not available - ${geminiStatus().lastError || 'no key'} - using the no-AI parse only)`);
      }
      await build();
      await seed();
      break;
    default:
      console.log(fsSync.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 17).join('\n'));
      process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
