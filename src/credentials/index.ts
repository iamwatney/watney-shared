/**
 * @watney/shared/credentials — v2 credential lifecycle library.
 *
 * Six public functions:
 *   - getOrCreateCredential — anti-duplicate lookup + create-if-missing
 *   - rotateCredential — mint new value, update SM, schedule old disable
 *   - scheduleDeprecation — mark for delete (daily job executes after rollback)
 *   - getCredentialValue — read SM value for a canonical name
 *   - getCredentialMetadata — read DB row for a canonical name
 *   - healthCheckCredential — vendor-specific probe + audit
 *
 * All actions write to `credential_events` for audit trail.
 * Rate-limit: max 20 actions per vendor per day, max 50 across all vendors.
 *
 * Importable as:
 *   import { getOrCreateCredential, ... } from '@watney/shared/credentials';
 */
import { createLogger } from '../logger';
import { ConfigError } from '../errors';
import { buildCanonicalName, parseCanonicalName, isCanonicalConforming, registerScope, registerVendor } from './canonical-name';
import { createSmClient, type SmClient } from './secret-manager';
import { createRegistry, type CredentialRegistry } from './registry';
import { getVendorAdapter, listSupportedVendors } from './vendors';
import {
  CanonicalNameError,
  DuplicateCredentialError,
  OrphanSecretError,
  RateLimitExceededError,
  VendorBlockedError,
  type CanonicalKey,
  type CredentialAction,
  type CredentialRow,
  type Env,
  type HealthCheckResult,
  type Scope,
  type Vendor,
} from './types';
import {
  resolveCredential,
  smLeafOf,
  type ResolveOpts,
  type ResolveResult,
  type ResolveStatus,
  type CredentialSummary,
  type CreateRecommendation,
} from './resolve';

export {
  CanonicalNameError,
  DuplicateCredentialError,
  OrphanSecretError,
  RateLimitExceededError,
  VendorBlockedError,
  buildCanonicalName,
  parseCanonicalName,
  isCanonicalConforming,
  registerScope,
  registerVendor,
  createSmClient,
  createRegistry,
  getVendorAdapter,
  listSupportedVendors,
  resolveCredential,
  smLeafOf,
};
export type {
  CanonicalKey,
  CredentialAction,
  CredentialRow,
  Env,
  HealthCheckResult,
  Scope,
  Vendor,
  SmClient,
  CredentialRegistry,
  ResolveOpts,
  ResolveResult,
  ResolveStatus,
  CredentialSummary,
  CreateRecommendation,
};

const log = createLogger('watney-shared.credentials');

// ─── Module-level singletons (lazy) ────────────────────────────────────────
// Callers can override by passing explicit { sm, registry } per call.

let _sm: SmClient | null = null;
let _registry: CredentialRegistry | null = null;

function sm(): SmClient { return _sm ?? (_sm = createSmClient()); }
function registry(): CredentialRegistry { return _registry ?? (_registry = createRegistry()); }

/** Reset singletons — for tests. */
export function _resetForTests(opts: { sm?: SmClient; registry?: CredentialRegistry } = {}): void {
  _sm = opts.sm ?? null;
  _registry = opts.registry ?? null;
}

// ─── Rate limits ───────────────────────────────────────────────────────────

const DEFAULT_VENDOR_LIMIT = parseInt(process.env.WATNEY_CRED_VENDOR_RATE_LIMIT ?? '20', 10);
const DEFAULT_GLOBAL_LIMIT = parseInt(process.env.WATNEY_CRED_GLOBAL_RATE_LIMIT ?? '50', 10);

