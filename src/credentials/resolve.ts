/**
 * resolveCredential — reuse-first credential resolution.
 *
 * The primary entry point for "a session needs a credential". It is READ-ONLY
 * and DETERMINISTIC: it never mints, never writes, never calls a vendor. It
 * answers the question "which existing credential should I use for
 * (vendor, purpose[, scope, env])?" and, only when nothing suitable exists,
 * recommends creation (the caller decides whether to invoke the generate path).
 *
 * Reliability contract (why a new session can trust the answer):
 *   - `resolved`  → exactly one credential is the right answer (single match, or
 *                   a single canonical among several). Carries a freshness stamp.
 *   - `ambiguous` → multiple candidates and none is marked canonical. We DO NOT
 *                   guess — we return the tied set and flag for disambiguation.
 *   - `not_found` → nothing exists; returns a least-privilege creation recommendation.
 *
 * Canonical precedence: structured `is_canonical=true` first, then the legacy
 * `[CANONICAL]` marker in `notes` (read only until the backfill completes).
 */
import { createRegistry, type CredentialRegistry } from './registry';
import { getVendorAdapter } from './vendors';
import { buildCanonicalName, parseCanonicalName } from './canonical-name';
import type { CredentialRow } from './types';

export type ResolveStatus = 'resolved' | 'ambiguous' | 'not_found';
export type Freshness = 'fresh' | 'stale' | 'unverified' | 'dead';

/** How recently a credential must have verified `alive` to count as `fresh`. */
const FRESH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days (daily-verified system)

export interface CredentialSummary {
  id: string;
  name: string;
  canonicalName: string | null;
  /** GCP SM leaf where the value lives (parsed from source_location). */
  smName: string;
  vendor: string;
  purpose: string | null;
  scope: string | null;
  env: string | null;
  credentialType: string | null;
  privilegeScope: string | null;
  isCanonical: boolean;
  sourceOfTruth: string;
  sourceLocation: string;
  lastVerifiedAt: string | null;
  lastVerifiedStatus: string | null;
  freshness: Freshness;
  deprecated: boolean;
}

export interface CreateRecommendation {
  action: 'create';
  /** Suggested canonical name (only when scope + purpose were supplied). */
  canonicalName: string | null;
  /** Whether the vendor adapter can mint via API, or 'unknown' for unmapped vendors. */
  vendorApiCanCreate: boolean | 'unknown';
  leastPrivilegeHint: string;
  /** True when creation needs a human/browser step or explicit sign-off (new vendor, account-wide). */
  escalate: boolean;
  escalateReason?: string;
}

export interface ResolveResult {
  status: ResolveStatus;
  query: { vendor: string; purpose?: string; scope?: string; env?: string | null };
  /** Present iff status === 'resolved'. */
  best?: CredentialSummary;
  /** Ranked. For 'resolved': best first, then usable alternatives. For 'ambiguous': the tied set. */
  candidates: CredentialSummary[];
  /** Human-readable one-liner a session/agent can surface verbatim. */
  reason: string;
  /** Present iff status === 'resolved': how to retrieve the value (NEVER the value itself). */
  howToAccess?: string;
  /** Present iff status === 'not_found'. */
  recommendation?: CreateRecommendation;
}

