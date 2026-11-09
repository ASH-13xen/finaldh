// Unit tests for the interview-transcript pipeline: the no-AI parser on the layouts the five compilations
// use, name/board normalisation, DAF hook tagging and question families. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYear } from '../lib/interview/heuristicParser.js';
import { canonicalBoard, canonicalState, tokenize } from '../lib/interview/text.js';
import { hooksFor, profileTerms, topicsFor, qtypeFor, shelfLifeFor } from '../lib/interview/taxonomy.js';
import { buildCorpus, maskHook } from '../lib/interview/corpus.js';

const page = (text, n = 1) => ({ page: n, text });

test('2024 layout: each Telegram post header starts a transcript; DAF keywords and members are read', () => {
  const text = [
    'Interview Transcripts (CSPT-2024), [Jan 7, 2025 at 3:50 PM]',
    'Name - Polar Bear',
    'Board- Shri BB Swain Sir',
    'DAF Keywords- Meerut, IIT Bombay, ECE, Cricket, kabbadi, NCC',
    'Chairman Sir',
    '- Out of cricket and kabbadi, which one you like most? Why?',
    '- History of kabbadi and mahabharat relation?',
    'Member 1:',
    '- corruption in judiciary? Any law in place to address this?',
    'Member 2:',
    '- NCC me kya sikha? Don\'t you think it should be made compulsory?',
    'https://t.me/csetranscripts/25',
    'Interview Transcripts (CSPT-2024), [Jan 8, 2025 at 9:00 AM]',
    'Board - Dinesh Dasa sir',
    'Optional - PSIR',
    'Chairman',
    '1. Why civil services?',
    '2. What is net neutrality?',
    'M1',
    '1. Role of Global South?'
  ].join('\n');
  const ts = parseYear([page(text)], 2024);
  assert.equal(ts.length, 2);
  assert.equal(ts[0].profile.board, 'B.B. Swain');
  assert.ok(ts[0].profile.keywords.includes('Cricket'));
  assert.equal(ts[0].profile.homeState, 'Uttar Pradesh', 'Meerut implies the home state');
  assert.deepEqual(ts[0].questions.map((q) => q.asker), ['chairman', 'chairman', 'm1', 'm2']);
  assert.ok(!('name' in ts[0].profile), 'the candidate name is never kept');
  assert.equal(ts[1].profile.board, 'Dinesh Dasa');
  assert.equal(ts[1].profile.optional, 'PSIR');
  assert.equal(ts[1].questions[2].asker, 'm1');
});

test('2021 layout: broken encoding is repaired, run-on numbered questions are split, answers become notes', () => {
  const text = [
    'Name¦ thomas shelby',
    'Date¦ may 2 , forenoon session',
    'Board¦ BB vyas sir',
    'Optional¦ public administration',
    'Hobbies² interest¦ kinesics, cricket',
    'Chairman¦',
    '1 You were waiting outside for 5 hours What were you doing ¬I said I talked to people­ 2 What did you learn 3 BRI does it excite you',
    'M1Maam',
    '1\u0091 You are from Bihar Tell me 2 famous things about your district',
    ': Why is it famous',
    'Experience¦ cordial board'
  ].join('\n');
  const [t] = parseYear([page(text)], 2021);
  assert.equal(t.profile.board, 'B.B. Vyas');
  assert.equal(t.profile.optional, 'Public Administration');
  assert.equal(t.profile.session, 'FN');
  const texts = t.questions.map((q) => q.text);
  assert.ok(texts.includes('What did you learn'), texts.join(' | '));
  assert.ok(texts.some((x) => x.startsWith('You were waiting outside for 5 hours')));
  assert.match(t.questions.find((q) => q.text.startsWith('You were waiting')).note, /talked to people/);
  assert.equal(t.questions.find((q) => q.text.startsWith('You are from Bihar')).asker, 'm1');
  assert.match(t.experience, /cordial/);
});

test('speaker labels and remarks are not mistaken for questions', () => {
  const text = [
    'Board: Smita Nagaraj mam',
    'Optional: Sociology',
    'Chairperson:',
    '1. Tell us about yourself?',
    '2. Why sociology?',
    'Member 1: Lady Member',
    '1. Do you know Georgia Meloni?',
    '3rd Member',
    'What is GI tag?',
    'Cant remember more',
    '20th April',
    'Thank you, your interview is over.'
  ].join('\n');
  const [t] = parseYear([page(text)], 2022);
  const texts = t.questions.map((q) => q.text);
  assert.deepEqual(texts, ['Tell us about yourself?', 'Why sociology?', 'Do you know Georgia Meloni?', 'What is GI tag?']);
  assert.equal(t.questions[2].asker, 'm1');
  assert.equal(t.questions[3].asker, 'm3');
});

