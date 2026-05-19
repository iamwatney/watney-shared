#!/usr/bin/env node
/**
 * watney-smoke-test — CLI wrapper around runPostDeploy().
 *
 * Invoked by per-repo deploy scripts after `gcloud run deploy` (or `vercel
 * deploy --prod`) completes. Reads per-service config from one of:
 *
 *   1. CLI flags (--service, --service-url, --deploy-sha, --deploy-revision,
 *      --path, --expected-status, --body-match)
 *   2. smoke-test.json at the invocation cwd (overrides flags for path / body-match)
 *   3. package.json "watney.smokeTest" field at the invocation cwd
 *
 * Order: CLI flags > smoke-test.json > package.json > defaults.
 *
 * Exit code 0 ALWAYS. Smoke-test failures alert via DB + email — the deploy
 * itself already succeeded, so failing the CI step is the wrong signal.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { runPostDeploy } from '../smoke-test';

type Args = {
  service?: string;
  serviceUrl?: string;
  deploySha?: string;
  deployRevision?: string;
  path?: string;
  expectedStatus?: number;
  bodyMatch?: string;
  repo?: string;
  notifyTo?: string;
  configFile?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case '--service':           out.service         = next; i++; break;
      case '--service-url':       out.serviceUrl      = next; i++; break;
      case '--deploy-sha':        out.deploySha       = next; i++; break;
      case '--deploy-revision':   out.deployRevision  = next; i++; break;
      case '--path':              out.path            = next; i++; break;
      case '--expected-status':   out.expectedStatus  = Number(next); i++; break;
      case '--body-match':        out.bodyMatch       = next; i++; break;
      case '--repo':              out.repo            = next; i++; break;
      case '--notify-to':         out.notifyTo        = next; i++; break;
      case '--config-file':       out.configFile      = next; i++; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`watney-smoke-test — post-deploy smoke check

Required:
  --service <name>           Logical service name (matches deploy_alerts.service)
  --service-url <url>        Base URL of deployed service
  --deploy-sha <sha>         Full git SHA of the deploy
  --deploy-revision <rev>    Cloud Run revision name (or Vercel deployment id)

Optional:
  --path <p>                 Healthcheck path (default: /healthz)
  --expected-status <code>   Expected HTTP status (default: 200)
  --body-match <regex>       Response-body regex (case-insensitive)
  --repo <owner/repo>        For email body
  --notify-to <addr>         Override email recipient
  --config-file <path>       Path to smoke-test.json (default: ./smoke-test.json)
  --help                     This message

Env vars (auto-detected):
  COCKPIT_SUPABASE_URL or SUPABASE_URL
  COCKPIT_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY
  GMAIL_USER, GMAIL_APP_PASSWORD  (email; best-effort)
  SMOKE_TEST_NOTIFY_TO            (default: pauljfuggle@hotmail.com)

Exit code: 0 always (alerts via DB + email).
`);
}

interface FileSmokeConfig {
  path?: string;
  expectedStatus?: number;
  bodyMatch?: string;
  service?: string;
}

function loadFileConfig(cwd: string, explicitPath?: string): FileSmokeConfig {
  const tried: string[] = [];
  const candidates = explicitPath
    ? [pathResolve(cwd, explicitPath)]
    : [pathResolve(cwd, 'smoke-test.json'), pathResolve(cwd, 'package.json')];
  for (const p of candidates) {
    tried.push(p);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, 'utf8');
      const json = JSON.parse(txt);
      if (p.endsWith('package.json')) {
        const sub = json?.watney?.smokeTest;
        if (sub && typeof sub === 'object') return sub as FileSmokeConfig;
      } else {
        return json as FileSmokeConfig;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[watney-smoke-test] could not parse ${p}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return {};
}

(async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const fileCfg = loadFileConfig(process.cwd(), args.configFile);

  const service = args.service ?? fileCfg.service;
  const serviceUrl = args.serviceUrl;
  const deploySha = args.deploySha ?? process.env.DEPLOY_SHA ?? process.env.COMMIT_SHA ?? process.env.GITHUB_SHA;
  const deployRevision = args.deployRevision ?? 'unknown';

  if (!service || !serviceUrl || !deploySha) {
    // eslint-disable-next-line no-console
    console.error('[watney-smoke-test] missing required args: --service, --service-url, --deploy-sha');
    // exit 0 so the deploy isn't reported as failed because of misconfig
    process.exit(0);
  }

  const path = args.path ?? fileCfg.path ?? '/healthz';
  const expectedStatus = args.expectedStatus ?? fileCfg.expectedStatus ?? 200;
  const bodyMatchSrc = args.bodyMatch ?? fileCfg.bodyMatch;
  const bodyMatch = bodyMatchSrc ? new RegExp(bodyMatchSrc, 'i') : undefined;

  // eslint-disable-next-line no-console
  console.log(`[watney-smoke-test] ${service} → ${serviceUrl}${path}  (expect ${expectedStatus}${bodyMatchSrc ? `, body~/${bodyMatchSrc}/i` : ''})`);

  const result = await runPostDeploy({
    service,
    serviceUrl,
    deploySha,
    deployRevision,
    smoke: {
      path,
      expectedStatus,
      expectedBodyMatch: bodyMatch,
    },
    alert: {
      repo: args.repo,
      notifyTo: args.notifyTo,
    },
  });

  if (result.smokeResult.passed) {
    // eslint-disable-next-line no-console
    console.log(`[watney-smoke-test] PASS — ${result.smokeResult.attempts.length} attempt(s), last ${result.smokeResult.attempts[result.smokeResult.attempts.length - 1]?.latencyMs}ms`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[watney-smoke-test] FAIL — ${result.smokeResult.finalFailureReason}`);
    if (result.publish) {
      // eslint-disable-next-line no-console
      console.log(`[watney-smoke-test] alert publish: alertId=${result.publish.alertId} emailSent=${result.publish.emailSent} errors=${JSON.stringify(result.publish.errors)}`);
    }
  }

  // Exit 0 always.
  process.exit(0);
})().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[watney-smoke-test] uncaught:', e);
  process.exit(0);
});
