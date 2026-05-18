const test = require('node:test');
const assert = require('node:assert');

const { uuidSchema, isoDateSchema, emailSchema, gbpAmountSchema, cloudRunNameSchema } = require('../dist/zod-helpers');

test('uuidSchema accepts a valid UUID', () => {
  assert.doesNotThrow(() => uuidSchema.parse('550e8400-e29b-41d4-a716-446655440000'));
});

test('uuidSchema rejects malformed', () => {
  assert.throws(() => uuidSchema.parse('not-a-uuid'));
  assert.throws(() => uuidSchema.parse(''));
  assert.throws(() => uuidSchema.parse(null));
});

test('isoDateSchema accepts Z-suffixed ISO 8601', () => {
  assert.doesNotThrow(() => isoDateSchema.parse('2026-05-18T12:34:56Z'));
});

test('isoDateSchema rejects date-only', () => {
  assert.throws(() => isoDateSchema.parse('2026-05-18'));
});

test('emailSchema accepts simple email', () => {
  assert.doesNotThrow(() => emailSchema.parse('paul@example.com'));
});

test('gbpAmountSchema rejects negatives and infinity', () => {
  assert.throws(() => gbpAmountSchema.parse(-1));
  assert.throws(() => gbpAmountSchema.parse(Infinity));
  assert.doesNotThrow(() => gbpAmountSchema.parse(0));
  assert.doesNotThrow(() => gbpAmountSchema.parse(1234.56));
});

test('cloudRunNameSchema enforces format', () => {
  assert.doesNotThrow(() => cloudRunNameSchema.parse('edge-ai-news-refresh'));
  assert.throws(() => cloudRunNameSchema.parse('UPPERCASE'));
  assert.throws(() => cloudRunNameSchema.parse('1-cannot-start-with-digit'));
});