test('a profile block after the questions starts the next transcript', () => {
  const text = [
    'Board: Manoj Soni Sir', 'Chairman', '1. Why civil services?', '2. What is federalism?', '3. What is NITI Aayog?',
    'Name: X', 'Date: 12/05/2022', 'Board: R N Choube sir', 'Chairman', '1. What is your hobby?', '2. Why did you leave your job?', '3. What is DBT?'
  ].join('\n');
  const ts = parseYear([page(text)], 2021);
  assert.equal(ts.length, 2);
  assert.equal(ts[1].profile.board, 'R.N. Choubey');
});

test('board names: honorifics, spellings and comments', () => {
  assert.equal(canonicalBoard("Hon'ble Sheelvardhan sir"), 'Sheel Vardhan Singh');
  assert.equal(canonicalBoard('Sanjay Verms'), 'Sanjay Verma');
  assert.equal(canonicalBoard('Smitha Nagraj maam'), 'Smita Nagaraj');
  assert.equal(canonicalBoard('Air marshal bhosle sir'), 'Ajit Bhonsle');
  assert.equal(canonicalBoard('Manoj Soni Sir,Forenoon, first to go.,24.08.2021'), 'Manoj Soni');
  assert.equal(canonicalBoard('was very cordial'), '');
  assert.equal(canonicalBoard('Some New Person'), '', 'unknown names are dropped from the keyword parser');
  assert.equal(canonicalBoard('Some New Person', { allowUnknown: true }), 'Some New Person');
  assert.equal(canonicalState('UP'), 'Uttar Pradesh');
  assert.equal(canonicalState('orissa'), 'Odisha');
});

test('DAF hooks: profile words, multi-word items and area phrases', () => {
  const terms = profileTerms({ hobbies: ['Cricket'], keywords: ['IIT Bombay', 'Women empowerment cell'], homeState: 'Bihar' });
  assert.deepEqual(hooksFor('Who is your favourite cricket player?', terms), [{ type: 'hobby', value: 'cricket' }]);
  assert.ok(hooksFor('Tell me about Bombay floods', terms).some((h) => h.value === 'iit bombay'));
  assert.equal(hooksFor('Is reservation for women a good thing?', terms).length, 0, 'one word of a multi-word item is not enough');
  assert.ok(hooksFor('What is famous in your district?', terms).some((h) => h.type === 'home'));
  assert.ok(hooksFor('Why civil services?', terms).some((h) => h.type === 'motivation'));
});

test('topic, question type and shelf life', () => {
  assert.equal(topicsFor('What is the role of the Supreme Court in protecting fundamental rights?')[0], 'polity');
  assert.equal(topicsFor('How do you see India-China relations?')[0], 'ir');
  assert.equal(qtypeFor('As a DM how will you handle floods in your district?'), 'situational');
  assert.equal(qtypeFor('Do you think the UN needs reform?'), 'opinion');
  assert.equal(qtypeFor('What is green hydrogen?'), 'factual');
  assert.equal(shelfLifeFor('What happened recently in Bangladesh?'), 'event');
  assert.equal(shelfLifeFor('What is federalism?'), 'evergreen');
});

test('families group the same question across interviews; {X} templates mask the DAF item', () => {
  const mk = (seq, board, hobby, qs) => ({ seq, profile: { boardRaw: board, hobbies: [hobby] }, questions: qs.map((text, i) => ({ order: i + 1, asker: 'chairman', text })) });
  const corpus = buildCorpus([{
    year: 2023,
    engine: 'heuristic',
    transcripts: [
      mk(1, 'Dinesh Dasa', 'chess', ['What is net neutrality?', 'History of chess?', 'Why civil services?']),
      mk(2, 'Suman Sharma', 'cricket', ['What is net neutrality, sir?', 'History of cricket?', 'Why civil services?']),
      mk(3, 'B B Swain', 'kabaddi', ['Net neutrality - what is it?', 'History of kabaddi?', 'Why?'])
    ]
  }]);
  const nn = corpus.families.find((f) => /neutrality/i.test(f.text));
  assert.equal(nn.transcriptCount, 3);
  assert.deepEqual(nn.boards.sort(), ['B.B. Swain', 'Dinesh Dasa', 'Suman Sharma']);
  const cs = corpus.families.find((f) => /civil services/i.test(f.text));
  assert.equal(cs.transcriptCount, 2);
  assert.ok(corpus.questions.find((q) => q.text === 'Why?').trivial, '"Why?" stays out of the bank');
  const hist = corpus.questions.filter((q) => q.patternText === 'History of {X}?');
  assert.equal(hist.length, 3);
  assert.equal(new Set(hist.map((q) => q.pattern)).size, 1);
  assert.deepEqual(maskHook('Do you play cricket?', 'cricket', 'hobby'), { pattern: 'play xhookx', patternText: 'Do you play {X}?', type: 'hobby' });
  assert.ok(tokenize('Kabbadi rules').includes('kabaddi'));
});
