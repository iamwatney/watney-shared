/**
 * v1.4.0 backwards-compatibility tests.
 *
 * Asserts that an LlmUsageEvent shaped like the v1.3.1 caller still:
 *   (a) typechecks against the v1.4.0 interface (compile-time, verified
 *       implicitly via tsc in `npm run typecheck`)
 *   (b) is accepted at runtime by logLlmUsage without throwing
 *   (c) is a no-op when no env / no client is configured
 *
 * No network call here — the test runs the no-env path (covered by
 * llm-usage.test.js for the canonical case) and an SDK-stub path that
 * verifies the row builder coerces undefined optional fields to null.
 */
const test = require('node:test');
const assert = require('node:assert');

const { logLlmUsage } = require('../dist/llm-usage');

test('logLlmUsage accepts a v1.3.1-shaped event (no new fields) without throwing', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const result = await logLlmUsage({
      endpoint: 'legacy-call-site',
      model: 'claude-haiku-4-5',
      inputTokens: 50,
      outputTokens: 25,
      // No clientId / sessionId / apiKeyName — v1.3.1 minimal shape.
    });
    assert.strictEqual(result, undefined);
  } finally {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});

test('logLlmUsage SDK path builds row with all-null new fields when omitted (v1.3.1 caller)', async () => {
  let captured = null;
  const stubClient = {
    from(table) {
      return {
        insert(rows) {
          captured = { table, rows: rows.slice() };
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  await logLlmUsage(
    {
      endpoint: 'legacy-call-site',
      model: 'claude-haiku-4-5',
      inputTokens: 50,
      outputTokens: 25,
      clientId: null,
      sessionId: null,
      apiKeyName: null,
    },
    { client: stubClient },
  );
  assert.strictEqual(captured.table, 'llm_usage_log');
  assert.strictEqual(captured.rows.length, 1);
  const r = captured.rows[0];
  assert.strictEqual(r.endpoint, 'legacy-call-site');
  assert.strictEqual(r.model, 'claude-haiku-4-5');
  assert.strictEqual(r.input_tokens, 50);
  assert.strictEqual(r.output_tokens, 25);
  // v1.4.0 new columns must be present in the row, set to null:
  assert.strictEqual(r.decision_id, null, 'decision_id should default to null when omitted');
  assert.strictEqual(r.agent_name, null, 'agent_name should default to null when omitted');
  assert.strictEqual(r.prompt_version, null, 'prompt_version should default to null when omitted');
  assert.strictEqual(r.outcome_id, null, 'outcome_id should default to null when omitted');
});

test('logLlmUsage SDK path populates new fields when provided (v1.4.0 caller)', async () => {
  let captured = null;
  const stubClient = {
    from(table) {
      return {
        insert(rows) {
          captured = { table, rows: rows.slice() };
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  await logLlmUsage(
    {
      endpoint: 'cloud-run-causal-retro',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      decisionId: '2026-05-27-autonomous-systems-upgrade-architecture',
      agentName: 'causal-retro',
      promptVersion: 'causal-retro@v1',
      outcomeId: null,
    },
    { client: stubClient },
  );
  const r = captured.rows[0];
  assert.strictEqual(r.decision_id, '2026-05-27-autonomous-systems-upgrade-architecture');
  assert.strictEqual(r.agent_name, 'causal-retro');
  assert.strictEqual(r.prompt_version, 'causal-retro@v1');
  assert.strictEqual(r.outcome_id, null);
});
