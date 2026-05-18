/**
 * OpenAI vendor adapter.
 *
 * OpenAI's Admin API supports key CRUD:
 *   POST   /v1/organization/admin_api_keys           — create
 *   DELETE /v1/organization/admin_api_keys/{id}      — delete
 *   GET    /v1/organization/admin_api_keys           — list
 *
 * Requires an Admin API key (sk-admin-...). Stored in GCP SM as
 * WATNEY_OPENAI_ADMIN_KEY_STEWARD.
 *
 * Health check: GET /v1/models — 200 means key alive.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const OPENAI_BASE = 'https://api.openai.com';

function getAdminKey(): string {
  const key = process.env.WATNEY_OPENAI_ADMIN_KEY_STEWARD;
  if (!key) throw new VendorBlockedError(
    'openai',
    'create',
    'set WATNEY_OPENAI_ADMIN_KEY_STEWARD env var (Admin key, sk-admin-...). Create in OpenAI Platform → Organization → Admin keys.',
  );
  return key;
}

export const openaiAdapter: VendorAdapter = {
  vendor: 'OPENAI',
  createSupported: true,
  rotateSupported: true,
  deleteSupported: true,
  notes: 'Admin API supports admin_api_keys CRUD. Standard project API keys (sk-proj-...) are created via /v1/organization/projects/{id}/api_keys.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const adminKey = getAdminKey();
    // Choose endpoint based on purpose:
    //   ADMIN -> /admin_api_keys, otherwise /projects/{id}/api_keys
    const isAdmin = /ADMIN/i.test(opts.purpose);
    const url = isAdmin
      ? `${OPENAI_BASE}/v1/organization/admin_api_keys`
      : `${OPENAI_BASE}/v1/organization/projects/${extractProjectId(opts)}/api_keys`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: opts.canonicalName }),
    });
    if (!res.ok) throw new UpstreamError('openai', res.status, `create key failed: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id: string; value?: string; api_key?: string };
    const value = json.value ?? json.api_key;
    if (!value) throw new UpstreamError('openai', null, `OpenAI returned no key value; keys=${Object.keys(json).join(',')}`);
    return {
      value,
      vendorMetadata: { key_id: json.id, is_admin: isAdmin },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    return this.createCredential({
      canonicalName: opts.canonicalName,
      purpose: (opts.currentVendorMetadata?.is_admin ? 'ADMIN' : 'API_KEY'),
      scope: 'WATNEY',
    });
  },

  async deleteCredential(opts): Promise<boolean> {
    const adminKey = getAdminKey();
    const keyId = opts.vendorMetadata?.key_id as string | undefined;
    const isAdmin = !!opts.vendorMetadata?.is_admin;
    if (!keyId) throw new UpstreamError('openai', null, 'deleteCredential requires vendorMetadata.key_id');
    const url = isAdmin
      ? `${OPENAI_BASE}/v1/organization/admin_api_keys/${keyId}`
      : `${OPENAI_BASE}/v1/organization/projects/${extractProjectId({ canonicalName: '', purpose: '', scope: 'WATNEY', context: opts.vendorMetadata?.project_id as string | undefined })}/api_keys/${keyId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    return res.ok || res.status === 404;
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch(`${OPENAI_BASE}/v1/models?limit=1`, {
        headers: { Authorization: `Bearer ${opts.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('openai', null, (err as Error).message);
    }
  },
};

function extractProjectId(opts: { canonicalName: string; purpose: string; scope: string; context?: string }): string {
  if (opts.context?.startsWith('project_id:')) return opts.context.slice('project_id:'.length).trim();
  // Fallback to env default
  return process.env.WATNEY_OPENAI_DEFAULT_PROJECT_ID ?? 'proj_default';
}
