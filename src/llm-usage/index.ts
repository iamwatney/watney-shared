/**
 * Fire-and-forget LLM usage logger.
 *
 * Inserts one row per Anthropic call into public.llm_usage_log on the cockpit
 * Supabase project. NEVER blocks the caller. NEVER throws.
 *
 * Two transport modes:
 *   - REST (raw fetch) — default. Drops into any Cloud Run Job without taking
 *     the @supabase/supabase-js dependency.
 *   - SDK — pass a SupabaseClient via opts.client to use the SDK path
 *     (cockpit Next.js code that already imports the SDK).
 *
 * Required env vars (or pass via opts):
 *   SUPABASE_URL                — cockpit Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role JWT
 *
 * Call-site convention:
 *   - endpoint: 'cloud-run-<service-name>' for Cloud Run Jobs, route name
 *     ('chat', 'scoping', 'uat-submit', etc) for in-app routes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// USD per million tokens — Anthropic published prices. Update if prices move.
// Single source of truth across the estate — previously duplicated 3 ways.
const USD_TO_GBP = 0.79;

interface ModelPrice { inputUsdPerMTok: number; outputUsdPerMTok: number }

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Haiku 4.5
  'claude-haiku-4-5-20251001':  { inputUsdPerMTok:  1, outputUsdPerMTok:  5 },
  'claude-haiku-4-5':           { inputUsdPerMTok:  1, outputUsdPerMTok:  5 },
  // Sonnet 4.6
  'claude-sonnet-4-6':          { inputUsdPerMTok:  3, outputUsdPerMTok: 15 },
  'claude-sonnet-4-6-20251001': { inputUsdPerMTok:  3, outputUsdPerMTok: 15 },
  // Opus 4 / 4.6 / 4.7
  'claude-opus-4':              { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  'claude-opus-4-6':            { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  'claude-opus-4-7':            { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
};

export function estimateCostGbp(model: string, inTok: number, outTok: number): number {
  const price = MODEL_PRICES[model] || MODEL_PRICES['claude-sonnet-4-6'];
  const inputUsd  = (inTok  / 1_000_000) * price.inputUsdPerMTok;
  const outputUsd = (outTok / 1_000_000) * price.outputUsdPerMTok;
  return (inputUsd + outputUsd) * USD_TO_GBP;
}

export interface LlmUsageEvent {
  endpoint: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  clientId?: string | null;
  sessionId?: string | null;
  apiKeyName?: string | null;
  // ─── NEW in v1.4.0 (telemetry-foundation) — all optional, default null ──
  // See Projects/telemetry-foundation/design-docs/2026-05-27-shared-lib-v1.2.0-design.md
  // and migration 021_telemetry_foundation.sql. Backwards-compatible by
  // construction: omit them and the row inserts with NULL.
  decisionId?: string | null;
  agentName?: string | null;
  promptVersion?: string | null;
  outcomeId?: string | null;
}

export interface LogLlmUsageOpts {
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
export function logLlmUsage(evt: LlmUsageEvent, opts: LogLlmUsageOpts = {}): Promise<void> {
  const cost = estimateCostGbp(evt.model, evt.inputTokens || 0, evt.outputTokens || 0);
  const row = {
    endpoint:           evt.endpoint,
    model:              evt.model,
    input_tokens:       evt.inputTokens || 0,
    output_tokens:      evt.outputTokens || 0,
    cost_gbp_estimate:  Number(cost.toFixed(6)),
    client_id:          evt.clientId ?? null,
    session_id:         evt.sessionId ?? null,
    api_key_name:       evt.apiKeyName ?? null,
    // ─── NEW in v1.4.0 — coerced to null when undefined ────────────────
    decision_id:        evt.decisionId ?? null,
    agent_name:         evt.agentName ?? null,
    prompt_version:     evt.promptVersion ?? null,
    outcome_id:         evt.outcomeId ?? null,
  };

  // SDK path
  if (opts.client) {
    return Promise.resolve(opts.client.from('llm_usage_log').insert([row]))
      .then((res: { error: { message: string } | null }) => {
        if (res?.error) {
          // eslint-disable-next-line no-console
          console.error(`[llmUsageLogger] insert failed: ${res.error.message}`);
        }
      })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[llmUsageLogger] insert threw:`, e instanceof Error ? e.message : e);
      });
  }

  // REST path (default)
  const url = opts.url ?? process.env.SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // eslint-disable-next-line no-console
    console.warn('[llmUsageLogger] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — skipping log');
    return Promise.resolve();
  }
  return fetch(`${url}/rest/v1/llm_usage_log`, {
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
      console.error(`[llmUsageLogger] POST ${resp.status}: ${txt.slice(0, 200)}`);
    }
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[llmUsageLogger] fetch threw:`, e instanceof Error ? e.message : e);
  });
}
