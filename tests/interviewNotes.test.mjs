// Unit tests for current-topic notes and the 100-question guide (lib/interview/notes.js, guide.js).
// Gemini is replaced by a stubbed fetch, so nothing here is billed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanUrls, sanitizeLangNote, noteSlug, matchTags, profileText, cleanTags, generateNote, sameUrlKey
} from '../lib/interview/notes.js';
import { entriesFromChoice, sanitizeGuidance, guideCandidates } from '../lib/interview/guide.js';

const NOTE = (title) => ({
  title,
  why: 'In the news since the cabinet approved it in November 2026.',
  sections: [{ heading: 'Background', points: ['One.', '  Two  '] }, { heading: 'Empty', points: [] }],
  questions: [{ q: 'What is it?', type: 'factual', answer: 'It is...' }, { q: 'Should India do it?', type: 'weird', answer: 'Yes, but...' }, { q: '', type: 'factual', answer: 'x' }],
  likelyFor: ['Engineers'],
  keywords: ['GH2']
});

test('links: http(s) only, deduplicated, at most five, from a list or one per line', () => {
  assert.deepEqual(cleanUrls('https://pib.gov.in/a\nftp://x.org/f\nnot a link\nhttps://pib.gov.in/a\nhttp://prsindia.org/b'), ['https://pib.gov.in/a', 'http://prsindia.org/b']);
  assert.equal(cleanUrls(Array.from({ length: 9 }, (_, i) => `https://example.org/${i}`)).length, 5);
  assert.deepEqual(cleanUrls(['https://localhost/x', 'javascript:alert(1)']), []);
});

test('a note is trimmed to its shape; empty sections and blank questions are dropped', () => {
  const n = sanitizeLangNote(NOTE('Green hydrogen'));
  assert.equal(n.sections.length, 1);
  assert.deepEqual(n.sections[0].points, ['One.', 'Two']);
  assert.deepEqual(n.questions.map((q) => q.type), ['factual', 'analytical'], 'unknown types become analytical');
  assert.equal(sanitizeLangNote({ ...NOTE(''), title: '' }), null);
  assert.equal(sanitizeLangNote({ title: 'x', sections: [] }), null);
});

test('links match across small differences (www, slash, parameter order)', () => {
  assert.equal(sameUrlKey('https://www.pib.gov.in/PressReleasePage.aspx?reg=3&PRID=1'), sameUrlKey('http://pib.gov.in/PressReleasePage.aspx/?PRID=1&reg=3#top'));
  assert.notEqual(sameUrlKey('https://pib.gov.in/x?PRID=1'), sameUrlKey('https://pib.gov.in/x?PRID=2'));
});

test('slugs read like the title and carry the month', () => {
  assert.equal(noteSlug('India–US trade deal: what next?', new Date('2026-11-17')), 'india-us-trade-deal-what-next-2026-11');
  assert.equal(noteSlug('', new Date('2026-01-02')), 'note-2026-01');
  assert.deepEqual(cleanTags(['Engineering', 'engineering ', '', 'Punjab']), ['engineering', 'punjab']);
});

test('"for you": tags match the DAF through common words (B.Tech -> engineering) and place names', () => {
  const engineer = profileText({ education: [{ degree: 'B.Tech', discipline: 'Mechanical', institution: 'NIT Trichy' }], homeState: 'Punjab', hobbies: ['Cricket'] });
  assert.deepEqual(matchTags(['engineering', 'punjab', 'sports', 'law'], engineer), ['engineering', 'punjab', 'sports']);
  assert.deepEqual(matchTags(['agriculture'], engineer), []);
  assert.deepEqual(matchTags(['engineering'], profileText(null)), []);
  assert.deepEqual(matchTags(['law'], profileText({ education: [{ degree: 'LLB', institution: 'NLU Delhi' }] })), ['law']);
});

