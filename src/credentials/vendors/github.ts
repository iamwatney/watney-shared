/**
 * GitHub vendor adapter.
 *
 * Known limitation: GitHub fine-grained PATs (recommended scope mode) have
 * **no Admin API for creation** — they must be created through the web UI
 * by the account owner. The adapter therefore escalates on create.
 *
 * Classic PATs (legacy) have a now-deprecated user-to-server flow that
 * we deliberately do NOT use (recommendation: stick to fine-grained PATs).
 *
 * Supported via API:
 *   - **Repository secrets** (Actions): PUT /repos/{owner}/{repo}/actions/secrets/{name}
 *   - **Webhook secrets**: create/rotate via repo webhook config
 *   - **Deploy keys**: POST /repos/{owner}/{repo}/keys (for SSH access)
 *
 * For our purposes, the most useful create path is repository secrets
 * (Actions). For PATs, escalate to Paul.
 *
 * Health check: GET /user — 200 means PAT is alive; 401 means dead.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

function getAdminToken(): string {
  const token = process.env.WATNEY_GITHUB_ADMIN_TOKEN_STEWARD ?? process.env.WATNEY_GITHUB_ADMIN_TOKEN;
  if (!token) throw new VendorBlockedError(
    'github',
    'create',
    'set WATNEY_GITHUB_ADMIN_TOKEN_STEWARD env var (fine-grained PAT with repo + secrets:write scope). See Brain/Credentials.',
  );
  return token;
}

export const githubAdapter: VendorAdapter = {
  vendor: 'GITHUB',
  createSupported: false, // PAT creation requires manual UI step
  rotateSupported: false,
  deleteSupported: false,
  notes: 'GitHub fine-grained PATs cannot be created via API — escalate to Paul. Repo-secrets and webhook-secrets are creatable but not represented as standalone PATs in our credential model.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    throw new VendorBlockedError(
      'github',
      'create',
      `GitHub fine-grained PATs cannot be created via API. Open https://github.com/settings/personal-access-tokens/new and create a PAT named "${opts.canonicalName}". Then run scripts/register-secret.sh to register the value.`,
    );
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    throw new VendorBlockedError(
      'github',
      'rotate',
      `GitHub fine-grained PATs cannot be rotated via API. Open https://github.com/settings/personal-access-tokens and regenerate "${opts.canonicalName}". Then run scripts/register-secret.sh to update the value.`,
    );
  },

  async deleteCredential(opts): Promise<boolean> {
    throw new VendorBlockedError(
      'github',
      'delete',
      `GitHub fine-grained PATs cannot be deleted via API. Open https://github.com/settings/personal-access-tokens and revoke "${opts.canonicalName}".`,
    );
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${opts.value}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) {
        return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status} auth failure` };
      }
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('github', null, (err as Error).message);
    }
  },
};

/**
 * Helper for callers that DO want to create a repo Actions secret (not a PAT).
 * Not part of the VendorAdapter contract — this is GitHub-specific.
 */
export async function putRepoActionsSecret(opts: {
  owner: string;
  repo: string;
  secretName: string;
  value: string;
}): Promise<boolean> {
  const token = getAdminToken();
  // Step 1: fetch the repo public key for libsodium encryption
  const keyRes = await fetch(`https://api.github.com/repos/${opts.owner}/${opts.repo}/actions/secrets/public-key`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!keyRes.ok) throw new UpstreamError('github', keyRes.status, 'fetch repo public-key failed');
  const keyJson = (await keyRes.json()) as { key: string; key_id: string };
  // Step 2: encrypt with libsodium-wrappers (caller would need this dep).
  // Since the library doesn't take libsodium as a dep, we throw an instructive
  // error if this path is exercised — callers needing this should do it locally.
  throw new VendorBlockedError(
    'github',
    'create',
    `putRepoActionsSecret needs libsodium-wrappers to encrypt the value with public key ${keyJson.key_id.slice(0, 8)}... — this is left to the caller to avoid bloating @watney/shared.`,
  );
}
