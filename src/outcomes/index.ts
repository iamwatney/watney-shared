/**
 * Fire-and-forget outcome logger (v1.4.0+).
 *
 * Inserts one row per derived/explicit outcome into public.outcomes on the
 * cockpit Supabase project. NEVER blocks the caller. NEVER throws.
 *
 * Two transport modes (same dual-transport pattern as logLlmUsage):
 *   - REST (raw fetch) — default. Drops into any Cloud Run Job without
 *     taking the @supabase/supabase-js dependency.
 *   - SDK — pass a SupabaseClient via opts.client to use the SDK path.
 *
 * Required env vars (or pass via opts):
 *   SUPABASE_URL                — cockpit Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role JWT
 *
 * One outcome per llm_usage_log row — UNIQUE constraint at the DB level. A
 * duplicate insert returns 409; this helper logs the error to stderr and
 * resolves cleanly. Callers should NOT await this.
 *
 * Authoritative writer in v1: Brain/.config/causal-retro.js (weekly job).
 * See Projects/telemetry-foundation/design-docs/2026-05-27-shared-lib-v1.2.0-design.md §3.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type OutcomeKind = 'success' | 'partial' | 'failure' | 'unknown';
export type OutcomeSignal =
  | 'self-reported'
  | 'user-correction'
  | 'downstream-failure'
  | 'silence'
  | 'derived';

export interface OutcomeEvent {
  /** Required — the llm_usage_log row this outcome rates. */
  llmUsageLogId: string;
  outcome: OutcomeKind;
  outcomeSignal: OutcomeSignal;
  /** Optional — link to session transcript / ticket / commit SHA. */
  evidenceUrl?: string | null;
  /** Optional — Decision slug that supersedes the one this call drove. */
  revisedByDecisionId?: string | null;
  notes?: string | null;
}

export interface LogOutcomeOpts {
  /** Optional SupabaseClient. When provided, uses the SDK path. */
  client?: SupabaseClient;
  /** Override env-driven URL (REST path only). */
  url?: string;
  /** Override env-driven key (REST path only). */
  serviceRoleKey?: string;
}

/**
 * Fire-and-forget. Never throws. Resolves once the POST completes or fails.
 * Callers should NOT await this — just call and continue.
 */
export function logOutcome(evt: OutcomeEvent, opts: LogOutcomeOpts = {}): Promise<void> {
  const row = {
    llm_usage_log_id:       evt.llmUsageLogId,
    outcome:                evt.outcome,
    outcome_signal:         evt.outcomeSignal,
    evidence_url:           evt.evidenceUrl ?? null,
    revised_by_decision_id: evt.revisedByDecisionId ?? null,
    notes:                  evt.notes ?? null,
  };

  // SDK path
  if (opts.client) {
    try {
      return Promise.resolve(opts.client.from('outcomes').insert([row]))
        .then((res: { error: { message: string } | null }) => {
          if (res?.error) {
            // eslint-disable-next-line no-console
            console.error(`[outcomes] insert failed: ${res.error.message}`);
          }
        })
        .catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`[outcomes] insert threw:`, e instanceof Error ? e.message : e);
        });
    } catch (e: unknown) {
      // SDK can throw synchronously on misuse (e.g. malformed client). Match
      // the "fire-and-forget, never throws" contract by swallowing here too.
      // eslint-disable-next-line no-console
      console.error(`[outcomes] sdk threw sync:`, e instanceof Error ? e.message : e);
      return Promise.resolve();
    }
  }

  // REST path (default)
  const url = opts.url ?? process.env.SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // eslint-disable-next-line no-console
    console.warn('[outcomes] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — skipping log');
    return Promise.resolve();
  }
  return fetch(`${url}/rest/v1/outcomes`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([row]),
  }).then(async (resp) => {
    if (!resp.ok) {
      const txt = await resp.text();
      // eslint-disable-next-line no-console
      console.error(`[outcomes] POST ${resp.status}: ${txt.slice(0, 200)}`);
    }
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[outcomes] fetch threw:`, e instanceof Error ? e.message : e);
  });
}
