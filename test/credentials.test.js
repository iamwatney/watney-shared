const test = require('node:test');
const assert = require('node:assert');

const {
  buildCanonicalName,
  parseCanonicalName,
  isCanonicalConforming,
  CanonicalNameError,
  VendorBlockedError,
  listSupportedVendors,
  getVendorAdapter,
} = require('../dist/credentials');

test('buildCanonicalName builds 3-segment names', () => {
  assert.strictEqual(
    buildCanonicalName({ scope: 'EDGE_AI', vendor: 'ANTHROPIC', purpose: 'PUBLIC_CHAT' }),
    'EDGE_AI_ANTHROPIC_PUBLIC_CHAT',
  );
});

test('buildCanonicalName builds 4-segment names with env', () => {
  assert.strictEqual(
    buildCanonicalName({ scope: 'EDGE_AI', vendor: 'VERCEL', purpose: 'TOKEN', env: 'PROD' }),
    'EDGE_AI_VERCEL_TOKEN_PROD',
  );
});

test('buildCanonicalName rejects invalid segments', () => {
  assert.throws(() => buildCanonicalName({ scope: 'edge_ai', vendor: 'ANTHROPIC', purpose: 'X' }), CanonicalNameError);
  assert.throws(() => buildCanonicalName({ scope: 'EDGE_AI', vendor: 'ANTHROPIC', purpose: '' }), CanonicalNameError);
  assert.throws(() => buildCanonicalName({ scope: '1EDGE_AI', vendor: 'ANTHROPIC', purpose: 'X' }), CanonicalNameError);
});

test('buildCanonicalName rejects invalid env', () => {
  assert.throws(
    () => buildCanonicalName({ scope: 'X', vendor: 'Y', purpose: 'Z', env: 'BOGUS' }),
    CanonicalNameError,
  );
});

test('parseCanonicalName parses 3-segment names', () => {
  const out = parseCanonicalName('EDGE_AI_ANTHROPIC_PUBLIC_CHAT');
  assert.deepStrictEqual(out, {
    scope: 'EDGE_AI',
    vendor: 'ANTHROPIC',
    purpose: 'PUBLIC_CHAT',
    env: null,
  });
});

test('parseCanonicalName parses 4-segment names with env', () => {
  const out = parseCanonicalName('EDGE_AI_VERCEL_TOKEN_PROD');
  assert.deepStrictEqual(out, {
    scope: 'EDGE_AI',
    vendor: 'VERCEL',
    purpose: 'TOKEN',
    env: 'PROD',
  });
});

test('parseCanonicalName returns null for historical names', () => {
  assert.strictEqual(parseCanonicalName('edge_agentic_chatbots'), null);
  assert.strictEqual(parseCanonicalName('STRIPE_API_KEY_LIVE'), null); // _LIVE not in env whitelist
});

test('isCanonicalConforming gates correctly', () => {
  assert.strictEqual(isCanonicalConforming('EDGE_AI_ANTHROPIC_PUBLIC_CHAT'), true);
  assert.strictEqual(isCanonicalConforming('ANTHROPIC_API_KEY'), false); // only 3 segments and lowercase _key purpose? actually ANTHROPIC_API_KEY is 3 segments and uppercase
});

test('VendorBlockedError carries vendor + operation + hint', () => {
  const e = new VendorBlockedError('github', 'create', 'manual UI step');
  assert.strictEqual(e.vendor, 'github');
  assert.strictEqual(e.operation, 'create');
  assert.match(e.message, /manual UI step/);
});

test('listSupportedVendors returns all 9', () => {
  const v = listSupportedVendors();
  assert.ok(v.includes('ANTHROPIC'));
  assert.ok(v.includes('GITHUB'));
  assert.ok(v.includes('SUPABASE'));
  assert.ok(v.includes('GCP'));
  assert.ok(v.includes('VERCEL'));
  assert.ok(v.includes('STRIPE'));
  assert.ok(v.includes('CLOUDFLARE'));
  assert.ok(v.includes('TAVILY'));
  assert.ok(v.includes('OPENAI'));
});

test('getVendorAdapter returns adapter for known vendors', () => {
  for (const v of ['ANTHROPIC', 'GITHUB', 'SUPABASE', 'GCP', 'VERCEL', 'STRIPE', 'CLOUDFLARE', 'TAVILY', 'OPENAI']) {
    const a = getVendorAdapter(v);
    assert.ok(a, `adapter missing for ${v}`);
    assert.strictEqual(a.vendor, v);
    assert.ok(typeof a.healthCheck === 'function');
  }
});

test('getVendorAdapter returns null for unknown vendors', () => {
  assert.strictEqual(getVendorAdapter('NONEXISTENT'), null);
});

test('GitHub adapter declares createSupported:false', () => {
  const a = getVendorAdapter('GITHUB');
  assert.strictEqual(a.createSupported, false);
  assert.strictEqual(a.rotateSupported, false);
});

test('Tavily adapter declares createSupported:false', () => {
  const a = getVendorAdapter('TAVILY');
  assert.strictEqual(a.createSupported, false);
});

test('Anthropic adapter declares full lifecycle', () => {
  const a = getVendorAdapter('ANTHROPIC');
  assert.strictEqual(a.createSupported, true);
  assert.strictEqual(a.rotateSupported, true);
  assert.strictEqual(a.deleteSupported, true);
});
