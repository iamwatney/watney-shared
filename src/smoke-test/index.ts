/**
 * @watney/shared/smoke-test — Post-deploy smoke-test helper.
 *
 * Hits a deployed service's healthcheck endpoint with backoff retries.
 * On failure, writes a `deploy_alerts` row to the cockpit Supabase project
 * and sends a notification email via Gmail SMTP (best-effort; never throws).
 *
 * Design: Projects/edge-agentic-workflow/design-docs/2026-05-18-m8-production-smoke-test.md
 * Decisions (Paul 2026-05-18): alert-only, no auto-rollback, 5 attempts over 60s,
 *   email to pauljfuggle@hotmail.com.
 *
 * Call sites: every deploy script that ships a Cloud Run service or Vercel app.
 * Wrapper script `bin/smoke-test.js` is the CLI entrypoint deploy scripts invoke.
 */

export interface SmokeTestConfig {
  /** Full base URL of the deployed service (no trailing slash). */
  serviceUrl: string;
  /** Path to hit, e.g. '/healthz' or '/'. Default '/healthz'. */
  path?: string;
  /** Expected HTTP status. Default 200. */
  expectedStatus?: number;
  /** Optional regex the response body must match (case-insensitive). */
  expectedBodyMatch?: RegExp;
  /** Number of attempts. Default 5. */
  retries?: number;
  /** Backoff schedule in ms. Default [5000, 10000, 15000, 15000, 15000]. */
  backoffMs?: number[];
  /** Per-attempt request timeout (ms). Default 10000. */
  attemptTimeoutMs?: number;
}

export interface SmokeAttempt {
  attemptNo: number;
  status: number;
  latencyMs: number;
  bodyExcerpt: string;
}

export interface SmokeTestResult {
  passed: boolean;
  attempts: SmokeAttempt[];
  /** Populated when passed=false. Concise human-readable summary. */
  finalFailureReason?: string;
}

const DEFAULT_BACKOFF_MS = [5000, 10000, 15000, 15000, 15000];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a smoke test against a deployed service. Returns a result object; never
 * throws. Caller decides what to do with passed=false (alert/email).
 */
export async function runSmokeTest(cfg: SmokeTestConfig): Promise<SmokeTestResult> {
  const path = cfg.path ?? '/healthz';
  const expectedStatus = cfg.expectedStatus ?? 200;
  const retries = cfg.retries ?? 5;
  const backoffMs = cfg.backoffMs ?? DEFAULT_BACKOFF_MS;
  const timeoutMs = cfg.attemptTimeoutMs ?? 10000;
  const url = `${cfg.serviceUrl.replace(/\/$/, '')}${path}`;
  const attempts: SmokeAttempt[] = [];

  for (let i = 1; i <= retries; i++) {
    const start = Date.now();
    let status = 0;
    let bodyExcerpt = '';
    let attemptError: string | null = null;
    let bodyMatches = true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        // Cloud Run cold-starts can be slow; we deliberately don't follow
        // unexpected redirects to a different host.
        redirect: 'manual',
        headers: { 'User-Agent': 'watney-smoke-test/1.0' },
      });
      status = resp.status;
      const text = await resp.text().catch(() => '');
      bodyExcerpt = text.slice(0, 200);
      if (cfg.expectedBodyMatch) {
        bodyMatches = cfg.expectedBodyMatch.test(text);
      }
    } catch (e) {
      attemptError = e instanceof Error ? e.message : String(e);
      bodyExcerpt = `<<request-error: ${attemptError}>>`;
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - start;
    attempts.push({ attemptNo: i, status, latencyMs, bodyExcerpt });

    if (status === expectedStatus && bodyMatches && !attemptError) {
      return { passed: true, attempts };
    }

    // Wait before next attempt (no sleep after last attempt)
    if (i < retries) {
      const wait = backoffMs[i - 1] ?? backoffMs[backoffMs.length - 1] ?? 15000;
      await sleep(wait);
    }
  }

  const last = attempts[attempts.length - 1]!;
  let reason: string;
  if (last.status === 0) {
    reason = `connection-error: ${last.bodyExcerpt}`;
  } else if (last.status !== expectedStatus) {
    reason = `HTTP ${last.status} (expected ${expectedStatus}) — body: ${last.bodyExcerpt}`;
  } else {
    reason = `body-mismatch: did not match ${cfg.expectedBodyMatch} — body: ${last.bodyExcerpt}`;
  }
  return { passed: false, attempts, finalFailureReason: reason };
}

