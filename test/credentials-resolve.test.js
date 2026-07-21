'use strict';
/**
 * Tests for the reuse-first resolver, the F1 fail-closed guard, and
 * metadata-only orphan registration. Runs against built dist/ via `npm test`
 * (node --test). No network — registry + SM are injected fakes.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const cred = require('../dist/credentials/index.js');

// ─── Fakes ───────────────────────────────────────────────────────────────────

function fakeRegistry(rows) {
  const events = [];
  const reg = {
    rows, events,
    async findByName(name) {
      return rows.find((r) => r.canonical_name === name || r.name === name) ?? null;
    },
    async findByCanonicalKey() { return null; },
    async listByVendor(vendor) {
      return rows.filter((r) => (r.vendor || '').toLowerCase() === vendor.toLowerCase());
    },
    async listAll() { return rows; },
    async insert(row) { const r = Object.assign({ id: 'new-' + (rows.length + 1) }, row); rows.push(r); return r; },
    async update(id, patch) { const r = rows.find((x) => x.id === id); Object.assign(r, patch); return r; },
    async insertEvent(evt) { events.push(evt); return true; },
    async countAutonomousActionsToday() { return 0; },
  };
  return reg;
}

function fakeSm(overrides = {}) {
  return Object.assign({
    async list() { return []; },
    async exists() { return false; },
    async read() { return 'value'; },
    async create() { return { resourceName: 'x', version: 1 }; },
    async addVersion() { return { version: 2 }; },
    async disableVersion() { return true; },
    async destroyVersion() { return true; },
    async latestVersion() { return 1; },
  }, overrides);
}

const NOW = new Date('2026-07-21T12:00:00Z');
const FRESH = '2026-07-21T06:00:00Z';   // 6h ago → fresh
const STALE = '2026-07-01T00:00:00Z';   // ~20d ago → stale

function row(over) {
  const name = over.name || 'NAME';
  return Object.assign({
    id: 'id-' + name, name, canonical_name: null, vendor: 'vercel',
    source_of_truth: 'gcp-secret-manager', source_location: 'watney-workflows/' + name,
    last_verified_at: FRESH, last_verified_status: 'alive',
    purpose: null, scope: null, env: null, is_canonical: null, notes: null, deprecated_at: null,
  }, over);
}

// ─── Resolver ────────────────────────────────────────────────────────────────

test('resolve: single usable candidate → resolved with access recipe', async () => {
  const reg = fakeRegistry([row({ name: 'EDGE_AI_CLOUDFLARE_DNS', vendor: 'cloudflare' })]);
  const res = await cred.resolveCredential({ vendor: 'cloudflare', registry: reg, now: NOW });
  assert.equal(res.status, 'resolved');
  assert.equal(res.best.name, 'EDGE_AI_CLOUDFLARE_DNS');
  assert.equal(res.best.freshness, 'fresh');
  assert.match(res.howToAccess, /gcloud secrets versions access latest --secret=EDGE_AI_CLOUDFLARE_DNS/);
});

test('resolve: multiple candidates, none canonical → ambiguous (never guesses)', async () => {
  const reg = fakeRegistry([
    row({ name: 'STRIPE_A', vendor: 'stripe' }),
    row({ name: 'STRIPE_B', vendor: 'stripe' }),
  ]);
  const res = await cred.resolveCredential({ vendor: 'stripe', registry: reg, now: NOW });
  assert.equal(res.status, 'ambiguous');
  assert.equal(res.candidates.length, 2);
  assert.match(res.reason, /none is marked canonical/);
});

test('resolve: multiple candidates, one is_canonical=true → resolved to canonical', async () => {
  const reg = fakeRegistry([
    row({ name: 'SUPA_OLD', vendor: 'supabase', is_canonical: false }),
    row({ name: 'SUPA_CANON', vendor: 'supabase', is_canonical: true }),
  ]);
  const res = await cred.resolveCredential({ vendor: 'supabase', registry: reg, now: NOW });
  assert.equal(res.status, 'resolved');
  assert.equal(res.best.name, 'SUPA_CANON');
  assert.equal(res.best.isCanonical, true);
});

test('resolve: legacy [CANONICAL] notes marker is honoured when is_canonical is null', async () => {
  const reg = fakeRegistry([
    row({ name: 'ANTH_A', vendor: 'anthropic', notes: 'some note' }),
    row({ name: 'ANTH_CANON', vendor: 'anthropic', notes: 'primary [CANONICAL] key' }),
  ]);
  const res = await cred.resolveCredential({ vendor: 'anthropic', registry: reg, now: NOW });
  assert.equal(res.status, 'resolved');
  assert.equal(res.best.name, 'ANTH_CANON');
});

test('resolve: [CANONICAL] but also [POTENTIAL-CONSOLIDATION-CANDIDATE] is NOT treated canonical', async () => {
  const reg = fakeRegistry([
    row({ name: 'DUP_A', vendor: 'supabase', notes: '[CANONICAL] [POTENTIAL-CONSOLIDATION-CANDIDATE]' }),
    row({ name: 'DUP_B', vendor: 'supabase', notes: 'plain' }),
  ]);
  const res = await cred.resolveCredential({ vendor: 'supabase', registry: reg, now: NOW });
  assert.equal(res.status, 'ambiguous');
});

test('resolve: no candidates → not_found with creation recommendation', async () => {
  const reg = fakeRegistry([]);
  const res = await cred.resolveCredential({ vendor: 'vercel', purpose: 'DEPLOY', scope: 'EDGE_AI', registry: reg, now: NOW });
  assert.equal(res.status, 'not_found');
  assert.equal(res.recommendation.action, 'create');
  assert.equal(res.recommendation.canonicalName, 'EDGE_AI_VERCEL_DEPLOY');
  assert.equal(res.recommendation.vendorApiCanCreate, true); // vercel adapter supports create
  assert.equal(res.recommendation.escalate, true);           // account-wide scope
});

test('resolve: purpose filter narrows candidates', async () => {
  const reg = fakeRegistry([
    row({ name: 'GH_DEPLOY', vendor: 'github', purpose: 'DEPLOY' }),
    row({ name: 'GH_SECRETS', vendor: 'github', purpose: 'SECRETS_WRITE' }),
  ]);
  const res = await cred.resolveCredential({ vendor: 'github', purpose: 'DEPLOY', registry: reg, now: NOW });
  assert.equal(res.status, 'resolved');
  assert.equal(res.best.name, 'GH_DEPLOY');
});

test('resolve: env filter excludes wrong environment, keeps env-agnostic', async () => {
  const reg = fakeRegistry([
    row({ name: 'X_PROD', vendor: 'stripe', env: 'PROD' }),
    row({ name: 'X_DEV', vendor: 'stripe', env: 'DEV' }),
  ]);
  const res = await cred.resolveCredential({ vendor: 'stripe', env: 'PROD', registry: reg, now: NOW });
  assert.equal(res.status, 'resolved');
  assert.equal(res.best.name, 'X_PROD');
});

test('resolve: all candidates dead/deprecated → ambiguous needing attention, not a false resolve', async () => {
  const reg = fakeRegistry([row({ name: 'DEADKEY', vendor: 'openai', last_verified_status: 'dead' })]);
  const res = await cred.resolveCredential({ vendor: 'openai', registry: reg, now: NOW });
  assert.equal(res.status, 'ambiguous');
  assert.match(res.reason, /dead or deprecated/);
});

test('resolve: stale canonical still resolves but flags freshness', async () => {
  const reg = fakeRegistry([row({ name: 'STALEKEY', vendor: 'tavily', last_verified_at: STALE, last_verified_status: 'alive' })]);
  const res = await cred.resolveCredential({ vendor: 'tavily', registry: reg, now: NOW });
  assert.equal(res.status, 'resolved');
  assert.equal(res.best.freshness, 'stale');
  assert.match(res.reason, /⚠/);
});

// ─── F1 fail-closed guard ─────────────────────────────────────────────────────

test('getOrCreateCredential: fails closed (OrphanSecretError) when SM secret exists with no DB row', async () => {
  const reg = fakeRegistry([]); // no DB row
  let minted = false;
  const sm = fakeSm({
    async exists() { return true; },       // orphan secret exists in SM
    async create() { minted = true; return { resourceName: 'x', version: 1 }; },
    async addVersion() { minted = true; return { version: 2 }; },
  });
  cred._resetForTests({ sm, registry: reg });
  await assert.rejects(
    () => cred.getOrCreateCredential({
      scope: 'WATNEY', vendor: 'VERCEL', purpose: 'DEPLOY',
      requester: 'test:auto-register', overrideName: 'WATNEY_VERCEL_DEPLOY',
    }),
    (err) => err && err.kind === 'orphan-secret',
  );
  assert.equal(minted, false, 'must NOT mint or write SM when refusing an orphan');
  cred._resetForTests();
});

// ─── Metadata-only orphan registration ────────────────────────────────────────

test('registerExistingSecret: inserts metadata-only row, needs_review, no mint; idempotent', async () => {
  const reg = fakeRegistry([]);
  let minted = false;
  const sm = fakeSm({
    async exists() { return true; },
    async latestVersion() { return 3; },
    async create() { minted = true; return { resourceName: 'x', version: 1 }; },
    async addVersion() { minted = true; return { version: 2 }; },
  });
  cred._resetForTests({ sm, registry: reg });

  const r1 = await cred.registerExistingSecret({ name: 'EDGE_AI_VERCEL_DEPLOY', requester: 'test:drift' });
  assert.equal(r1.registered, true);
  assert.equal(r1.created, false);          // no value minted
  assert.equal(minted, false, 'must never mint a value');
  const inserted = reg.rows.find((x) => x.name === 'EDGE_AI_VERCEL_DEPLOY');
  assert.ok(inserted, 'row inserted');
  assert.equal(inserted.needs_review, true);
  assert.equal(inserted.vendor, 'vercel');
  assert.equal(inserted.source_of_truth, 'gcp-secret-manager');

  // Idempotent second call → registered:false
  const r2 = await cred.registerExistingSecret({ name: 'EDGE_AI_VERCEL_DEPLOY', requester: 'test:drift' });
  assert.equal(r2.registered, false);
  cred._resetForTests();
});
