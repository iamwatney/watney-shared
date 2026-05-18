/**
 * Vercel vendor adapter.
 *
 * Vercel REST API:
 *   POST   /v3/user/tokens                   — create access token
 *   GET    /v3/user/tokens                   — list
 *   DELETE /v3/user/tokens/{tokenId}         — revoke
 *   POST   /v9/projects/{idOrName}/env       — create env var
 *   PATCH  /v9/projects/{idOrName}/env/{id}  — update env var
 *
 * Required env: WATNEY_VERCEL_ADMIN_TOKEN_STEWARD (an admin token with
 * `tokens` + `env` scopes).
 *
 * Health check: GET /v2/user — 200 means token alive.
 *
 * Distinction:
 *   - PURPOSE='TOKEN' or 'ADMIN_PAT' → operate on /user/tokens
 *   - PURPOSE='ENV_VAR' → operate on project env (context required)
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const VERCEL_BASE = 'https://api.vercel.com';

function getAdminToken(): string {
  const token = process.env.WATNEY_VERCEL_ADMIN_TOKEN_STEWARD ?? process.env.EDGE_AI_VERCEL_TOKEN;
  if (!token) throw new VendorBlockedError(
    'vercel',
    'create',
    'set WATNEY_VERCEL_ADMIN_TOKEN_STEWARD env var (Vercel admin token with tokens+env scopes).',
  );
  return token;
}

export const vercelAdapter: VendorAdapter = {
  vendor: 'VERCEL',
  createSupported: true,
  rotateSupported: true,
  deleteSupported: true,
  notes: 'User-token CRUD + project env-var CRUD. Both via REST.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const token = getAdminToken();
    const res = await fetch(`${VERCEL_BASE}/v3/user/tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: opts.canonicalName,
        // Default expiry: 1 year. Caller can override via context "expires:<ts>".
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      }),
    });
    if (!res.ok) throw new UpstreamError('vercel', res.status, `create token failed: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { token: { id: string }; bearerToken: string };
    return {
      value: json.bearerToken,
      vendorMetadata: { token_id: json.token.id },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    return this.createCredential({
      canonicalName: opts.canonicalName,
      purpose: 'ROTATION',
      scope: 'WATNEY',
    });
  },

  async deleteCredential(opts): Promise<boolean> {
    const token = getAdminToken();
    const tokenId = opts.vendorMetadata?.token_id as string | undefined;
    if (!tokenId) throw new UpstreamError('vercel', null, 'deleteCredential requires vendorMetadata.token_id');
    const res = await fetch(`${VERCEL_BASE}/v3/user/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch(`${VERCEL_BASE}/v2/user`, {
        headers: { Authorization: `Bearer ${opts.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('vercel', null, (err as Error).message);
    }
  },
};
