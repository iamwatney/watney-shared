# `ci-gates/` — Headless Crew CI Gate (M7)

Independent CI gate that runs on every PR opened by the headless overnight crew
(`auto/<session_id>-dev` branches → main). Block auto-merge unless every check
passes.

## What's here

```
ci-gates/
├── README.md                         (this file)
├── workflows/
│   └── headless-crew-ci-gate.yml     workflow template; copy to client repo .github/workflows/
├── scripts/
│   ├── qc-rls-gate-file.js           C4 file-mode check (no Supabase reads)
│   └── qc-shared-lib-gate-ci.js      M1 simplified for CI runners
└── install.sh                        helper to vendor scripts + workflow into a repo
```

## How to wire it up in a new client repo

```bash
# from the client repo root, with a clone of iamwatney/watney-shared at ../watney-shared:
bash ../watney-shared/ci-gates/install.sh
git add .github/
git commit -m "ci: add headless crew gate (M7)"
git push
```

This drops the workflow + scripts into `.github/`. Once the workflow runs once,
the status check `headless-crew-ci-gate / gate` shows up in PR rollups and the
Orchestrator's `openHeadlessPullRequest` blocks auto-merge until it goes green.

## Enforcement model (read this — important)

Branch protection / rulesets are NOT used (GitHub Free plan blocks them on
private repos). Enforcement is **client-side in the Orchestrator's
PR-merge helper**: before invoking `octokit.pulls.merge()` on a PASS-path PR,
the Orchestrator polls the status-check rollup and refuses to merge if the
gate isn't green. Manual merges by Paul (admin) are still allowed.

## The seven check families

| # | Family | Where it runs | When it triggers |
|---|---|---|---|
| 1 | Lint | `npm run lint` | Always (if script exists) |
| 2 | Typecheck | `npm run typecheck` | Always (if script exists) |
| 3 | Tests | `npm test` | Always (if script exists) |
| 4 | Build | `npm run build` | Always (if script exists) |
| 5 | Gitleaks (C9) | `gitleaks/gitleaks-action@v2` | Always |
| 6 | QC RLS gate (C4) | `node .github/scripts/qc-rls-gate-file.js` | If `supabase/migrations/**/*.sql` in diff |
| 7 | QC shared-lib gate (M1) | `node .github/scripts/qc-shared-lib-gate-ci.js` | If `package.json` exists |

`npm` scripts are skipped (not failed) when not declared. This means a tiny
client repo with no test/lint setup still passes — appropriate floor.

## Override

PR body line `override-ci-gate: <reason>` skips the whole job. Audited
via the workflow's annotation step. Use very sparingly.

## Updating gate scripts

Edit `scripts/*.js` in this repo, push, then re-run `install.sh` in each
client repo (or pull-vendor manually). There is no auto-pull mechanism —
keep it simple, gate scripts change infrequently.

## Related docs

- Design doc: `Projects/edge-agentic-workflow/design-docs/2026-05-18-m7-ci-gate-with-remediation-loop.md`
- Original gate scripts (host-side, QC Deploy Agent variants):
  `~/.claude/plugins/watney-crew/tools/qc-{rls,drift,shared-lib}-gate.js`
