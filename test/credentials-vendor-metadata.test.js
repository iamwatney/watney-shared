'use strict';
/**
 * F5 root-cause: vendor metadata must be read structurally, not by a greedy
 * regex over notes that breaks after the first rotation (the bug that made
 * deprecation delete the WRONG key). Tests readVendorMetadata precedence +
 * legacy fallback. Runs against built dist/ via `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const cred = require('../dist/credentials/index.js');

test('readVendorMetadata: prefers the structured vendor_metadata column', () => {
  const md = cred.readVendorMetadata({
    vendor_metadata: { key_name: 'projects/p/keys/NEW', sa_email: 'sa@x' },
    notes: 'Vendor metadata: {"key_name":"projects/p/keys/OLD"}',
  });
  assert.equal(md.key_name, 'projects/p/keys/NEW'); // column wins over legacy notes
});

test('readVendorMetadata: falls back to the legacy notes marker when column absent', () => {
  const md = cred.readVendorMetadata({
    vendor_metadata: null,
    notes: 'Vendor metadata: {"api_key_id":"ak_123"}',
  });
  assert.equal(md.api_key_id, 'ak_123');
});

test('readVendorMetadata: post-rotation notes (two markers) does NOT corrupt — takes the first {...}', () => {
  // This is the exact shape the OLD greedy regex mis-parsed into invalid JSON.
  const md = cred.readVendorMetadata({
    vendor_metadata: null,
    notes: 'Vendor metadata: {"key_name":"OLD"} | Rotated 2026-07-21 — new vendor metadata: {"key_name":"NEW"}',
  });
  assert.equal(md.key_name, 'OLD'); // clean parse of the first object, not a merged blob
});

test('readVendorMetadata: returns {} when neither column nor a valid marker exists', () => {
  assert.deepEqual(cred.readVendorMetadata({ vendor_metadata: null, notes: 'no marker here' }), {});
  assert.deepEqual(cred.readVendorMetadata({ notes: null }), {});
  assert.deepEqual(cred.readVendorMetadata({ vendor_metadata: null, notes: 'Vendor metadata: {not json}' }), {});
});
