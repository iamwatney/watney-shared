/**
 * Unit tests for @watney/shared/llm-usage.
 * Run with: node --test test/*.test.js (after `npm run build`).
 */
const test = require('node:test');
const assert = require('node:assert');

const { logLlmUsage, estimateCostGbp, MODEL_PRICES } = require('../dist/llm-usage');

test('estimateCostGbp returns 0 for zero tokens', () => {
  assert.strictEqual(estimateCostGbp('claude-haiku-4-5', 0, 0), 0);
});

test('estimateCostGbp falls back to sonnet pricing on unknown model', () => {
  const a = estimateCostGbp('not-a-real-model', 1_000_000, 1_000_000);
  const b = estimateCostGbp('claude-sonnet-4-6', 1_000_000, 1_000_000);
  assert.strictEqual(a, b);
});

test('MODEL_PRICES has expected entries', () => {
  assert.ok(MODEL_PRICES['claude-haiku-4-5']);
  assert.ok(MODEL_PRICES['claude-sonnet-4-6']);
  assert.ok(MODEL_PRICES['claude-opus-4-7']);
});

test('logLlmUsage is a no-op when env missing and no client passed', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const result = await logLlmUsage({
      endpoint: 'test',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
    });
    assert.strictEqual(result, undefined);
  } finally {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});
