/**
 * Unit tests for @watney/shared/outcomes (v1.4.0+).
 */
const test = require('node:test');
const assert = require('node:assert');

const { logOutcome } = require('../dist/outcomes');

test('logOutcome is a no-op when env missing and no client passed', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const result = await logOutcome({
      llmUsageLogId: '11111111-1111-1111-1111-111111111111',
      outcome: 'success',
      outcomeSignal: 'derived',
    });
    assert.strictEqual(result, undefined);
  } finally {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});

test('logOutcome SDK path inserts a row with required + optional fields', async () => {
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
  await logOutcome(
    {
      llmUsageLogId: '22222222-2222-2222-2222-222222222222',
      outcome: 'failure',
      outcomeSignal: 'user-correction',
      evidenceUrl: 'https://example.com/session/123',
      notes: 'caller corrected the model output',
    },
    { client: stubClient },
  );
  assert.strictEqual(captured.table, 'outcomes');
  assert.strictEqual(captured.rows.length, 1);
  const r = captured.rows[0];
  assert.strictEqual(r.llm_usage_log_id, '22222222-2222-2222-2222-222222222222');
  assert.strictEqual(r.outcome, 'failure');
  assert.strictEqual(r.outcome_signal, 'user-correction');
  assert.strictEqual(r.evidence_url, 'https://example.com/session/123');
  assert.strictEqual(r.revised_by_decision_id, null);
  assert.strictEqual(r.notes, 'caller corrected the model output');
});

test('logOutcome SDK path coerces all optional fields to null when omitted', async () => {
  let captured = null;
  const stubClient = {
    from() {
      return {
        insert(rows) {
          captured = rows.slice();
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  await logOutcome(
    {
      llmUsageLogId: '33333333-3333-3333-3333-333333333333',
      outcome: 'success',
      outcomeSignal: 'silence',
    },
    { client: stubClient },
  );
  const r = captured[0];
  assert.strictEqual(r.evidence_url, null);
  assert.strictEqual(r.revised_by_decision_id, null);
  assert.strictEqual(r.notes, null);
});

test('logOutcome SDK path logs but does not throw when insert returns an error', async () => {
  const origErr = console.error;
  let errCaptured = null;
  console.error = (...args) => { errCaptured = args; };
  try {
    const stubClient = {
      from() {
        return {
          insert() {
            return Promise.resolve({ error: { message: 'duplicate key on llm_usage_log_id' } });
          },
        };
      },
    };
    const result = await logOutcome(
      {
        llmUsageLogId: '44444444-4444-4444-4444-444444444444',
        outcome: 'success',
        outcomeSignal: 'derived',
      },
      { client: stubClient },
    );
    assert.strictEqual(result, undefined);
    assert.ok(errCaptured, 'console.error should have been called');
    assert.match(String(errCaptured[0] || ''), /\[outcomes\] insert failed/);
  } finally {
    console.error = origErr;
  }
});

test('logOutcome SDK path swallows thrown errors and logs (never propagates)', async () => {
  const origErr = console.error;
  let errCaptured = null;
  console.error = (...args) => { errCaptured = args; };
  try {
    const stubClient = {
      from() {
        return {
          insert() {
            throw new Error('boom');
          },
        };
      },
    };
    const result = await logOutcome(
      {
        llmUsageLogId: '55555555-5555-5555-5555-555555555555',
        outcome: 'success',
        outcomeSignal: 'derived',
      },
      { client: stubClient },
    );
    assert.strictEqual(result, undefined);
    assert.ok(errCaptured, 'console.error should have been called');
  } finally {
    console.error = origErr;
  }
});