// ---------------------------------------------------------------------------
// Alert publication — DB insert + email
// ---------------------------------------------------------------------------

export interface DeployAlertInsert {
  service: string;
  deploySha: string;
  deployRevision: string;
  deployUrl: string;
  failureReason: string;
  attemptLog: SmokeAttempt[];
}

export interface PublishAlertOpts {
  /** Cockpit Supabase URL — defaults to process.env.COCKPIT_SUPABASE_URL or SUPABASE_URL */
  cockpitUrl?: string;
  /** Cockpit service-role key — defaults to process.env.COCKPIT_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY */
  cockpitServiceRoleKey?: string;
  /** Gmail user (sender). Defaults to process.env.GMAIL_USER. */
  gmailUser?: string;
  /** Gmail app password. Defaults to process.env.GMAIL_APP_PASSWORD. */
  gmailAppPassword?: string;
  /** Notify recipient. Defaults to process.env.SMOKE_TEST_NOTIFY_TO or pauljfuggle@hotmail.com */
  notifyTo?: string;
  /** Repo identifier (e.g. 'iamwatney/edge-ai-spend-monitor'). For email body. */
  repo?: string;
}

export interface PublishAlertResult {
  alertId: string | null;
  emailSent: boolean;
  errors: string[];
}

/**
 * Insert a deploy_alerts row + send email. Never throws — collects errors and
 * returns them. Email send is best-effort; the alert row is the primary signal.
 */
