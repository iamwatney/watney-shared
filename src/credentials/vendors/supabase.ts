/**
 * Supabase vendor adapter.
 *
 * Supabase Management API (https://supabase.com/docs/reference/api):
 *   GET    /v1/projects                            — list projects
 *   GET    /v1/projects/{ref}/api-keys             — list api keys
 *   POST   /v1/projects/{ref}/api-keys             — create new api key (publishable)
 *   PATCH  /v1/projects/{ref}/api-keys/{id}        — rotate
 *   DELETE /v1/projects/{ref}/api-keys/{id}        — revoke
 *
 * NOTE: as of 2025, Supabase introduced *publishable* + *secret* api keys
 * alongside the legacy anon JWT + service_role JWT. The Management API
 * supports CRUD for publishable/secret keys; legacy JWTs are rotated via
 * "JWT secret rotation" which has no per-key API and rotates ALL legacy
 * keys at once.
 *
 * For our purposes:
 *   - Create/rotate/delete: publishable & secret api keys per project
 *   - Legacy JWT (anon, service_role): escalate to Paul for rotation
 *
 * Required env: WATNEY_SUPABASE_MGMT_PAT_STEWARD (Supabase access token,
 * created at https://supabase.com/dashboard/account/tokens).
 *
 * Project ref must be encoded into the canonical PURPOSE or threaded via
 * context. For now: read `scope_target` from the credential row before
 * delete/rotate; for create the caller must supply project ref in opts.context.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const MGMT_BASE = 'https://api.supabase.com';

function getMgmtToken(): string {
  const token = process.env.WATNEY_SUPABASE_MGMT_PAT_STEWARD;
  if (!token) throw new VendorBlockedError(
    'supabase',
    'create',
    'set WATNEY_SUPABASE_MGMT_PAT_STEWARD env var. Create at https://supabase.com/dashboard/account/tokens and store via scripts/register-secret.sh.',
  );
  return token;
}

/** Extract a project ref from the canonical name purpose or a context hint. */
function extractProjectRef(opts: { canonicalName: string; context?: string }): string | null {
  // Convention: if context starts with "project_ref:", use that.
  if (opts.context?.startsWith('project_ref:')) {
    return opts.context.slice('project_ref:'.length).trim();
  }
  return null;
}

export const supabaseAdapter: VendorAdapter = {
  vendor: 'SUPABASE',
  createSupported: true,
  rotateSupported: true,
  deleteSupported: true,
  notes: 'Modern publishable/secret keys via Mgmt API. Legacy anon/service_role JWTs escalate to Paul (no per-key API).',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const token = getMgmtToken();
    const projectRef = extractProjectRef(opts);
    if (!projectRef) {
      throw new VendorBlockedError(
        'supabase',
        'create',
        `Supabase create requires project ref in opts.context (format: "project_ref:<ref>"). canonicalName=${opts.canonicalName}`,
      );
    }
    // Modern API key style — "publishable" or "secret".
    const keyType = opts.purpose.includes('SERVICE_ROLE') ? 'secret' : 'publishable';
    const res = await fetch(`${MGMT_BASE}/v1/projects/${projectRef}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: keyType,
        name: opts.canonicalName,
        description: `created by credential-steward at ${new Date().toISOString()}: ${opts.context ?? ''}`,
      }),
    });
    if (!res.ok) {
      throw new UpstreamError('supabase', res.status, `create api key failed: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string; api_key?: string; key?: string; type?: string };
    const value = json.api_key ?? json.key;
    if (!value) throw new UpstreamError('supabase', null, `Supabase create returned no value; keys=${Object.keys(json).join(',')}`);
    return {
      value,
      vendorMetadata: { api_key_id: json.id, project_ref: projectRef, key_type: keyType },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    // Modern api keys: rotation is delete+create with same name; we just create new.
    const projectRef = (opts.currentVendorMetadata?.project_ref as string | undefined) ?? null;
    if (!projectRef) {
      throw new VendorBlockedError(
        'supabase',
        'rotate',
        `rotation requires existing vendorMetadata.project_ref for ${opts.canonicalName}. Likely legacy JWT — escalate to Paul.`,
      );
    }
    return this.createCredential({
      canonicalName: opts.canonicalName,
      purpose: 'ROTATION',
      scope: 'WATNEY',
      context: `project_ref:${projectRef}`,
    });
  },

  async deleteCredential(opts): Promise<boolean> {
    const token = getMgmtToken();
    const apiKeyId = opts.vendorMetadata?.api_key_id as string | undefined;
    const projectRef = opts.vendorMetadata?.project_ref as string | undefined;
    if (!apiKeyId || !projectRef) {
      throw new UpstreamError('supabase', null, 'deleteCredential requires vendorMetadata.api_key_id and vendorMetadata.project_ref');
    }
    const res = await fetch(`${MGMT_BASE}/v1/projects/${projectRef}/api-keys/${apiKeyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    // Health-check requires the project URL (different per project).
    // Convention: encode it as the metadata.project_url field at create time.
    // Without it, we can only verify the key is a parseable JWT.
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
      // Fallback: JWT structure check (3 segments separated by .)
      const segs = opts.value.split('.');
      if (segs.length !== 3) {
        return { healthy: false, lastChecked: now, failureReason: 'not a valid JWT structure' };
      }
      return { healthy: true, lastChecked: now, failureReason: 'JWT structure ok (no SUPABASE_URL for live check)' };
    }
    try {
      const res = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: opts.value, Authorization: `Bearer ${opts.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok || res.status === 200 || res.status === 404 /* PostgREST root with no schema */) {
        return { healthy: true, lastChecked: now };
      }
      if (res.status === 401 || res.status === 403) {
        return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status} auth failure` };
      }
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('supabase', null, (err as Error).message);
    }
  },
};