async function checkRateLimit(vendor: Vendor, action: CredentialAction): Promise<void> {
  // Skip rate-limit for read-only ops
  if (action === 'lookup-existing' || action === 'health-check-fail') return;
  const reg = registry();
  const globalCount = await reg.countAutonomousActionsToday();
  if (globalCount >= DEFAULT_GLOBAL_LIMIT) {
    throw new RateLimitExceededError('GLOBAL', globalCount, DEFAULT_GLOBAL_LIMIT);
  }
  const vendorCount = await reg.countAutonomousActionsToday({
    actor: `credential-steward-daily-${vendor.toLowerCase()}`,
  });
  if (vendorCount >= DEFAULT_VENDOR_LIMIT) {
    throw new RateLimitExceededError(vendor, vendorCount, DEFAULT_VENDOR_LIMIT);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface GetOrCreateOpts extends CanonicalKey {
  requester: string;
  context?: string;
  /** Override the auto-formatted canonical name (rare — naming-convention bypass). */
  overrideName?: string;
  /** If true and vendor adapter blocks creation, escalate to Paul rather than throw. */
  escalateOnBlock?: boolean;
}

export interface GetOrCreateResult {
  smName: string;
  smVersion: number;
  created: boolean;
  canonicalName: string;
  dbId: string;
}

/**
 * Returns existing credential or creates a new one. Idempotent via
 * canonical-key anti-duplicate check.
 */
export async function getOrCreateCredential(opts: GetOrCreateOpts): Promise<GetOrCreateResult> {
  const canonicalName = opts.overrideName ?? buildCanonicalName({
    scope: opts.scope, vendor: opts.vendor, purpose: opts.purpose, env: opts.env ?? null,
  });

  // Step 1: anti-duplicate check by canonical key (and by name)
  const reg = registry();
  const existing = await reg.findByCanonicalKey({
    scope: opts.scope, vendor: opts.vendor, purpose: opts.purpose, env: opts.env ?? null,
  });
  if (existing) {
    log.info({ canonicalName, dbId: existing.id, requester: opts.requester }, 'returning existing credential');
    await reg.insertEvent({
      credential_id: existing.id,
      credential_name: canonicalName,
      event_type: 'health-check',
      result: 'noop',
      actor: opts.requester,
      details: { kind: 'lookup-existing', canonical: canonicalName },
    });
    const version = await sm().latestVersion(existing.name);
    return {
      smName: existing.name,
      smVersion: version,
      created: false,
      canonicalName: existing.canonical_name ?? existing.name,
      dbId: existing.id,
    };
  }

  // Step 2: vendor adapter lookup
  const adapter = getVendorAdapter(opts.vendor);
  if (!adapter) {
    throw new ConfigError(opts.vendor, `no vendor adapter — supported: ${listSupportedVendors().join(',')}`);
  }
  if (!adapter.createSupported) {
    if (opts.escalateOnBlock) {
      log.warn({ canonicalName, vendor: opts.vendor, requester: opts.requester }, 'vendor create blocked — escalating');
      await reg.insertEvent({
        credential_name: canonicalName,
        event_type: 'review-required',
        result: 'pending',
        actor: opts.requester,
        details: { kind: 'escalate-to-paul', vendor: opts.vendor, purpose: opts.purpose, hint: adapter.notes ?? '' },
      });
      throw new VendorBlockedError(opts.vendor, 'create', adapter.notes ?? 'create not supported');
    }
    throw new VendorBlockedError(opts.vendor, 'create', adapter.notes ?? 'create not supported');
  }

  // Step 2.5 (F1 safety — audit finding): fail closed if the SM secret already
  // exists but has no registry row. `existing` (Step 1) was null → no DB row; if
  // the SM secret nonetheless exists this is an ORPHAN, and minting would create
  // a NEW vendor credential AND overwrite the orphan's live value. Orphans must
  // be registered metadata-only (registerExistingSecret). This runs BEFORE any
  // vendor mint so we never leak a freshly-minted credential.
  if (await sm().exists(canonicalName)) {
    log.warn(
      { canonicalName, requester: opts.requester },
      'getOrCreate refused: SM secret exists with no registry row (orphan) — register metadata-only',
    );
    await reg.insertEvent({
      credential_name: canonicalName,
      event_type: 'review-required',
      result: 'pending',
      actor: opts.requester,
      details: { kind: 'orphan-secret-mint-refused', canonical: canonicalName },
    });
    throw new OrphanSecretError(canonicalName);
  }

  // Step 3: rate-limit check
  await checkRateLimit(opts.vendor, 'create');

  // Step 4: mint value at vendor
  log.info({ canonicalName, vendor: opts.vendor, requester: opts.requester }, 'minting new credential');
  const { value, vendorMetadata } = await adapter.createCredential({
    canonicalName,
    purpose: opts.purpose,
    scope: opts.scope,
    env: opts.env,
    context: opts.context,
  });

  // Step 5: store in SM. We proved above the secret does not exist, so this is a
  // genuine create (create() still tolerates a 409 race defensively).
  const smCreateResult = await sm().create(canonicalName, value, {
    labels: {
      scope: opts.scope.toLowerCase(),
      vendor: opts.vendor.toLowerCase(),
      purpose: opts.purpose.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
      created_by: 'credential-steward-v2',
    },
  });

  // Step 6: insert DB row
  const inserted = await reg.insert({
    name: canonicalName,
    canonical_name: canonicalName,
    vendor: opts.vendor.toLowerCase(),
    credential_type: inferCredentialType(opts.vendor, opts.purpose),
    scope: opts.scope === 'WATNEY' || opts.scope === 'EDGE_AI' ? 'account-wide' : 'project-scoped',
    scope_target: opts.scope === 'WATNEY' || opts.scope === 'EDGE_AI' ? null : opts.scope,
    source_of_truth: 'gcp-secret-manager',
    source_location: `${process.env.GCP_PROJECT ?? 'watney-workflows'}/${canonicalName}`,
    privilege_scope: 'write',
    description: `Created by credential-steward v2 at ${new Date().toISOString()} for ${opts.requester}${opts.context ? ` — ${opts.context}` : ''}`,
    vendor_metadata: vendorMetadata,
    notes: `Vendor metadata: ${JSON.stringify(vendorMetadata)}`,
    owner: 'paul',
    confidence: 'HIGH',
    needs_review: false,
    created_by: opts.requester,
    purpose: opts.purpose,
    env: opts.env ?? null,
    rollback_days: 7,
    vendor_api_supports_create: adapter.createSupported,
    vendor_api_supports_rotation: adapter.rotateSupported,
    vendor_api_supports_delete: adapter.deleteSupported,
    tags: { products: [], purposes: [opts.purpose.toLowerCase()] },
  });

  // Step 7: audit event
  await reg.insertEvent({
    credential_id: inserted.id,
    credential_name: canonicalName,
    event_type: 'created',
    result: 'succeeded',
    actor: opts.requester,
    details: {
      kind: 'create',
      vendor: opts.vendor,
      purpose: opts.purpose,
      scope: opts.scope,
      env: opts.env,
      sm_version: smCreateResult.version,
      vendor_metadata: vendorMetadata,
    },
  });

  log.info({ canonicalName, dbId: inserted.id, smVersion: smCreateResult.version }, 'credential created');
  return {
    smName: canonicalName,
    smVersion: smCreateResult.version,
    created: true,
    canonicalName,
    dbId: inserted.id,
  };
}

export interface RotateOpts {
  canonicalName: string;
  requester: string;
  reason: string;
}

export interface RotateResult {
  newSmVersion: number;
  oldSmVersion: number;
  rollbackUntil: Date;
}

export async function rotateCredential(opts: RotateOpts): Promise<RotateResult> {
  const reg = registry();
  const row = await reg.findByName(opts.canonicalName);
  if (!row) throw new ConfigError(opts.canonicalName, 'credential not found in registry');
  const adapter = getVendorAdapter(row.vendor.toUpperCase());
  if (!adapter) throw new ConfigError(row.vendor, 'no vendor adapter');
  if (!adapter.rotateSupported) {
    throw new VendorBlockedError(row.vendor, 'rotate', adapter.notes ?? 'rotate not supported');
  }
  await checkRateLimit(row.vendor.toUpperCase(), 'rotate');

  const oldVersion = await sm().latestVersion(row.name);

  // Structured vendor metadata (F5) — column first, legacy notes fallback. The
  // old metadata is preserved as superseded_vendor_metadata so deprecation
  // revokes the OLD key, not the freshly-rotated one.
  const currentVendorMetadata = readVendorMetadata(row);

  const { value, vendorMetadata } = await adapter.rotateCredential({
    canonicalName: row.name,
    currentVendorMetadata,
  });

  const newVersion = (await sm().addVersion(row.name, value)).version;
  const rollbackDays = row.rollback_days ?? 7;
  const rollbackUntil = new Date(Date.now() + rollbackDays * 24 * 60 * 60 * 1000);

  await reg.update(row.id, {
    last_verified_at: new Date().toISOString(),
    last_verified_status: 'alive',
    last_verified_by: opts.requester,
    superseded_at: new Date().toISOString(),
    superseded_by_canonical_name: row.canonical_name ?? row.name,
    vendor_metadata: vendorMetadata,                     // new key (F5 — structured, authoritative)
    superseded_vendor_metadata: currentVendorMetadata,   // old key → correct revoke target
    notes: `${row.notes ?? ''} | Rotated ${new Date().toISOString()} by ${opts.requester}`,
  });

  await reg.insertEvent({
    credential_id: row.id,
    credential_name: row.name,
    event_type: 'rotated',
    result: 'succeeded',
    actor: opts.requester,
    details: {
      kind: 'rotate',
      reason: opts.reason,
      old_sm_version: oldVersion,
      new_sm_version: newVersion,
      rollback_until: rollbackUntil.toISOString(),
      vendor_metadata: vendorMetadata,
    },
  });

  return { newSmVersion: newVersion, oldSmVersion: oldVersion, rollbackUntil };
}

export interface ScheduleDeprecationOpts {
  canonicalName: string;
  reason: string;
  requester?: string;
}

export interface ScheduleDeprecationResult {
  scheduledDeleteAt: Date;
}

export async function scheduleDeprecation(opts: ScheduleDeprecationOpts): Promise<ScheduleDeprecationResult> {
  const reg = registry();
  const row = await reg.findByName(opts.canonicalName);
  if (!row) throw new ConfigError(opts.canonicalName, 'credential not found in registry');
  const rollbackDays = row.rollback_days ?? 7;
  const scheduledDeleteAt = new Date(Date.now() + rollbackDays * 24 * 60 * 60 * 1000);
  await reg.update(row.id, {
    pending_deprecation_at: scheduledDeleteAt.toISOString(),
    notes: `${row.notes ?? ''} | Scheduled deprecation by ${opts.requester ?? 'unknown'} at ${new Date().toISOString()} — reason: ${opts.reason}`,
  });
  await reg.insertEvent({
    credential_id: row.id,
    credential_name: row.name,
    event_type: 'flagged',
    result: 'pending',
    actor: opts.requester ?? 'credential-steward-v2',
    details: { kind: 'deprecate-scheduled', reason: opts.reason, scheduled_delete_at: scheduledDeleteAt.toISOString() },
  });
  return { scheduledDeleteAt };
}

export interface FinalizeDeprecationOpts {
  canonicalName: string;
  requester?: string;
  /** The vendor-side delete outcome, recorded in the audit event. */
  vendorDeleted?: boolean;
}

export interface FinalizeDeprecationResult {
  deprecatedAt: Date;
  alreadyDeprecated: boolean;
}

/**
 * Converge a credential to 'deprecated' AFTER its vendor key has been revoked
 * (audit F5). Sets `deprecated_at` + `last_verified_status='deprecated'` and
 * clears `pending_deprecation_at` so the daily job stops re-attempting the
 * delete every run (the old code deleted at the vendor but never converged the
 * DB → 404-loop + "auto-deprecated" re-reported daily). Writes a 'deprecated'
 * audit event. Idempotent: no-op if already deprecated.
 */
export async function finalizeDeprecation(opts: FinalizeDeprecationOpts): Promise<FinalizeDeprecationResult> {
  const reg = registry();
  const row = await reg.findByName(opts.canonicalName);
  if (!row) throw new ConfigError(opts.canonicalName, 'credential not found in registry');
  if (row.deprecated_at) {
    return { deprecatedAt: new Date(row.deprecated_at), alreadyDeprecated: true };
  }
  const deprecatedAt = new Date();
  await reg.update(row.id, {
    deprecated_at: deprecatedAt.toISOString(),
    last_verified_status: 'deprecated',
    last_verified_at: deprecatedAt.toISOString(),
    pending_deprecation_at: null, // stop the daily re-delete loop
  });
  await reg.insertEvent({
    credential_id: row.id,
    credential_name: row.name,
    event_type: 'deprecated',
    result: 'succeeded',
    actor: opts.requester ?? 'credential-steward-v2:finalizeDeprecation',
    details: {
      kind: 'deprecate-finalized',
      vendor_deleted: opts.vendorDeleted ?? null,
      deprecated_at: deprecatedAt.toISOString(),
    },
  });
  return { deprecatedAt, alreadyDeprecated: false };
}

export async function getCredentialValue(canonicalName: string): Promise<string> {
  return sm().read(canonicalName);
}

export async function getCredentialMetadata(canonicalName: string): Promise<CredentialRow | null> {
  return registry().findByName(canonicalName);
}

export async function healthCheckCredential(canonicalName: string): Promise<HealthCheckResult> {
  const reg = registry();
  const row = await reg.findByName(canonicalName);
  if (!row) {
    return { healthy: false, lastChecked: new Date(), failureReason: 'not in registry' };
  }
  const adapter = getVendorAdapter(row.vendor.toUpperCase());
  if (!adapter) {
    return { healthy: false, lastChecked: new Date(), failureReason: `no adapter for vendor ${row.vendor}` };
  }
  const value = await sm().read(row.name);
  try {
    const result = await adapter.healthCheck({ canonicalName: row.name, value });
    await reg.insertEvent({
      credential_id: row.id,
      credential_name: row.name,
      event_type: 'health-check',
      result: result.healthy ? 'alive' : 'dead',
      actor: 'credential-steward-v2:healthCheck',
      details: {
        kind: 'health-check',
        healthy: result.healthy,
        failure_reason: result.failureReason ?? null,
      },
    });
    return result;
  } catch (err) {
    return { healthy: false, lastChecked: new Date(), failureReason: (err as Error).message };
  }
}

export interface RegisterExistingOpts {
  /** The exact SM secret name (leaf) that already exists. */
  name: string;
  requester: string;
  context?: string;
}

/**
 * Register an SM secret that ALREADY EXISTS as a registry row — metadata only.
 *
 * NEVER mints, rotates, or writes the SM value. This is the safe handler for
 * "SM orphan with a conforming name" drift (audit F1): it records a row
 * referencing the existing value and flags `needs_review` so a human confirms
 * the inferred vendor/purpose. Idempotent: if a row already exists for the
 * name, returns it unchanged.
 */
export async function registerExistingSecret(
  opts: RegisterExistingOpts,
): Promise<GetOrCreateResult & { registered: boolean }> {
  const reg = registry();
  const name = opts.name;

  // Idempotency — already registered?
  const existing = await reg.findByName(name);
  if (existing) {
    const version = await sm().latestVersion(existing.name).catch(() => 0);
    return {
      smName: existing.name, smVersion: version, created: false, registered: false,
      canonicalName: existing.canonical_name ?? existing.name, dbId: existing.id,
    };
  }

  // Must actually exist in SM (read-only). If not, this is not an orphan.
  if (!(await sm().exists(name))) {
    throw new ConfigError(name, 'registerExistingSecret: SM secret does not exist — nothing to register');
  }
  const smVersion = await sm().latestVersion(name).catch(() => 0);

  const parsed = parseCanonicalName(name);
  const scopeSeg = parsed?.scope ?? null;
  const adapter = parsed ? getVendorAdapter(parsed.vendor) : null;

  // NB: `is_canonical` intentionally omitted → DB default (null) → the resolver
  // treats an un-adjudicated cluster as `ambiguous`. Keeps this decoupled from
  // migration ordering (insert never references the new column).
  const inserted = await reg.insert({
    name,
    canonical_name: name,
    vendor: parsed?.vendor.toLowerCase() ?? 'unknown',
    credential_type: parsed ? inferCredentialType(parsed.vendor, parsed.purpose) : 'api_key',
    scope: scopeSeg === 'WATNEY' || scopeSeg === 'EDGE_AI' ? 'account-wide' : 'project-scoped',
    scope_target: scopeSeg === 'WATNEY' || scopeSeg === 'EDGE_AI' ? null : scopeSeg,
    source_of_truth: 'gcp-secret-manager',
    source_location: `${process.env.GCP_PROJECT ?? 'watney-workflows'}/${name}`,
    description: `Registered metadata-only from SM orphan at ${new Date().toISOString()} by ${opts.requester}${opts.context ? ` — ${opts.context}` : ''}. Value NOT minted; references the existing secret.`,
    owner: 'paul',
    confidence: 'LOW',
    needs_review: true,
    created_by: opts.requester,
    purpose: parsed?.purpose ?? null,
    env: parsed?.env ?? null,
    rollback_days: 7,
    vendor_api_supports_create: adapter?.createSupported ?? null,
    vendor_api_supports_rotation: adapter?.rotateSupported ?? null,
    vendor_api_supports_delete: adapter?.deleteSupported ?? null,
  });

  await reg.insertEvent({
    credential_id: inserted.id,
    credential_name: name,
    event_type: 'created',
    result: 'succeeded',
    actor: opts.requester,
    details: { kind: 'register-orphan-metadata-only', canonical: name, sm_version: smVersion, note: 'metadata only — value not minted' },
  });

  log.info({ name, dbId: inserted.id }, 'registered SM orphan (metadata-only)');
  return { smName: name, smVersion, created: false, registered: true, canonicalName: name, dbId: inserted.id };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function inferCredentialType(vendor: Vendor, purpose: string): string {
  const v = vendor.toUpperCase();
  const p = purpose.toUpperCase();
  if (/WEBHOOK/.test(p)) return 'webhook_secret';
  if (/OAUTH/.test(p)) return p.includes('CLIENT') ? 'oauth_client_id' : 'oauth_refresh';
  if (/PAT/.test(p)) return 'pat';
  if (/SERVICE_ROLE/.test(p)) return 'service_role_jwt';
  if (/ANON/.test(p)) return 'anon_jwt';
  if (/APP_PASSWORD/.test(p)) return 'app_password';
  if (/SA_KEY/.test(p) || v === 'GCP') return 'sa_key';
  if (/MGMT/.test(p) || /MANAGEMENT/.test(p)) return 'management_api';
  if (/CONFIG_URL/.test(p)) return 'config_url';
  if (/CONFIG_VAL/.test(p)) return 'config_value';
  return 'api_key';
}

/**
 * Structured vendor metadata for a row (F5). Prefers the `vendor_metadata` jsonb
 * column; falls back to the legacy `Vendor metadata: {...}` notes marker — the
 * FIRST `{...}` run only, so a rotated row's appended text can't corrupt the
 * parse (the bug that made deprecation delete the wrong key). Returns {} if none.
 */
export function readVendorMetadata(
  row: Pick<CredentialRow, 'vendor_metadata' | 'notes'>,
): Record<string, unknown> {
  if (row.vendor_metadata && typeof row.vendor_metadata === 'object') {
    return row.vendor_metadata as Record<string, unknown>;
  }
  const m = (row.notes ?? '').match(/Vendor metadata: (\{[^}]*\})/);
  if (m) {
    try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { /* ignore */ }
  }
  return {};
}
