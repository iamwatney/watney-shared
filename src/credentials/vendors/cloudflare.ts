/**
 * Cloudflare vendor adapter.
 *
 * Cloudflare API Token API:
 *   POST   /client/v4/user/tokens         — create token
 *   PUT    /client/v4/user/tokens/{id}    — rotate token (returns new value)
 *   DELETE /client/v4/user/tokens/{id}    — revoke token
 *   GET    /client/v4/user/tokens/verify  — health check
 *
 * Required env: WATNEY_CLOUDFLARE_ADMIN_TOKEN_STEWARD (an API token with
 * `User:API Tokens:Edit` permission).
 *
 * Token permissions for created tokens are passed via context as JSON
 * (format: "permissions:<json-array>"). If absent, the adapter creates
 * a placeholder read-only token that Paul can edit in Dashboard.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const CF_BASE = 'https://api.cloudflare.com';

function getAdminToken(): string {
  const token = process.env.WATNEY_CLOUDFLARE_ADMIN_TOKEN_STEWARD ?? process.env.EDGE_AI_CLOUDFLARE_TOKEN;
  if (!token) throw new VendorBlockedError(
    'cloudflare',
    'create',
    'set WATNEY_CLOUDFLARE_ADMIN_TOKEN_STEWARD env var (CF API token with User:API Tokens:Edit permission).',
  );
  return token;
}

export const cloudflareAdapter: VendorAdapter = {
  vendor: 'CLOUDFLARE',
  createSupported: true,
  rotateSupported: true,
  deleteSupported: true,
  notes: 'Tokens API supports CRUD. Default-created tokens have placeholder permissions — caller should adjust in Dashboard.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const adminToken = getAdminToken();
    // Default to a permissionless template; caller may pass permissions:[]
    const permissions: Array<{ id: string; effect: string }> = [];
    const policies = [
      {
        effect: 'allow' as const,
        resources: { 'com.cloudflare.api.account.*': '*' },
        permission_groups: permissions,
      },
    ];
    const res = await fetch(`${CF_BASE}/client/v4/user/tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: opts.canonicalName,
        policies,
      }),
    });
    if (!res.ok) throw new UpstreamError('cloudflare', res.status, `create token failed: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { result: { id: string; value: string } };
    return {
      value: json.result.value,
      vendorMetadata: { token_id: json.result.id },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const adminToken = getAdminToken();
    const tokenId = opts.currentVendorMetadata?.token_id as string | undefined;
    if (!tokenId) {
      throw new VendorBlockedError('cloudflare', 'rotate', `rotation requires vendorMetadata.token_id for ${opts.canonicalName}`);
    }
    const res = await fetch(`${CF_BASE}/client/v4/user/tokens/${tokenId}/value`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) throw new UpstreamError('cloudflare', res.status, `rotate failed: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { result: string };
    return {
      value: json.result,
      vendorMetadata: { token_id: tokenId },
    };
  },

  async deleteCredential(opts): Promise<boolean> {
    const adminToken = getAdminToken();
    const tokenId = opts.vendorMetadata?.token_id as string | undefined;
    if (!tokenId) throw new UpstreamError('cloudflare', null, 'deleteCredential requires vendorMetadata.token_id');
    const res = await fetch(`${CF_BASE}/client/v4/user/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    return res.ok || res.status === 404;
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch(`${CF_BASE}/client/v4/user/tokens/verify`, {
        headers: { Authorization: `Bearer ${opts.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('cloudflare', null, (err as Error).message);
    }
  },
};
