/**
 * Service-role Supabase client + audit_log writer.
 *
 * Two code paths intentionally:
 *
 *   1. createSupabaseClient(opts)  — uses @supabase/supabase-js. Use in
 *      Cloud Run services and Next.js server code where the SDK is already
 *      a dependency or we want typed RPC results.
 *
 *   2. createRestClient(opts)      — a thin raw-fetch wrapper. Use in
 *      ultra-light Cloud Run Jobs that don't want to take the SDK as a
 *      dependency (credential-steward-daily is the canonical case).
 *
 * Both default to env vars SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or
 * NEXT_PUBLIC_SUPABASE_URL for cockpit code).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseClientOpts {
  url?: string;
  serviceRoleKey?: string;
  /** When true, throw if env vars are missing. Default true. */
  throwOnMissing?: boolean;
}

/**
 * Create a service-role Supabase JS client. Defaults to env-driven config.
 * Reads SUPABASE_URL (falls back to NEXT_PUBLIC_SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY.
 */
export function createSupabaseClient(opts: SupabaseClientOpts = {}): SupabaseClient {
  const url = opts.url ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (opts.throwOnMissing === false) {
      // Return a stub-ish client; callers should check env first if they pass
      // throwOnMissing:false. We still create the client (URL stub) to keep
      // type stable.
      return createClient(url ?? 'http://localhost', key ?? 'no-key');
    }
    const missing = [
      !url ? 'SUPABASE_URL' : null,
      !key ? 'SUPABASE_SERVICE_ROLE_KEY' : null,
    ].filter(Boolean).join(', ');
    throw new Error(`@watney/shared/supabase: missing env vars: ${missing}`);
  }
  return createClient(url, key);
}

// ─── Raw-fetch REST client (no SDK dep) ────────────────────────────────────

export interface RestClientOpts {
  url?: string;
  serviceRoleKey?: string;
}

export interface RestClient {
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Response>;
}

/**
 * Returns an object with a single `request` method that hits the configured
 * Supabase URL with PostgREST headers. Used by Cloud Run Jobs that want to
 * avoid the @supabase/supabase-js dependency footprint.
 */
export function createRestClient(opts: RestClientOpts = {}): RestClient {
  const url = opts.url ?? process.env.SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('@watney/shared/supabase: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for REST client');
  }
  return {
    async request(method, path, body): Promise<Response> {
      const headers: Record<string, string> = {
        apikey: key,
        Authorization: `Bearer ${key}`,
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Prefer'] = 'return=minimal';
      }
      return fetch(`${url}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
  };
}

// ─── audit_log writer ──────────────────────────────────────────────────────

export type AuditLevel = 'info' | 'warn' | 'error';
export type AuditTargetType = 'project' | 'client' | 'system' | 'credential' | 'session';

export interface AuditEvent {
  level: AuditLevel;
  action: string;
  actor: string;
  targetType: AuditTargetType;
  targetId?: string | null;
  notes?: Record<string, unknown>;
}

/**
 * Best-effort insert into public.audit_log. NEVER throws. Returns true if
 * the insert succeeded, false otherwise (and logs to stderr).
 *
 * Callers should fire-and-forget — audit failures should not break the
 * primary code path.
 */
export async function writeAuditLog(
  supabase: SupabaseClient,
  evt: AuditEvent,
): Promise<boolean> {
  try {
    const { error } = await supabase.from('audit_log').insert({
      level: evt.level,
      action: evt.action,
      actor: evt.actor,
      target_type: evt.targetType,
      target_id: evt.targetId ?? null,
      notes: evt.notes ? JSON.stringify(evt.notes) : null,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(`[audit_log] insert failed (${evt.action}): ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audit_log] insert threw (${evt.action}):`, err instanceof Error ? err.message : err);
    return false;
  }
}
