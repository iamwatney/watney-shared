/**
 * Anthropic vendor adapter.
 *
 * Anthropic exposes an Admin API for workspace + API-key management:
 *   POST /v1/organizations/{org_id}/api_keys           — create
 *   POST /v1/organizations/{org_id}/api_keys/{id}      — update (rotate via new key)
 *   DELETE /v1/organizations/{org_id}/api_keys/{id}    — delete
 *
 * Auth: requires an *admin* API key (sk-ant-admin01-...) with
 * organization-admin scope. Stored in GCP SM as WATNEY_ANTHROPIC_ADMIN_KEY_STEWARD.
 *
 * NOTE 2026-05-18: Anthropic Admin API has been GA for organisation admins
 * since 2025. If Paul's workspace does not have the Admin API enabled
 * yet, the adapter falls back to VendorBlockedError with escalation hint.
 *
 * Health check: GET /v1/models with the api-key header. 200 = healthy.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

function getAdminKey(): string {
  const key = process.env.WATNEY_ANTHROPIC_ADMIN_KEY_STEWARD;
  if (!key) throw new VendorBlockedError(
    'anthropic',
    'create',
    'set WATNEY_ANTHROPIC_ADMIN_KEY_STEWARD env var (admin API key, sk-ant-admin01-...). See Brain/Credentials/anthropic-api-key.md',
  );
  return key;
}

function getOrgId(): string {
  const id = process.env.WATNEY_ANTHROPIC_ORG_ID;
  if (!id) throw new VendorBlockedError(
    'anthropic',
    'create',
    'set WATNEY_ANTHROPIC_ORG_ID env var (organisation id, org_...). Find in Anthropic console under Settings → Organization.',
  );
  return id;
}

export const anthropicAdapter: VendorAdapter = {
  vendor: 'ANTHROPIC',
  createSupported: true,
  rotateSupported: true,
  deleteSupported: true,
  notes: 'Requires Anthropic Admin API key + org id. Falls back to escalation if envs missing.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const adminKey = getAdminKey();
    const orgId = getOrgId();
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/organizations/${orgId}/api_keys`, {
      method: 'POST',
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: opts.canonicalName,
        // Workspace id selection: default workspace for now. v3 could thread this through opts.
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new UpstreamError('anthropic', res.status, `create api_key failed: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string; partial_key_hint?: string; api_key?: string; key?: string };
    const value = json.api_key ?? json.key;
    if (!value) {
      throw new UpstreamError('anthropic', null, `create api_key returned no value field; got keys: ${Object.keys(json).join(',')}`);
    }
    return {
      value,
      vendorMetadata: { api_key_id: json.id, partial_key_hint: json.partial_key_hint },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    // Anthropic rotation = create-new + (caller will mark old for disable).
    // We don't have the old key value, so we just create a fresh one under the
    // same canonical name; library is responsible for transferring vendor
    // metadata + scheduling old-version disable.
    return this.createCredential({
      canonicalName: opts.canonicalName,
      purpose: 'ROTATION',
      scope: 'WATNEY',
    });
  },

  async deleteCredential(opts): Promise<boolean> {
    const adminKey = getAdminKey();
    const orgId = getOrgId();
    const apiKeyId = opts.vendorMetadata?.api_key_id as string | undefined;
    if (!apiKeyId) throw new UpstreamError('anthropic', null, 'deleteCredential requires vendorMetadata.api_key_id');
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/organizations/${orgId}/api_keys/${apiKeyId}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
      },
    });
    return res.ok || res.status === 404; // already gone = success
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch(`${ANTHROPIC_API_BASE}/v1/models?limit=1`, {
        headers: {
          'x-api-key': opts.value,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) {
        return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status} auth failure` };
      }
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('anthropic', null, (err as Error).message);
    }
  },
};
