/**
 * GCP vendor adapter.
 *
 * GCP IAM Service Account Keys API:
 *   POST   /v1/projects/{project}/serviceAccounts/{sa}/keys       — create
 *   DELETE /v1/projects/{project}/serviceAccounts/{sa}/keys/{key} — delete
 *   GET    /v1/projects/{project}/serviceAccounts/{sa}/keys       — list
 *
 * NOTE: org policy `iam.disableServiceAccountKeyCreation` may block create.
 * If so, escalate to Paul.
 *
 * Required env: WATNEY_GCP_ADMIN_SA_KEY_STEWARD (JSON SA key with
 * roles/iam.serviceAccountKeyAdmin on the target project).
 *
 * Health check: validate the SA key by exchanging it for an access token
 * (JWT-bearer flow against oauth2 endpoint).
 */
import { UpstreamError } from '../../errors';
import { createHmac, createPrivateKey, createSign } from 'node:crypto';
import { VendorBlockedError, type HealthCheckResult, type VendorAdapter } from '../types';

interface SaKeyJson {
  type: string;
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id: string;
  token_uri?: string;
}

function getAdminSaKey(): SaKeyJson {
  const raw = process.env.WATNEY_GCP_ADMIN_SA_KEY_STEWARD;
  if (!raw) throw new VendorBlockedError(
    'gcp',
    'create',
    'set WATNEY_GCP_ADMIN_SA_KEY_STEWARD env var (JSON SA key with iam.serviceAccountKeyAdmin role).',
  );
  return JSON.parse(raw) as SaKeyJson;
}

/** Mint a Google access token from a service-account key via JWT-bearer flow. */
async function getAccessTokenFromSa(sa: SaKeyJson, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claim = {
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const enc = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = enc(header);
  const claimB64 = enc(claim);
  const signInput = `${headerB64}.${claimB64}`;
  const key = createPrivateKey(sa.private_key);
  const signer = createSign('RSA-SHA256');
  signer.update(signInput);
  const sig = signer.sign(key).toString('base64url');
  const assertion = `${signInput}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new UpstreamError('gcp', res.status, `oauth token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

function extractSaEmail(opts: { canonicalName: string; context?: string }): string | null {
  if (opts.context?.startsWith('sa_email:')) return opts.context.slice('sa_email:'.length).trim();
  return null;
}

export const gcpAdapter: VendorAdapter = {
  vendor: 'GCP',
  createSupported: true,
  rotateSupported: true,
  deleteSupported: true,
  notes: 'IAM SA Keys API. Org policy iam.disableServiceAccountKeyCreation may block — escalates on 403.',

  async createCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const sa = getAdminSaKey();
    const saEmail = extractSaEmail(opts);
    if (!saEmail) {
      throw new VendorBlockedError(
        'gcp',
        'create',
        `GCP create requires target SA email in opts.context (format: "sa_email:<email>"). canonicalName=${opts.canonicalName}`,
      );
    }
    const token = await getAccessTokenFromSa(sa, 'https://www.googleapis.com/auth/cloud-platform');
    const project = sa.project_id;
    const res = await fetch(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
          keyAlgorithm: 'KEY_ALG_RSA_2048',
        }),
      },
    );
    if (res.status === 403) {
      throw new VendorBlockedError('gcp', 'create', `org policy iam.disableServiceAccountKeyCreation likely blocking. Escalate.`);
    }
    if (!res.ok) throw new UpstreamError('gcp', res.status, `create SA key failed: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { name: string; privateKeyData: string };
    // privateKeyData is base64-encoded JSON
    const value = Buffer.from(json.privateKeyData, 'base64').toString('utf8');
    return {
      value,
      vendorMetadata: { key_name: json.name, sa_email: saEmail, project },
    };
  },

  async rotateCredential(opts): Promise<{ value: string; vendorMetadata: Record<string, unknown> }> {
    const saEmail = (opts.currentVendorMetadata?.sa_email as string | undefined);
    if (!saEmail) {
      throw new VendorBlockedError('gcp', 'rotate', `rotation requires existing vendorMetadata.sa_email for ${opts.canonicalName}`);
    }
    return this.createCredential({
      canonicalName: opts.canonicalName,
      purpose: 'ROTATION',
      scope: 'WATNEY',
      context: `sa_email:${saEmail}`,
    });
  },

  async deleteCredential(opts): Promise<boolean> {
    const sa = getAdminSaKey();
    const keyName = opts.vendorMetadata?.key_name as string | undefined;
    if (!keyName) throw new UpstreamError('gcp', null, 'deleteCredential requires vendorMetadata.key_name (projects/.../keys/...)');
    const token = await getAccessTokenFromSa(sa, 'https://www.googleapis.com/auth/cloud-platform');
    const res = await fetch(`https://iam.googleapis.com/v1/${keyName}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  },

  async healthCheck(opts): Promise<HealthCheckResult> {
    const now = new Date();
    try {
      const parsed = JSON.parse(opts.value) as SaKeyJson;
      if (parsed.type !== 'service_account') {
        return { healthy: false, lastChecked: now, failureReason: 'not a service_account key' };
      }
      const token = await getAccessTokenFromSa(parsed, 'https://www.googleapis.com/auth/cloud-platform.read-only');
      if (token) return { healthy: true, lastChecked: now };
      return { healthy: false, lastChecked: now, failureReason: 'no token returned' };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('invalid_grant')) return { healthy: false, lastChecked: now, failureReason: 'invalid_grant — key disabled or rotated' };
      throw new UpstreamError('gcp', null, msg);
    }
  },
};

// Suppress unused-import warning while keeping the helper available
void createHmac;
