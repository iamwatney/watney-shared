/**
 * Tavily vendor adapter.
 *
 * Tavily (research API) does NOT expose a public Admin API for key
 * lifecycle as of 2025. Keys are created in the dashboard at
 * https://app.tavily.com → API Keys.
 *
 * Adapter is health-check-only; create/rotate/delete escalate to Paul.
 *
 * Health check: POST /search with a 1-word query — 200 means key alive,
 * 401 means dead. We deliberately use a no-op query to minimise cost.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const TAVILY_BASE = 'https://api.tavily.com';

export const tavilyAdapter: VendorAdapter = {
  vendor: 'TAVILY',
  createSupported: false,
  rotateSupported: false,
  deleteSupported: false,
  notes: 'No public Admin API for key lifecycle. Health-check only.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    throw new VendorBlockedError(
      'tavily',
      'create',
      `Tavily key creation is manual. Open https://app.tavily.com → API Keys, create a key labelled "${opts.canonicalName}", then run scripts/register-secret.sh.`,
    );
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    throw new VendorBlockedError(
      'tavily',
      'rotate',
      `Tavily key rotation is manual. Open https://app.tavily.com → API Keys → regenerate "${opts.canonicalName}".`,
    );
  },

  async deleteCredential(opts): Promise<boolean> {
    throw new VendorBlockedError(
      'tavily',
      'delete',
      `Tavily key deletion is manual. Open https://app.tavily.com → API Keys → delete "${opts.canonicalName}".`,
    );
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch(`${TAVILY_BASE}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: opts.value, query: 'ping', max_results: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('tavily', null, (err as Error).message);
    }
  },
};