test('drafting a note: written from the pages Gemini could read; unread links are reported', async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  let sent = null;
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  try {
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return reply({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: 'thinking...', thought: true }, { text: '```json\n' + JSON.stringify({ category: 'environment', tags: ['Engineering', 'energy'], sourceTitles: ['PIB release', 'Paywalled story'], en: NOTE('Green hydrogen'), hi: NOTE('हरित हाइड्रोजन') }) + '\n```' }] },
          urlContextMetadata: { urlMetadata: [
            { retrievedUrl: 'https://pib.gov.in/a', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
            { retrievedUrl: 'https://news.example.com/b', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_PAYWALL' }
          ] }
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 }
      });
    };
    const out = await generateNote({ topic: 'Green hydrogen', urls: ['https://pib.gov.in/a', 'https://news.example.com/b'], today: new Date('2026-11-17') });
    assert.deepEqual(sent.body.tools, [{ url_context: {} }], 'the URL context tool, not Google Search grounding');
    assert.match(sent.body.contents[0].parts[0].text, /https:\/\/pib\.gov\.in\/a/);
    assert.equal(out.en.title, 'Green hydrogen');
    assert.equal(out.hi.title, 'हरित हाइड्रोजन');
    assert.deepEqual(out.tags, ['engineering', 'energy']);
    assert.deepEqual(out.sources, [{ url: 'https://pib.gov.in/a', title: 'PIB release' }], 'only pages that were read are cited');
    assert.deepEqual(out.unread, ['https://news.example.com/b']);

    // Gemini reports the page under another address (a redirect): still counted as read.
    globalThis.fetch = async () => reply({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ en: NOTE('x'), hi: NOTE('y'), sourceTitles: ['PIB'] }) }] }, urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://pib.gov.in/PressReleseDetailm.aspx?PRID=9', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] } }]
    });
    const moved = await generateNote({ topic: 'X', urls: ['https://www.pib.gov.in/PressReleasePage.aspx?PRID=9&reg=3&lang=1'] });
    assert.deepEqual(moved.unread, []);
    assert.equal(moved.sources.length, 1);

    // No page could be read and no text was pasted: refuse rather than write from memory.
    globalThis.fetch = async () => reply({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ en: NOTE('x'), hi: NOTE('y') }) }] }, urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://news.example.com/b', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' }] } }]
    });
    await assert.rejects(generateNote({ topic: 'X', urls: ['https://news.example.com/b'] }), /could not open any of those links/);

    // A reply without the Hindi note is not a draft.
    globalThis.fetch = async () => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ en: NOTE('x') }) }] } }] });
    await assert.rejects(generateNote({ topic: 'X', text: 'pasted article '.repeat(30) }), /no usable Hindi note/);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  }
});

test('guide: wordings of one question are merged and counted together, most asked first', () => {
  const idx = {
    families: [
      { id: 'a', text: 'Tell us about your education and work experience.', transcriptCount: 41, years: [2023], qtype: 'personal' },
      { id: 'b', text: 'Tell me about your academic background and work experience.', transcriptCount: 28, years: [2024], qtype: 'personal' },
      { id: 'c', text: 'Why do you want to join the civil services?', transcriptCount: 96, years: [2022, 2023], qtype: 'personal' },
      { id: 'd', text: 'Why is Kerala called God\'s Own Country?', transcriptCount: 10, years: [2021], qtype: 'other' },
      { id: 'e', text: 'Rare', transcriptCount: 2, years: [2020], qtype: 'factual' }
    ]
  };
  const cands = guideCandidates(idx);
  assert.equal(cands.length, 4, 'questions asked fewer than 3 times are not offered');
  const choice = { questions: [
    { text: 'Why do you want to join the civil services?', ids: [0], type: 'motivation' },
    { text: 'Tell us about your education and work experience.', ids: [1, 2, 2, 99], type: 'personal' },
    { text: 'Duplicate that reuses an id', ids: [0] },
    { text: '', ids: [3] }
  ] };
  const entries = entriesFromChoice(cands, choice);
  assert.deepEqual(entries.map((e) => [e.text, e.timesAsked]), [['Why do you want to join the civil services?', 96], ['Tell us about your education and work experience.', 69]]);
  assert.deepEqual(entries[1].years, [2023, 2024]);
  assert.deepEqual(entries[1].familyIds, ['a', 'b']);
  assert.match(entries[0].key, /^q:[a-f0-9]{16}$/);
  assert.equal(sanitizeGuidance({ tests: '', structure: ['x'] }), null);
  assert.deepEqual(sanitizeGuidance({ tests: 'Motivation', structure: ['a', 'b'], dos: ['c'], donts: 'nope' }), { tests: 'Motivation', structure: ['a', 'b'], dos: ['c'], donts: [] });
});
