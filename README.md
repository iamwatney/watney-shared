# @watney/shared

Shared runtime utilities for the Watney service estate. Installed in every Cloud Run service and the Next.js cockpit as a pinned git URL dependency:

```
"@watney/shared": "github:iamwatney/watney-shared#v1.0.0"
```

## Sub-modules

- **`@watney/shared/supabase`** — `createSupabaseClient(opts)` (SDK path), `createRestClient(opts)` (raw-fetch for lightweight Cloud Run Jobs), and `writeAuditLog(supabase, evt)` for best-effort audit_log inserts that never throw.
- **`@watney/shared/llm-usage`** — `logLlmUsage(evt, opts)` fire-and-forget insert into `public.llm_usage_log` with built-in Anthropic pricing table. Replaces the 3 byte-identical copies of `usageLogger.ts`.
- **`@watney/shared/logger`** — `createLogger(serviceName)` returns a `pino` logger configured for GCP Cloud Logging (JSON to stdout, severity mapping). M9.
- **`@watney/shared/zod-helpers`** — common schemas (`uuidSchema`, `isoDateSchema`, `clientIdSchema`, `projectIdSchema`, `emailSchema`, `gbpAmountSchema`, etc) for input validation at API route + job boundaries. M10. Re-exports `z` from zod.
- **`@watney/shared/prompts`** — `ANTI_INJECTION_PREAMBLE` constant. Source of truth for the M5 anti-injection preamble that watney-crew agents include in their system prompts.
- **`@watney/shared/errors`** — typed error classes (`ValidationError`, `UpstreamError`, `ConfigError`) and `formatForGcp(err)` for structured pino logging.

## Usage

```ts
import { createLogger } from '@watney/shared/logger';
import { logLlmUsage } from '@watney/shared/llm-usage';
import { uuidSchema, z } from '@watney/shared/zod-helpers';

const log = createLogger('edge-ai-news-refresh');

const BodySchema = z.object({ scopingDataId: uuidSchema });
const body = BodySchema.parse(await req.json());

log.info({ scopingDataId: body.scopingDataId }, 'starting news refresh');

logLlmUsage({
  endpoint: 'cloud-run-news-refresh',
  model: 'claude-sonnet-4-6',
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
});
```

## Versioning

Semver via git tags. Consumer services pin an exact version:

```
"@watney/shared": "github:iamwatney/watney-shared#v1.0.0"
```

Breaking changes bump major; new sub-modules bump minor; bug fixes bump patch.

## Tests

```bash
npm test         # node --test against dist/
npm run build    # tsc → dist/
npm run typecheck
```

## Origins

Shipped 2026-05-18 as the M1+M5+M9+M10 bundle from the 2026-05-17 architectural review. See `Projects/edge-agentic-workflow/design-docs/2026-05-18-m1-bundle-shared-library.md` for the design rationale.
