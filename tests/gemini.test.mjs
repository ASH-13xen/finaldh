// The Gemini client tells a billing block (spending cap reached, prepaid credit used up) from a bad key and
// from a passing rate limit, and keeps AI marked off - with Google's message - until it's really back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key-not-real';
const { isBillingError, geminiStatus, checkGemini, generateFromUrls } = await import('../lib/interview/gemini.js');

test('billing blocks are told apart from bad keys and rate limits', () => {
  assert.equal(isBillingError(new Error('[429 Too Many Requests] Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend')), true);
  assert.equal(isBillingError(new Error('Your prepayment credits are depleted.')), true);
  assert.equal(isBillingError(new Error('[402] Payment Required')), true);
  assert.equal(isBillingError(new Error('You exceeded your current quota, please check your plan and billing details.')), true);
  assert.equal(isBillingError(new Error('[429] Resource has been exhausted (e.g. check quota).')), false, 'a passing rate limit is retried, not a block');
  assert.equal(isBillingError(new Error('[400] API key not valid. Please pass a valid API key.')), false);
});

test('a spending cap turns AI off with the reason, and the free model check does not turn it back on', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/models?')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 429, message: 'Your project has exceeded its monthly spending cap.', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
  };
  try {
    assert.equal(await checkGemini(), true, 'the free model list still answers');
    await assert.rejects(generateFromUrls({ prompt: 'hi', retries: 3 }), (err) => err.name === 'GeminiUnavailableError');
    assert.equal(calls.filter((u) => u.includes(':generateContent')).length, 1, 'no retries against a spending cap');
    const s = geminiStatus();
    assert.equal(s.available, false);
    assert.equal(s.billingBlocked, true);
    assert.match(s.lastError, /spending cap/);
    const before = calls.length;
    assert.equal(await checkGemini(), false, 'still off: not rechecked within the window');
    assert.equal(calls.length, before, 'and no call was made to find out');
    await assert.rejects(generateFromUrls({ prompt: 'hi' }), (err) => err.name === 'GeminiUnavailableError');
    assert.equal(calls.length, before, 'requests stop at the door while blocked');
  } finally {
    globalThis.fetch = realFetch;
  }
});
