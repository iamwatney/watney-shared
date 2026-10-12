/**
 * v1.7.0 pricing tests for @watney/shared/llm-usage.
 *
 * CURRENT_MODELS is the list of Anthropic first-party model ids and their
 * published base prices (USD / MTok, platform.claude.com pricing page,
 * checked 2026-10-12). When Anthropic ships a model, add it here first —
 * this test then fails until MODEL_PRICES carries it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { estimateCostGbp, MODEL_PRICES } = require('../dist/llm-usage');

const CURRENT_MODELS = {
  'claude-fable-5-1':  [10, 50],
  'claude-fable-5':    [10, 50],
  'claude-opus-5-5':   [4, 20],
  'claude-opus-5':     [5, 25],
  'claude-opus-4-8':   [5, 25],
  'claude-opus-4-7':   [5, 25],
  'claude-opus-4-6':   [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5':   [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5':  [0.1, 0.5],
  'claude-haiku-4-5':  [1, 5],
};

const USD_TO_GBP = 0.79;

function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

for (const [model, [inUsd, outUsd]] of Object.entries(CURRENT_MODELS)) {
  test(`MODEL_PRICES prices ${model} at $${inUsd}/$${outUsd}`, () => {
    assert.ok(MODEL_PRICES[model], `${model} missing from MODEL_PRICES`);
    assert.strictEqual(MODEL_PRICES[model].inputUsdPerMTok, inUsd);
    assert.strictEqual(MODEL_PRICES[model].outputUsdPerMTok, outUsd);
  });

  test(`estimateCostGbp(${model}) uses its own price and does not warn`, () => {
    let cost;
    // 100K input stays inside every model's base (non-long-prompt) tier.
    const warnings = captureWarnings(() => { cost = estimateCostGbp(model, 100_000, 1_000_000); });
    assert.deepStrictEqual(warnings, []);
    assert.ok(Math.abs(cost - (inUsd * 0.1 + outUsd) * USD_TO_GBP) < 1e-9);
  });
}

test('legacy keys are kept for backwards compatibility', () => {
  for (const k of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20251001', 'claude-opus-4']) {
    assert.ok(MODEL_PRICES[k], `${k} missing`);
  }
  // Original Opus 4 really is $15/$75; only 4.5+ dropped to $5/$25.
  assert.strictEqual(MODEL_PRICES['claude-opus-4'].inputUsdPerMTok, 15);
});

test('unknown model warns once and still returns the Sonnet 4.6 estimate', () => {
  let a;
  const first = captureWarnings(() => { a = estimateCostGbp('claude-unknown-9', 1_000_000, 1_000_000); });
  const second = captureWarnings(() => { estimateCostGbp('claude-unknown-9', 10, 10); });
  assert.strictEqual(first.length, 1);
  assert.match(first[0], /claude-unknown-9/);
  assert.strictEqual(second.length, 0);
  assert.strictEqual(a, estimateCostGbp('claude-sonnet-4-6', 1_000_000, 1_000_000));
});

test('date-suffixed snapshot ids resolve to the base model price', () => {
  let cost;
  const warnings = captureWarnings(() => { cost = estimateCostGbp('claude-opus-4-5-20251101', 1_000_000, 0); });
  assert.deepStrictEqual(warnings, []);
  assert.ok(Math.abs(cost - 5 * USD_TO_GBP) < 1e-9);
});

test('Haiku 5.5 switches to long-prompt pricing above 100K input tokens', () => {
  const short = estimateCostGbp('claude-haiku-5-5', 100_000, 1_000_000);
  const long  = estimateCostGbp('claude-haiku-5-5', 100_001, 1_000_000);
  assert.ok(Math.abs(short - (0.1 * 0.1 + 0.5) * USD_TO_GBP) < 1e-9);
  assert.ok(Math.abs(long  - (0.100001 * 0.5 + 2.5) * USD_TO_GBP) < 1e-9);
});
