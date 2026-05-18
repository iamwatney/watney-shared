/**
 * Integration tests for @watney/shared/credentials.
 *
 * Some tests hit live DB/SM (cockpit Supabase + watney-workflows GCP SM).
 * Run only when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 *
 * These tests are NOT part of the default npm test run (only run via
 * `node --test test/credentials-integration.test.js` explicitly) to avoid
 * polluting CI / pre-commit with network calls.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  getOrCreateCredential,
  getCredentialMetadata,
  buildCanonicalName,
  CanonicalNameError,
} = require('../dist/credentials');

const LIVE = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Scenario 2: Naming convention ─────────────────────────────────────────
test('naming convention: lowercase scope segment rejected', () => {
  assert.throws(
    () => buildCanonicalName({ scope: 'edge_ai', vendor: 'ANTHROPIC', purpose: 'X' }),
    CanonicalNameError,
  );
});

test('naming convention: empty purpose rejected', () => {
  assert.throws(
    () => buildCanonicalName({ scope: 'EDGE_AI', vendor: 'ANTHROPIC', purpose: '' }),
    CanonicalNameError,
  );
});

test('naming convention: invalid env rejected', () => {
  assert.throws(
    () => buildCanonicalName({ scope: 'EDGE_AI', vendor: 'VERCEL', purpose: 'TOKEN', env: 'PRODUCTION' }),
    CanonicalNameError,
  );
});

// ── Scenario 1: Anti-duplicate (LIVE) ─────────────────────────────────────
test('anti-duplicate: getOrCreate on existing credential returns existing', { skip: !LIVE }, async () => {
  // Use an existing canonical-conforming credential.
  // EDGE_AI_ANTHROPIC_API_KEY has canonical_name set after S2 backfill.
  const result = await getOrCreateCredential({
    scope: 'EDGE_AI',
    vendor: 'ANTHROPIC',
    purpose: 'API_KEY',
    requester: 'test:anti-duplicate',
    context: 'Integration test scenario 1',
    overrideName: 'EDGE_AI_ANTHROPIC_API_KEY',
  });
  assert.strictEqual(result.created, false, 'must return existing, not create');
  assert.strictEqual(result.canonicalName, 'EDGE_AI_ANTHROPIC_API_KEY');
  assert.ok(result.dbId, 'must return dbId');
});

// ── Read-only metadata fetch (LIVE) ───────────────────────────────────────
test('getCredentialMetadata returns row for existing canonical name', { skip: !LIVE }, async () => {
  const row = await getCredentialMetadata('EDGE_AI_ANTHROPIC_API_KEY');
  assert.ok(row, 'must return row');
  assert.strictEqual(row.canonical_name, 'EDGE_AI_ANTHROPIC_API_KEY');
  assert.strictEqual(row.vendor, 'anthropic');
});

test('getCredentialMetadata returns null for missing name', { skip: !LIVE }, async () => {
  const row = await getCredentialMetadata('NONEXISTENT_CREDENTIAL_XYZ_TEST_999');
  assert.strictEqual(row, null);
});
