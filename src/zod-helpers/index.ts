/**
 * Common Zod schemas for validation at API and job boundaries (M10).
 *
 * Import sub-schemas where you need them:
 *
 *   import { uuidSchema, isoDateSchema } from '@watney/shared/zod-helpers';
 *
 *   const Body = z.object({
 *     id: uuidSchema,
 *     created_at: isoDateSchema,
 *     amount: gbpAmountSchema,
 *   });
 *   const parsed = Body.parse(await req.json());
 */
import { z } from 'zod';

/** RFC 4122 UUID (v1–v5 incl. zero/max). Postgres uuid columns. */
export const uuidSchema = z.string().uuid({ message: 'must be a UUID' });

/** ISO 8601 datetime string. Strict — rejects no-Z, no-time formats. */
export const isoDateSchema = z.string().datetime({
  message: 'must be an ISO 8601 datetime string (e.g. 2026-05-18T12:34:56Z)',
});

/** RFC 5322-ish email — Zod's built-in is good enough for our use. */
export const emailSchema = z.string().email({ message: 'must be a valid email' });

/**
 * client_id — Supabase uuid for the `clients` table. Same shape as
 * uuidSchema; kept named for grep-ability and clearer error messages.
 */
export const clientIdSchema = uuidSchema.describe('client_id');

/** project_id — Supabase uuid for `projects`. */
export const projectIdSchema = uuidSchema.describe('project_id');

/** session_id — internal identifier for a chat session (text, not uuid). */
export const sessionIdSchema = z.string().min(1).max(128);

/** scoping_data_id / scoping_detail_id — Supabase uuids. */
export const scopingDataIdSchema = uuidSchema.describe('scoping_data_id');
export const scopingDetailIdSchema = uuidSchema.describe('scoping_detail_id');

/**
 * GBP amount in pence-precision. Numbers must be finite and non-negative.
 * Returns the number unchanged; callers can wrap with `.transform()` if
 * they want a pence-integer representation.
 */
export const gbpAmountSchema = z.number().finite().nonnegative();

/** Anthropic model identifier — open-ended string, no regex enforcement. */
export const anthropicModelSchema = z.string().min(1).max(64);

/** Cloud Run service / job name — lowercase, dashes, 1-63 chars. */
export const cloudRunNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, {
    message: 'Cloud Run name must be lowercase letters, digits and dashes, starting with a letter',
  });

/** Re-export Zod itself so consumers don't need a separate import. */
export { z };
