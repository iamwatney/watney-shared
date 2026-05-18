/**
 * Canonical name format: <SCOPE>_<VENDOR>_<PURPOSE>[_<ENV>]
 *
 * All four segments use UPPER_SNAKE_CASE: letters A-Z, digits, underscore.
 * Letters MUST start the segment (no leading digit).
 * ENV is optional and constrained to PROD | STAGING | DEV.
 */
import { CanonicalNameError } from './types';
import type { CanonicalKey, Env, Scope, Vendor } from './types';

const SEGMENT_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_WHITELIST = new Set<string>(['PROD', 'STAGING', 'DEV']);

/**
 * Known scopes — top-level workspace partitions. New client scopes can be added.
 * Historical names start with `EDGE_AI_` or `WATNEY_` or a vendor name; only
 * names whose FIRST segment is one of these scopes count as canonical-conforming.
 */
const KNOWN_SCOPES = new Set<string>(['EDGE_AI', 'WATNEY', 'SLATE_CONTRACTS']);

/** Known vendor uppercase identifiers. */
const KNOWN_VENDORS = new Set<string>([
  'ANTHROPIC', 'GITHUB', 'SUPABASE', 'GCP', 'VERCEL', 'STRIPE',
  'CLOUDFLARE', 'TAVILY', 'OPENAI', 'GOOGLE', 'MICROSOFT', 'HUBSPOT',
]);

/** Allow callers to register additional scopes/vendors at runtime. */
export function registerScope(scope: string): void {
  if (!SEGMENT_RE.test(scope)) {
    throw new CanonicalNameError(scope, `scope "${scope}" must match /^[A-Z][A-Z0-9_]*$/`);
  }
  KNOWN_SCOPES.add(scope);
}

export function registerVendor(vendor: string): void {
  if (!SEGMENT_RE.test(vendor)) {
    throw new CanonicalNameError(vendor, `vendor "${vendor}" must match /^[A-Z][A-Z0-9_]*$/`);
  }
  KNOWN_VENDORS.add(vendor);
}

export interface ParsedCanonicalName {
  scope: Scope;
  vendor: Vendor;
  purpose: string;
  env: Env;
}

/**
 * Build a canonical name from segments. Validates each.
 * Throws CanonicalNameError on any segment-level violation.
 */
export function buildCanonicalName(key: CanonicalKey): string {
  validateSegment('scope', key.scope);
  validateSegment('vendor', key.vendor);
  validateSegment('purpose', key.purpose);
  const parts: string[] = [key.scope, key.vendor, key.purpose];
  if (key.env) {
    if (!ENV_WHITELIST.has(key.env)) {
      throw new CanonicalNameError(parts.concat([key.env]).join('_'), `env must be one of ${[...ENV_WHITELIST].join('|')}`);
    }
    parts.push(key.env);
  }
  return parts.join('_');
}

/**
 * Parse a canonical name back into segments.
 * Returns null on names that do NOT match the convention (historical names).
 *
 * Strict rules:
 *   1. First segment MUST be a known scope (or registered via registerScope).
 *      This filters out historical names like ANTHROPIC_API_KEY which would
 *      otherwise be ambiguously parsed.
 *   2. Second segment MUST be a known vendor (or registered).
 *   3. Last segment may be ENV (PROD|STAGING|DEV); if so, scope+vendor+purpose+env;
 *      otherwise scope+vendor+purpose only.
 */
export function parseCanonicalName(name: string): ParsedCanonicalName | null {
  const segs = name.split('_');
  if (segs.length < 3) return null;
  // Greedy scope match: try longest prefix that's a known scope
  let scopeLen = 0;
  for (let n = Math.min(segs.length - 2, 3); n >= 1; n--) {
    const candidate = segs.slice(0, n).join('_');
    if (KNOWN_SCOPES.has(candidate)) { scopeLen = n; break; }
  }
  if (scopeLen === 0) return null;
  const scope = segs.slice(0, scopeLen).join('_');
  // Vendor is the next segment after scope
  const vendor = segs[scopeLen];
  if (!KNOWN_VENDORS.has(vendor)) return null;
  // ENV detection
  let env: Env = null;
  let purposeEnd = segs.length;
  if (segs.length - scopeLen - 1 >= 2 && ENV_WHITELIST.has(segs[segs.length - 1])) {
    env = segs[segs.length - 1] as Env;
    purposeEnd = segs.length - 1;
  }
  const purposeSegs = segs.slice(scopeLen + 1, purposeEnd);
  if (purposeSegs.length === 0) return null;
  const purpose = purposeSegs.join('_');
  if (!SEGMENT_RE.test(scope) || !SEGMENT_RE.test(vendor) || !SEGMENT_RE.test(purpose)) {
    return null;
  }
  return { scope, vendor, purpose, env };
}

/**
 * Validate a single segment.
 */
function validateSegment(field: 'scope' | 'vendor' | 'purpose', value: string): void {
  if (!value) throw new CanonicalNameError(value, `${field} is empty`);
  if (!SEGMENT_RE.test(value)) {
    throw new CanonicalNameError(value, `${field} "${value}" must match /^[A-Z][A-Z0-9_]*$/`);
  }
}

/**
 * Returns true iff the given DB row name conforms to the v2 convention.
 * Historical names return false (and are left untouched by the steward).
 */
export function isCanonicalConforming(name: string): boolean {
  return parseCanonicalName(name) !== null;
}
