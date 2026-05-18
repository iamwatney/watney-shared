/**
 * Shared types for the credentials sub-module.
 *
 * The canonical-name convention is enforced for *new* creates only:
 *   <SCOPE>_<VENDOR>_<PURPOSE>[_<ENV>]
 *
 * Historical names with their own conventions are left untouched.
 */

/** Workspace-level scope label. */
export type Scope = 'WATNEY' | 'EDGE_AI' | 'SLATE_CONTRACTS' | string;

/** Known vendor identifiers used in canonical names. */
export type Vendor =
  | 'ANTHROPIC'
  | 'GITHUB'
  | 'SUPABASE'
  | 'GCP'
  | 'VERCEL'
  | 'STRIPE'
  | 'CLOUDFLARE'
  | 'TAVILY'
  | 'OPENAI'
  | string;

/** Optional environment marker — only used where per-env isolation matters. */
export type Env = 'PROD' | 'STAGING' | 'DEV' | null;

/** Canonical key — uniquely identifies a credential's purpose. */
export interface CanonicalKey {
  scope: Scope;
  vendor: Vendor;
  purpose: string;
  env?: Env;
}

/**
 * Mirror of the credentials DB row (extended for v2).
 * The DB column names are snake_case; the TS interface uses camelCase
 * via the in-module helpers `rowToCredential` / `credentialToRow`.
 */
export interface CredentialRow {
  id: string;
  name: string;
  display_name?: string | null;
  description?: string | null;
  vendor: string;
  credential_type: string;
  scope: string;
  scope_target?: string | null;
  source_of_truth: string;
  source_location: string;
  privilege_scope?: string | null;
  test_command?: string | null;
  rotation_cadence_days?: number | null;
  last_verified_at?: string | null;
  last_verified_status?: string | null;
  last_verified_by?: string | null;
  expires_at?: string | null;
  owner?: string | null;
  confidence?: string | null;
  needs_review?: boolean | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;
  tags?: Record<string, unknown> | null;

  // v2 additions
  canonical_name?: string | null;
  /** TS-friendly canonical scope marker. snake_case in DB: scope_v2 not used; we reuse scope. */
  purpose?: string | null;
  env?: string | null;
  rollback_days?: number | null;
  pending_deprecation_at?: string | null;
  deprecated_at?: string | null;
  superseded_at?: string | null;
  superseded_by_canonical_name?: string | null;
  rotation_due_at?: string | null;
  vendor_api_supports_rotation?: boolean | null;
  vendor_api_supports_create?: boolean | null;
  vendor_api_supports_delete?: boolean | null;
}

/** Audit event written to credential_events for every steward action. */
export type CredentialAction =
  | 'create'
  | 'rotate'
  | 'deprecate'
  | 'register-orphan'
  | 'health-check-fail'
  | 'escalate-to-paul'
  | 'rate-limit-tripped'
  | 'reverted'
  | 'lookup-existing';

export interface CredentialEvent {
  credential_id?: string | null;
  credential_name: string;
  event_type: 'created' | 'rotated' | 'deprecated' | 'health-check' | 'flagged' | 'review-required' | 'reverted';
  result: 'succeeded' | 'failed' | 'pending' | 'noop' | 'alive' | 'dead' | 'untestable';
  actor: string;
  details: Record<string, unknown>;
}

/** Result of a vendor health check. */
export interface HealthCheckResult {
  healthy: boolean;
  lastChecked: Date;
  failureReason?: string;
}

/** Vendor adapter capability flags. */
export interface VendorCapabilities {
  vendor: Vendor;
  /** Vendor admin API can create a fresh credential value. */
  createSupported: boolean;
  /** Vendor admin API can rotate an existing credential (create-new-then-disable-old). */
  rotateSupported: boolean;
  /** Vendor admin API can delete/disable a credential by id. */
  deleteSupported: boolean;
  /** Human-readable reason if not supported. */
  notes?: string;
}

/** Vendor adapter contract. Each vendors/<name>.ts implements this. */
export interface VendorAdapter extends VendorCapabilities {
  /**
   * Mint a new credential value via the vendor admin API.
   * Returns the secret value (string) which the library will write to GCP SM.
   * Throw VendorBlockedError when the vendor has no create API (e.g. GitHub fine-grained PAT).
   */
  createCredential(opts: {
    canonicalName: string;
    purpose: string;
    scope: Scope;
    env?: Env;
    context?: string;
  }): Promise<{ value: string; vendorMetadata: Record<string, unknown> }>;

  /**
   * Rotate an existing credential — mint new value, return it.
   * Vendor adapter does NOT touch SM; the library does.
   */
  rotateCredential(opts: {
    canonicalName: string;
    currentVendorMetadata?: Record<string, unknown>;
  }): Promise<{ value: string; vendorMetadata: Record<string, unknown> }>;

  /**
   * Delete/disable a credential at the vendor.
   * Returns true if the operation completed.
   */
  deleteCredential(opts: {
    canonicalName: string;
    vendorMetadata?: Record<string, unknown>;
  }): Promise<boolean>;

  /**
   * Health-check using the credential value. Should be a cheap, idempotent
   * read-only call (e.g. GET /v1/models). Returns healthy:false on 401/403.
   * Throws on network errors (timeout, DNS failure, etc.) — those are
   * treated as untestable by callers.
   */
  healthCheck(opts: {
    canonicalName: string;
    value: string;
  }): Promise<HealthCheckResult>;
}

/** Thrown when a vendor admin operation is not supported by API. */
export class VendorBlockedError extends Error {
  readonly kind = 'vendor-blocked' as const;
  constructor(
    public readonly vendor: string,
    public readonly operation: 'create' | 'rotate' | 'delete',
    public readonly escalationHint: string,
  ) {
    super(`${vendor} admin API does not support ${operation}: ${escalationHint}`);
    this.name = 'VendorBlockedError';
  }
}

/** Thrown when an anti-duplicate check finds an existing credential with the same canonical key. */
export class DuplicateCredentialError extends Error {
  readonly kind = 'duplicate-credential' as const;
  constructor(
    public readonly canonicalName: string,
    public readonly existingId: string,
  ) {
    super(`credential already exists with canonical name ${canonicalName} (id ${existingId})`);
    this.name = 'DuplicateCredentialError';
  }
}

/** Thrown when a canonical name does not match the convention. */
export class CanonicalNameError extends Error {
  readonly kind = 'canonical-name' as const;
  constructor(public readonly attempted: string, public readonly reason: string) {
    super(`invalid canonical name "${attempted}": ${reason}`);
    this.name = 'CanonicalNameError';
  }
}

/** Thrown when the daily rate limit is exceeded. */
export class RateLimitExceededError extends Error {
  readonly kind = 'rate-limit' as const;
  constructor(
    public readonly vendor: string,
    public readonly count: number,
    public readonly limit: number,
  ) {
    super(`rate limit exceeded for vendor ${vendor}: ${count}/${limit} autonomous actions today`);
    this.name = 'RateLimitExceededError';
  }
}
