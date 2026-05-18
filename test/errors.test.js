const test = require('node:test');
const assert = require('node:assert');

const { ValidationError, UpstreamError, ConfigError, formatForGcp } = require('../dist/errors');

test('ValidationError carries field + reason', () => {
  const e = new ValidationError('uuid', 'abc', 'must be a UUID');
  assert.strictEqual(e.kind, 'validation');
  assert.strictEqual(e.field, 'uuid');
  assert.strictEqual(e.reason, 'must be a UUID');
});

test('UpstreamError formats with status code', () => {
  const e = new UpstreamError('anthropic', 429, 'rate limited');
  assert.match(e.message, /HTTP 429/);
});

test('formatForGcp renders Error', () => {
  const out = formatForGcp(new Error('boom'));
  assert.strictEqual(out.message, 'boom');
  assert.ok(out.stack);
});

test('formatForGcp renders ValidationError meta', () => {
  const out = formatForGcp(new ValidationError('id', null, 'missing'));
  assert.strictEqual(out.kind, 'validation');
  assert.deepStrictEqual(out.meta, { field: 'id', reason: 'missing' });
});

test('formatForGcp handles non-Error', () => {
  const out = formatForGcp('a plain string');
  assert.strictEqual(out.name, 'NonErrorThrown');
  assert.strictEqual(out.message, 'a plain string');
});
