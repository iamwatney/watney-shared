/**
 * Stripe vendor adapter.
 *
 * Stripe Restricted API Keys can be created via the Dashboard but Stripe
 * does NOT expose an API for creating Restricted Keys (the underlying
 * `apikeys` endpoint exists internally but is not in the public API).
 *
 * Stripe DOES expose:
 *   POST /v1/webhook_endpoints — create webhook endpoint (returns secret)
 *   DELETE /v1/webhook_endpoints/{id} — delete webhook
 *   GET /v1/webhook_endpoints — list
 *
 * So:
 *   - PURPOSE='WEBHOOK_SECRET' → create/rotate/delete via webhook_endpoints API
 *   - PURPOSE='API_KEY' / 'RESTRICTED_KEY' → escalate to Paul (Dashboard step)
 *
 * Required env: WATNEY_STRIPE_ADMIN_KEY_STEWARD (a Stripe restricted key
 * with `webhook_endpoints:write` capability). Note Paul will need to
 * create this manually in Dashboard one time.
 *
 * Health check: GET /v1/account — 200 means key alive.
 */
import { UpstreamError } from '../../errors';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

const STRIPE_BASE = 'https://api.stripe.com';

function getAdminKey(): string {
  const key = process.env.WATNEY_STRIPE_ADMIN_KEY_STEWARD;
  if (!key) throw new VendorBlockedError(
    'stripe',
    'create',
    'set WATNEY_STRIPE_ADMIN_KEY_STEWARD env var (Stripe Restricted Key with webhook_endpoints:write). Create in Dashboard → Developers → API keys → Restricted keys.',
  );
  return key;
}

function isWebhookPurpose(purpose: string): boolean {
  return /WEBHOOK/i.test(purpose);
}

export const stripeAdapter: VendorAdapter = {
  vendor: 'STRIPE',
  createSupported: true, // webhook secrets only
  rotateSupported: true,
  deleteSupported: true,
  notes: 'Webhook secrets via webhook_endpoints API. Restricted/Standard API keys must be created in Dashboard — escalate.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    if (!isWebhookPurpose(opts.purpose)) {
      throw new VendorBlockedError(
        'stripe',
        'create',
        `Stripe API/Restricted keys cannot be created via API. Create in Dashboard → Developers → API keys, then run scripts/register-secret.sh. canonicalName=${opts.canonicalName}`,
      );
    }
    const adminKey = getAdminKey();
    // Webhook endpoint URL must come via context: "webhook_url:<url>"
    const url = opts.context?.startsWith('webhook_url:')
      ? opts.context.slice('webhook_url:'.length).trim()
      : 'https://example.com/placeholder-update-me';
    const body = new URLSearchParams({
      url,
      'enabled_events[]': '*',
      description: opts.canonicalName,
    });
    const res = await fetch(`${STRIPE_BASE}/v1/webhook_endpoints`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) throw new UpstreamError('stripe', res.status, `create webhook failed: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id: string; secret: string };
    return {
      value: json.secret,
      vendorMetadata: { webhook_id: json.id, url },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    // Stripe doesn't expose rotation for webhook secrets directly; the pattern
    // is: create-new + delete-old. We let the library handle that lifecycle.
    const url = (opts.currentVendorMetadata?.url as string | undefined) ?? 'https://example.com/placeholder';
    return this.createCredential({
      canonicalName: opts.canonicalName,
      purpose: 'WEBHOOK_SECRET',
      scope: 'WATNEY',
      context: `webhook_url:${url}`,
    });
  },

  async deleteCredential(opts): Promise<boolean> {
    const adminKey = getAdminKey();
    const webhookId = opts.vendorMetadata?.webhook_id as string | undefined;
    if (!webhookId) throw new UpstreamError('stripe', null, 'deleteCredential requires vendorMetadata.webhook_id');
    const res = await fetch(`${STRIPE_BASE}/v1/webhook_endpoints/${webhookId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    return res.ok || res.status === 404;
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const res = await fetch(`${STRIPE_BASE}/v1/account`, {
        headers: { Authorization: `Bearer ${opts.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true, lastChecked: now };
      if (res.status === 401 || res.status === 403) return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
      return { healthy: false, lastChecked: now, failureReason: `HTTP ${res.status}` };
    } catch (err) {
      throw new UpstreamError('stripe', null, (err as Error).message);
    }
  },
};