export interface ResolveOpts {
  vendor: string;
  purpose?: string;
  scope?: string;
  env?: string | null;
  /** Injectable for tests. Defaults to the live cockpit registry. */
  registry?: CredentialRegistry;
  /** Injectable for deterministic freshness in tests. */
  now?: Date;
  /** GCP project for the access recipe. Default: env GCP_PROJECT or 'watney-workflows'. */
  gcpProject?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The GCP SM leaf a row points at. Mirrors the steward's smLeafName so guidance
 * and drift detection agree. Handles "proj/NAME" and "gcp-sm:NAME@proj (...)".
 */
export function smLeafOf(row: CredentialRow): string {
  const loc = (row.source_location ?? '').trim();
  const gcpSm = loc.match(/^gcp-sm:([^@\s]+)@/i);
  if (gcpSm) return gcpSm[1];
  const slash = loc.match(/^[^/\s]+\/([^\s]+)/);
  if (slash) return slash[1];
  return row.name;
}

function isCanonicalRow(row: CredentialRow): boolean {
  if (row.is_canonical === true) return true;
  if (row.is_canonical === false) return false;
  // Legacy fallback: [CANONICAL] in notes, but NOT a consolidation candidate.
  const notes = row.notes ?? '';
  return /\[CANONICAL\]/i.test(notes) && !/\[POTENTIAL-CONSOLIDATION-CANDIDATE\]/i.test(notes);
}

function freshnessOf(row: CredentialRow, now: number): Freshness {
  const status = (row.last_verified_status ?? '').toLowerCase();
  if (status === 'dead' || status === 'orphan') return 'dead';
  if (!row.last_verified_at) return 'unverified';
  const age = now - Date.parse(row.last_verified_at);
  if (Number.isNaN(age)) return 'unverified';
  if (status === 'alive' && age <= FRESH_MAX_AGE_MS) return 'fresh';
  return 'stale';
}

function toSummary(row: CredentialRow, now: number): CredentialSummary {
  return {
    id: row.id,
    name: row.name,
    canonicalName: row.canonical_name ?? null,
    smName: smLeafOf(row),
    vendor: row.vendor,
    purpose: row.purpose ?? null,
    scope: row.scope ?? null,
    env: row.env ?? null,
    credentialType: row.credential_type ?? null,
    privilegeScope: row.privilege_scope ?? null,
    isCanonical: isCanonicalRow(row),
    sourceOfTruth: row.source_of_truth,
    sourceLocation: row.source_location,
    lastVerifiedAt: row.last_verified_at ?? null,
    lastVerifiedStatus: row.last_verified_status ?? null,
    freshness: freshnessOf(row, now),
    deprecated: row.deprecated_at != null,
  };
}

/** Score how well a row matches the requested purpose. 0 = no match. */
function purposeScore(row: CredentialRow, purpose: string): number {
  const want = purpose.trim().toLowerCase();
  if (!want) return 1; // no purpose constraint
  const wantCompact = want.replace(/[^a-z0-9]/g, '');
  let score = 0;
  const rowPurpose = (row.purpose ?? '').toLowerCase();
  if (rowPurpose && rowPurpose === want) score = Math.max(score, 100);
  else if (rowPurpose && rowPurpose.replace(/[^a-z0-9]/g, '') === wantCompact) score = Math.max(score, 90);
  else if (rowPurpose && rowPurpose.includes(want)) score = Math.max(score, 60);
  const hay = `${row.canonical_name ?? ''} ${row.name} ${row.description ?? ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (hay.includes(wantCompact) && wantCompact.length >= 3) score = Math.max(score, 50);
  const tagPurposes = (row.tags?.purposes as string[] | undefined) ?? [];
  if (Array.isArray(tagPurposes) && tagPurposes.some(p => String(p).toLowerCase() === want)) score = Math.max(score, 80);
  return score;
}

/** Rank usable candidates: canonical → freshness → not-deprecated → recency. */
function rankUsable(a: CredentialSummary, b: CredentialSummary): number {
  if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
  const order: Record<Freshness, number> = { fresh: 0, unverified: 1, stale: 2, dead: 3 };
  if (order[a.freshness] !== order[b.freshness]) return order[a.freshness] - order[b.freshness];
  if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1;
  const at = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) : 0;
  const bt = b.lastVerifiedAt ? Date.parse(b.lastVerifiedAt) : 0;
  return bt - at;
}

function accessRecipe(s: CredentialSummary, gcpProject: string): string {
  if (s.sourceOfTruth === 'gcp-secret-manager') {
    return `gcloud secrets versions access latest --secret=${s.smName} --project=${gcpProject} | tr -d '\\r\\n'  # BOM-safe read (AP-008); never paste the value into logs`;
  }
  return `source of truth: ${s.sourceOfTruth} @ ${s.sourceLocation} — read the value from there, do not copy it into code`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function resolveCredential(opts: ResolveOpts): Promise<ResolveResult> {
  const reg = opts.registry ?? createRegistry();
  const now = (opts.now ?? new Date()).getTime();
  const gcpProject = opts.gcpProject ?? process.env.GCP_PROJECT ?? 'watney-workflows';
  const query = { vendor: opts.vendor, purpose: opts.purpose, scope: opts.scope, env: opts.env ?? null };

  const all = await reg.listByVendor(opts.vendor);

  // Hard filters: env (when supplied, keep exact-env or env-agnostic rows).
  let rows = all;
  if (opts.env) {
    const wantEnv = opts.env.toUpperCase();
    rows = rows.filter(r => !r.env || r.env.toUpperCase() === wantEnv);
  }
  // Scope: soft filter — prefer matching scope/scope_target but don't exclude
  // account-wide rows (they serve every scope).
  if (opts.scope) {
    const wantScope = opts.scope.toUpperCase();
    const scoped = rows.filter(r => {
      const s = (r.scope ?? '').toUpperCase();
      const st = (r.scope_target ?? '').toUpperCase();
      return s === wantScope || st === wantScope || s === 'ACCOUNT-WIDE';
    });
    if (scoped.length > 0) rows = scoped;
  }
  // Purpose: keep only rows that score > 0 IF any do; else fall through to
  // vendor-level candidates (a session that named a purpose we can't match
  // should still be told what exists rather than a false "nothing here").
  if (opts.purpose) {
    const scored = rows
      .map(r => ({ r, s: purposeScore(r, opts.purpose as string) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (scored.length > 0) rows = scored.map(x => x.r);
  }

  // Not-found → creation recommendation (reuse-first satisfied: nothing exists).
  if (rows.length === 0) {
    return notFound(opts, query, gcpProject);
  }

  const summaries = rows.map(r => toSummary(r, now));
  // "Usable" = not deprecated and not dead. Dead/deprecated are reported but not chosen.
  const usable = summaries.filter(s => !s.deprecated && s.freshness !== 'dead').sort(rankUsable);
  const canonical = usable.filter(s => s.isCanonical);

  // Decision — conservative, never guess.
  if (usable.length === 1) {
    const best = usable[0];
    return resolved(best, usable, query, gcpProject,
      `Single ${opts.vendor} credential for this purpose — use ${best.name} (${best.freshness}).`);
  }
  if (canonical.length === 1) {
    const best = canonical[0];
    const alts = usable.filter(s => s.id !== best.id);
    return resolved(best, [best, ...alts], query, gcpProject,
      `${usable.length} candidates; ${best.name} is marked canonical — use it.`);
  }
  if (canonical.length > 1) {
    return {
      status: 'ambiguous', query, candidates: canonical,
      reason: `${canonical.length} rows are all marked canonical for ${opts.vendor}${opts.purpose ? `/${opts.purpose}` : ''} — data conflict; disambiguate (only one may be canonical).`,
    };
  }
  // >1 usable, none canonical → do not guess.
  if (usable.length > 1) {
    return {
      status: 'ambiguous', query, candidates: usable,
      reason: `${usable.length} ${opts.vendor} credentials match${opts.purpose ? ` "${opts.purpose}"` : ''} and none is marked canonical — needs disambiguation before a session can rely on one. Candidates: ${usable.map(s => s.name).join(', ')}.`,
    };
  }
  // Everything is dead/deprecated — surface it rather than silently recommend create.
  return {
    status: 'ambiguous', query, candidates: summaries.sort(rankUsable),
    reason: `All ${summaries.length} ${opts.vendor} credential(s) for this purpose are dead or deprecated — needs attention (rotate or recreate) before use.`,
  };
}

function resolved(
  best: CredentialSummary,
  candidates: CredentialSummary[],
  query: ResolveResult['query'],
  gcpProject: string,
  reason: string,
): ResolveResult {
  const staleWarn = best.freshness === 'fresh' ? '' : ` ⚠ last verified ${best.lastVerifiedAt ?? 'never'} (${best.freshness}).`;
  return { status: 'resolved', query, best, candidates, reason: reason + staleWarn, howToAccess: accessRecipe(best, gcpProject) };
}

function notFound(
  opts: ResolveOpts,
  query: ResolveResult['query'],
  _gcpProject: string,
): ResolveResult {
  const adapter = getVendorAdapter(opts.vendor);
  const vendorApiCanCreate: boolean | 'unknown' = adapter ? adapter.createSupported : 'unknown';
  let canonicalName: string | null = null;
  if (opts.scope && opts.purpose) {
    try {
      canonicalName = buildCanonicalName({
        scope: opts.scope.toUpperCase(),
        vendor: opts.vendor.toUpperCase(),
        purpose: opts.purpose.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        env: (opts.env?.toUpperCase() as 'PROD' | 'STAGING' | 'DEV' | undefined) ?? null,
      });
    } catch { canonicalName = null; }
  }
  const accountWide = (opts.scope ?? '').toUpperCase() === 'WATNEY' || (opts.scope ?? '').toUpperCase() === 'EDGE_AI';
  const escalate = vendorApiCanCreate !== true || accountWide;
  const escalateReason = vendorApiCanCreate === 'unknown'
    ? `no vendor adapter for "${opts.vendor}" — manual creation + register-secret.sh`
    : vendorApiCanCreate === false
      ? `${opts.vendor} has no create API (${adapter?.notes ?? 'manual step'}) — create in the vendor UI, then register-secret.sh`
      : accountWide
        ? 'account-wide secret — confirm scope/least-privilege before minting'
        : undefined;
  return {
    status: 'not_found', query, candidates: [],
    reason: `No existing ${opts.vendor} credential${opts.purpose ? ` for "${opts.purpose}"` : ''}${opts.scope ? ` in scope ${opts.scope}` : ''}. Reuse-first found nothing → generate one (fallback).`,
    recommendation: {
      action: 'create',
      canonicalName,
      vendorApiCanCreate,
      leastPrivilegeHint: 'grant the minimum scope the consumer needs; prefer WIF/short-lived for GCP consumers; never account-wide by default',
      escalate,
      escalateReason,
    },
  };
}
