/**
 * Typed error classes for boundary translation.
 *
 * Throw these from any module where the failure category matters:
 *
 *   throw new ValidationError('uuid', value, 'must be a UUID');
 *   throw new UpstreamError('anthropic', 502, 'rate limited');
 *   throw new ConfigError('SUPABASE_URL', 'missing env var');
 *
 * formatForGcp(err) returns a structured object suitable for passing as
 * the `err` field to pino.error — Cloud Logging then renders it nicely.
 */

export class ValidationError extends Error {
  readonly kind = 'validation' as const;
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly reason: string,
  ) {
    super(`validation failed for ${field}: ${reason}`);
    this.name = 'ValidationError';
  }
}

export class UpstreamError extends Error {
  readonly kind = 'upstream' as const;
  constructor(
    public readonly upstream: string,
    public readonly statusCode: number | null,
    message: string,
  ) {
    super(`${upstream}: ${message}` + (statusCode ? ` (HTTP ${statusCode})` : ''));
    this.name = 'UpstreamError';
  }
}

export class ConfigError extends Error {
  readonly kind = 'config' as const;
  constructor(
    public readonly setting: string,
    reason: string,
  ) {
    super(`config error for ${setting}: ${reason}`);
    this.name = 'ConfigError';
  }
}

/**
 * Render an error in a shape that pino + Cloud Logging present well.
 * Falls back gracefully for non-Error inputs.
 */
export function formatForGcp(err: unknown): {
  name: string;
  message: string;
  stack?: string;
  kind?: string;
  meta?: Record<string, unknown>;
} {
  if (err instanceof ValidationError) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      kind: err.kind,
      meta: { field: err.field, reason: err.reason },
    };
  }
  if (err instanceof UpstreamError) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      kind: err.kind,
      meta: { upstream: err.upstream, statusCode: err.statusCode },
    };
  }
  if (err instanceof ConfigError) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      kind: err.kind,
      meta: { setting: err.setting },
    };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'NonErrorThrown', message: String(err) };
}
