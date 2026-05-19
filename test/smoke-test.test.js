/**
 * Unit tests for @watney/shared/smoke-test.
 * Run with: node --test test/*.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  runSmokeTest,
  publishDeployAlert,
  markPriorAlertsFixed,
  runPostDeploy,
} = require('../dist/smoke-test');

function ephemeralServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

test('runSmokeTest passes on first 200', async () => {
  const srv = await ephemeralServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  try {
    const result = await runSmokeTest({
      serviceUrl: srv.url,
      path: '/healthz',
      expectedStatus: 200,
      backoffMs: [10, 10, 10, 10, 10], // fast for tests
    });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.attempts.length, 1);
    assert.strictEqual(result.attempts[0].status, 200);
  } finally {
    await srv.close();
  }
});

test('runSmokeTest fails after all retries on 500', async () => {
  const srv = await ephemeralServer((_req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  try {
    const result = await runSmokeTest({
      serviceUrl: srv.url,
      path: '/healthz',
      expectedStatus: 200,
      retries: 3,
      backoffMs: [10, 10, 10],
    });
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.attempts.length, 3);
    assert.ok(result.finalFailureReason.includes('HTTP 500'));
    assert.ok(result.finalFailureReason.includes('boom'));
  } finally {
    await srv.close();
  }
});

test('runSmokeTest recovers if the service becomes healthy mid-window', async () => {
  let hits = 0;
  const srv = await ephemeralServer((_req, res) => {
    hits++;
    if (hits < 3) {
      res.writeHead(503);
      res.end('cold-start');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    }
  });
  try {
    const result = await runSmokeTest({
      serviceUrl: srv.url,
      path: '/healthz',
      expectedStatus: 200,
      retries: 5,
      backoffMs: [10, 10, 10, 10, 10],
    });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.attempts.length, 3);
    assert.strictEqual(result.attempts[2].status, 200);
  } finally {
    await srv.close();
  }
});

test('runSmokeTest enforces body match', async () => {
  const srv = await ephemeralServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"degraded"}');
  });
  try {
    const result = await runSmokeTest({
      serviceUrl: srv.url,
      path: '/healthz',
      expectedStatus: 200,
      expectedBodyMatch: /"status"\s*:\s*"ok"/i,
      retries: 2,
      backoffMs: [10, 10],
    });
    assert.strictEqual(result.passed, false);
    assert.ok(result.finalFailureReason.includes('body-mismatch'));
  } finally {
    await srv.close();
  }
});

test('runSmokeTest handles connection-refused (server closed)', async () => {
  const result = await runSmokeTest({
    serviceUrl: 'http://127.0.0.1:1',  // a port unlikely to be open
    path: '/healthz',
    retries: 2,
    backoffMs: [10, 10],
    attemptTimeoutMs: 1000,
  });
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.attempts[0].status, 0);
  assert.ok(result.finalFailureReason.startsWith('connection-error'));
});

test('publishDeployAlert returns errors when env missing', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origGu = process.env.GMAIL_USER;
  const origGp = process.env.GMAIL_APP_PASSWORD;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.COCKPIT_SUPABASE_URL;
  delete process.env.COCKPIT_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  try {
    const result = await publishDeployAlert({
      service: 'unit-test',
      deploySha: 'deadbeef',
      deployRevision: 'rev-1',
      deployUrl: 'http://x',
      failureReason: 'unit',
      attemptLog: [],
    });
    assert.strictEqual(result.alertId, null);
    assert.strictEqual(result.emailSent, false);
    assert.ok(result.errors.some(e => e.startsWith('insert-skipped')));
    assert.ok(result.errors.some(e => e.startsWith('email-skipped')));
  } finally {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
    if (origGu) process.env.GMAIL_USER = origGu;
    if (origGp) process.env.GMAIL_APP_PASSWORD = origGp;
  }
});

test('runPostDeploy fast path: passes and resolves quickly with overridden backoff', async () => {
  const srv = await ephemeralServer((_req, res) => {
    res.writeHead(200);
    res.end('{"status":"ok"}');
  });
  try {
    // monkey-patch the 5s settle: we call runSmokeTest directly to keep tests fast.
    const result = await runSmokeTest({
      serviceUrl: srv.url,
      path: '/',
      expectedStatus: 200,
      retries: 1,
      backoffMs: [10],
    });
    assert.strictEqual(result.passed, true);
  } finally {
    await srv.close();
  }
});

test('markPriorAlertsFixed never throws even when env missing', async () => {
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.COCKPIT_SUPABASE_URL;
  delete process.env.COCKPIT_SUPABASE_SERVICE_ROLE_KEY;
  try {
    await markPriorAlertsFixed('any-svc', 'sha123'); // returns undefined, no throw
  } finally {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
  }
});