export async function publishDeployAlert(
  alert: DeployAlertInsert,
  opts: PublishAlertOpts = {}
): Promise<PublishAlertResult> {
  const errors: string[] = [];
  const cockpitUrl = opts.cockpitUrl ?? process.env.COCKPIT_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const cockpitKey = opts.cockpitServiceRoleKey
    ?? process.env.COCKPIT_SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const gmailUser = opts.gmailUser ?? process.env.GMAIL_USER;
  const gmailPass = opts.gmailAppPassword ?? process.env.GMAIL_APP_PASSWORD;
  const notifyTo  = opts.notifyTo  ?? process.env.SMOKE_TEST_NOTIFY_TO ?? 'pauljfuggle@hotmail.com';

  let alertId: string | null = null;

  // --- Insert deploy_alerts row -------------------------------------------
  if (!cockpitUrl || !cockpitKey) {
    errors.push('insert-skipped: COCKPIT_SUPABASE_URL / SUPABASE_URL or service-role key missing');
  } else {
    try {
      const resp = await fetch(`${cockpitUrl.replace(/\/$/, '')}/rest/v1/deploy_alerts`, {
        method: 'POST',
        headers: {
          apikey: cockpitKey,
          Authorization: `Bearer ${cockpitKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify([{
          service: alert.service,
          deploy_sha: alert.deploySha,
          deploy_revision: alert.deployRevision,
          deploy_url: alert.deployUrl,
          failure_reason: alert.failureReason.slice(0, 4000),
          attempt_log: alert.attemptLog,
        }]),
      });
      if (resp.ok) {
        const rows = (await resp.json().catch(() => [])) as Array<{ id?: string }>;
        if (Array.isArray(rows) && rows[0]?.id) alertId = rows[0].id;
      } else {
        const txt = await resp.text().catch(() => '');
        errors.push(`insert-failed: HTTP ${resp.status} ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      errors.push(`insert-threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- Send email via Gmail SMTP via nodemailer ----------------------------
  // We dynamically require nodemailer so consumers without it (cockpit Next.js
  // edge runtime, for example) still get a useful alert row even if email is
  // unavailable.
  let emailSent = false;
  if (!gmailUser || !gmailPass) {
    errors.push('email-skipped: GMAIL_USER / GMAIL_APP_PASSWORD missing');
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: gmailUser, pass: gmailPass },
      });
      const shortSha = (alert.deploySha || '').slice(0, 8);
      const subject = `[Watney] Smoke test failed: ${alert.service} deploy ${shortSha}`;
      const body = [
        'A production deploy passed CI but failed the post-deploy smoke test.',
        '',
        `Service:        ${alert.service}`,
        `Repo:           ${opts.repo ?? '<unknown>'}`,
        `Deploy SHA:     ${alert.deploySha}`,
        `Cloud Run rev:  ${alert.deployRevision}`,
        `Deploy URL:     ${alert.deployUrl}`,
        '',
        `Smoke test:     ${alert.attemptLog.length} attempts over ~60s, all failed`,
        `Last failure:   ${alert.failureReason}`,
        '',
        'The new revision is currently serving traffic. No auto-rollback.',
        '',
        'Triage steps:',
        `  1. Hit the URL: curl -sv ${alert.deployUrl}/healthz`,
        `  2. Check Cloud Run logs: gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.revision_name=\"${alert.deployRevision}\"' --limit 50`,
        '  3. Decide: fix-forward (new commit + redeploy) OR rollback (gcloud run services update-traffic --to-revisions <prev>=100)',
        '  4. Acknowledge in cockpit: https://edgeagentic.co.uk/cockpit/deploy-alerts',
        '',
        alertId ? `Full attempt log: https://edgeagentic.co.uk/cockpit/deploy-alerts/${alertId}` : '',
      ].join('\n');
      await transporter.sendMail({
        from: `"Watney Smoke Test" <${gmailUser}>`,
        to: notifyTo,
        subject,
        text: body,
      });
      emailSent = true;
    } catch (e) {
      errors.push(`email-failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { alertId, emailSent, errors };
}

/**
 * Backfill `fixed_in_deploy_sha` on prior unacknowledged alerts for the same
 * service when this deploy passed. Best-effort, never throws.
 */
export async function markPriorAlertsFixed(
  service: string,
  fixedInSha: string,
  opts: { cockpitUrl?: string; cockpitServiceRoleKey?: string } = {}
): Promise<void> {
  const cockpitUrl = opts.cockpitUrl ?? process.env.COCKPIT_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const cockpitKey = opts.cockpitServiceRoleKey
    ?? process.env.COCKPIT_SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cockpitUrl || !cockpitKey) return;
  try {
    await fetch(`${cockpitUrl.replace(/\/$/, '')}/rest/v1/deploy_alerts?service=eq.${encodeURIComponent(service)}&fixed_in_deploy_sha=is.null`, {
      method: 'PATCH',
      headers: {
        apikey: cockpitKey,
        Authorization: `Bearer ${cockpitKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ fixed_in_deploy_sha: fixedInSha }),
    });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// High-level orchestrator — what deploy scripts call
// ---------------------------------------------------------------------------

export interface RunPostDeployOpts {
  service: string;
  serviceUrl: string;
  deploySha: string;
  deployRevision: string;
  /** Smoke-test config (path, expected status, body match). */
  smoke?: Partial<SmokeTestConfig>;
  /** Alert publication overrides. */
  alert?: PublishAlertOpts;
}

export interface RunPostDeployResult {
  smokeResult: SmokeTestResult;
  publish?: PublishAlertResult;
}

/**
 * The one-call entrypoint deploy scripts use:
 *   1. Wait 5s for revision to settle
 *   2. Run smoke test
 *   3. On pass: mark prior alerts fixed. On fail: publish alert.
 * Always resolves; never throws. Caller exits 0 regardless.
 */
export async function runPostDeploy(opts: RunPostDeployOpts): Promise<RunPostDeployResult> {
  // 5s settle for Cloud Run revision rollout
  await sleep(5000);
  const cfg: SmokeTestConfig = {
    serviceUrl: opts.serviceUrl,
    ...(opts.smoke ?? {}),
  };
  const smokeResult = await runSmokeTest(cfg);
  if (smokeResult.passed) {
    await markPriorAlertsFixed(opts.service, opts.deploySha, opts.alert);
    return { smokeResult };
  }
  const publish = await publishDeployAlert(
    {
      service: opts.service,
      deploySha: opts.deploySha,
      deployRevision: opts.deployRevision,
      deployUrl: opts.serviceUrl,
      failureReason: smokeResult.finalFailureReason ?? 'unknown',
      attemptLog: smokeResult.attempts,
    },
    opts.alert ?? {},
  );
  return { smokeResult, publish };
}
