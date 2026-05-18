/**
 * Structured logger for Cloud Run + Next.js. Wraps pino.
 *
 * GCP Cloud Logging auto-detects JSON on stdout and presents fields as
 * filterable jsonPayload entries. Pino's `severity` mapping below aligns
 * Cloud Logging severity with pino numeric levels so filtering by severity
 * works in Logs Explorer.
 *
 * Defaults:
 *   - Level: env LOG_LEVEL (default 'info')
 *   - Format: JSON to stdout
 *   - Service name: passed to createLogger(), surfaces as `service` field
 *
 * Usage:
 *   import { createLogger } from '@watney/shared/logger';
 *   const log = createLogger('edge-ai-news-refresh');
 *   log.info({ items: 5 }, 'fetched news items');
 *   log.error({ err }, 'fatal');
 */
import pino, { type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/**
 * Cloud Logging severity mapping. pino default levels:
 *   trace=10, debug=20, info=30, warn=40, error=50, fatal=60
 * Mapped to GCP severity strings so jsonPayload.severity works in Logs.
 */
const GCP_SEVERITY = (label: string): { severity: string } => {
  switch (label) {
    case 'trace': return { severity: 'DEBUG' };
    case 'debug': return { severity: 'DEBUG' };
    case 'info':  return { severity: 'INFO' };
    case 'warn':  return { severity: 'WARNING' };
    case 'error': return { severity: 'ERROR' };
    case 'fatal': return { severity: 'CRITICAL' };
    default:      return { severity: 'DEFAULT' };
  }
};

export interface LoggerOpts {
  /** Override log level — default: env LOG_LEVEL or 'info'. */
  level?: pino.LevelWithSilent;
  /** Optional base fields merged into every log line. */
  base?: Record<string, unknown>;
}

/**
 * Create a structured logger bound to a service name. The service name
 * appears as the `service` field on every log line and is what to filter
 * on in GCP Logs Explorer.
 */
export function createLogger(serviceName: string, opts: LoggerOpts = {}): Logger {
  const level = opts.level
    ?? (process.env.LOG_LEVEL as pino.LevelWithSilent | undefined)
    ?? 'info';

  return pino({
    level,
    base: {
      service: serviceName,
      ...(opts.base ?? {}),
    },
    formatters: {
      level: (label) => GCP_SEVERITY(label),
    },
    // GCP recommends 'time' rather than the default pino msgTime.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    messageKey: 'message',
  });
}

/**
 * Default logger — useful for one-off scripts. Pass a serviceName via
 * createLogger() in real services so filtering works.
 */
export const logger = createLogger('watney-default');
