#!/usr/bin/env node
/**
 * qc-shared-lib-gate.js — @watney/shared adoption + standards gate.
 *
 * Pre-Gate-3 enforcement in the QC Deploy Agent. Mirrors the structure
 * of qc-rls-gate.js + qc-drift-gate.js (C4/C5). Fail-closed unless the
 * deploy-brief contains: `override-shared-lib-gate: <reason>`.
 *
 * Five check families per CONSUMER SERVICE (run via --service-dir):
 *   A. @watney/shared in package.json dependencies        (M1)
 *   B. No console.log/console.error/console.warn in src/  (M9 — outside test/ dirs)
 *   C. API route handlers (src/app/api/* /route.ts) contain .parse( or .safeParse( (M10)
 *   D. No file in src/ duplicates code present in node_modules/@watney/shared/ (M1)
 *   E. (skipped here — agent .md preamble is checked via --agents-mode)
 *
 * Plus an agent-files mode (--agents-mode) that walks
 * `~/.claude/plugins/watney-crew/agents/` and checks each .md file
 * contains the M5 ANTI_INJECTION_PREAMBLE header.
 *
 * Flags:
 *   --service-dir=PATH      single service to check (M1+M9+M10 families)
 *   --services-from=PATH    newline-separated file of service dirs
 *   --agents-mode           switch to agent-files mode (M5 preamble)
 *   --agents-dir=PATH       override default agent dir
 *   --baseline              write current violations to qc-shared-lib-gate-baseline.json (does NOT exit 1)
 *   --baseline-file=PATH    custom baseline location
 *   --override-reason=TEXT  if non-empty, exit 0 regardless of violations (logged)
 *   --quiet                 suppress human summary (JSON only)
 *
 * Exit codes:
 *   0 — all checks passed (or override / baseline-only run)
 *   1 — one or more violations found beyond baseline
 *   2 — internal error (bad args, etc.)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── arg parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2).reduce((acc, a) => {
  if (a.startsWith('--')) {
    const idx = a.indexOf('=');
    if (idx === -1) {
      acc[a.slice(2)] = true;
    } else {
      acc[a.slice(2, idx)] = a.slice(idx + 1);
    }
  }
  return acc;
}, {});

const SERVICE_DIR = args['service-dir'] || null;
const SERVICES_FROM = args['services-from'] || null;
const AGENTS_MODE = !!args['agents-mode'];
const DEFAULT_AGENTS_DIR = path.join(os.homedir(), '.claude', 'plugins', 'watney-crew', 'agents');
const AGENTS_DIR = args['agents-dir'] || DEFAULT_AGENTS_DIR;
const BASELINE_FILE = args['baseline-file'] || path.join(process.cwd(), 'qc-shared-lib-gate-baseline.json');
const WRITE_BASELINE = !!args.baseline;
const OVERRIDE_REASON = typeof args['override-reason'] === 'string' ? args['override-reason'] : null;
const QUIET = !!args.quiet;

function logErr(msg) { if (!QUIET) console.error(msg); }

// ─── per-service checks ────────────────────────────────────────────────────

function checkPackageJson(serviceDir) {
  const pjPath = path.join(serviceDir, 'package.json');
  if (!fs.existsSync(pjPath)) {
    return [{
      family: 'A_NO_PACKAGE_JSON',
      object: pjPath,
      rule: 'service directory must contain package.json',
      ref: 'M1',
      severity: 'fatal',
    }];
  }
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  const deps = Object.keys(pj.dependencies || {});
  if (!deps.includes('@watney/shared')) {
    return [{
      family: 'A_MISSING_WATNEY_SHARED_DEP',
      object: `${pj.name || serviceDir} package.json`,
      rule: '"@watney/shared" must appear in dependencies (pin via "github:iamwatney/watney-shared#vX.Y.Z")',
      ref: 'M1',
      severity: 'error',
    }];
  }
  return [];
}

function walkSrcFiles(serviceDir) {
  const srcDir = path.join(serviceDir, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const out = [];
  function recurse(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      // skip test directories
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') continue;
        if (entry.name === 'node_modules') continue;
        recurse(p);
        continue;
      }
      if (!/\.(t|j)sx?$/.test(entry.name)) continue;
      if (/\.test\.(t|j)sx?$/.test(entry.name)) continue;
      if (/\.spec\.(t|j)sx?$/.test(entry.name)) continue;
      out.push(p);
    }
  }
  recurse(srcDir);
  return out;
}

function checkNoConsole(serviceDir) {
  const violations = [];
  const re = /\bconsole\.(log|warn|error|info|debug|trace)\s*\(/g;
  for (const file of walkSrcFiles(serviceDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    let m;
    let count = 0;
    while ((m = re.exec(stripped)) !== null) count++;
    if (count > 0) {
      violations.push({
        family: 'B_CONSOLE_IN_SRC',
        object: path.relative(serviceDir, file),
        count,
        rule: `${count} console.* call(s) in src/ — use createLogger from @watney/shared/logger`,
        ref: 'M9',
        severity: 'warn',
      });
    }
  }
  return violations;
}

function checkApiRoutesUseZod(serviceDir) {
  const apiDir = path.join(serviceDir, 'src', 'app', 'api');
  if (!fs.existsSync(apiDir)) return []; // not a Next.js app — N/A
  const violations = [];
  function recurse(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(p);
        continue;
      }
      if (entry.name !== 'route.ts' && entry.name !== 'route.js') continue;
      const text = fs.readFileSync(p, 'utf8');
      const hasPostOrPut = /\b(POST|PUT|PATCH)\s*[:=]/.test(text) || /export\s+(async\s+)?function\s+(POST|PUT|PATCH)\b/.test(text);
      if (!hasPostOrPut) continue; // GET-only routes don't need body validation
      const hasZod = /\b(z\.|zod)/.test(text) && (/\.parse\(/.test(text) || /\.safeParse\(/.test(text));
      if (!hasZod) {
        violations.push({
          family: 'C_API_ROUTE_NO_ZOD',
          object: path.relative(serviceDir, p),
          rule: 'POST/PUT/PATCH route handler must validate body via z.<schema>.parse() or .safeParse()',
          ref: 'M10',
          severity: 'warn',
        });
      }
    }
  }
  recurse(apiDir);
  return violations;
}

function checkNoDuplicateOfShared(serviceDir) {
  // Heuristic: any file in src/ that matches a fingerprint of files in
  // node_modules/@watney/shared/dist is a likely duplicate.
  // Fingerprint = first 120 chars after the first non-comment line.
  const sharedDist = path.join(serviceDir, 'node_modules', '@watney', 'shared', 'dist');
  if (!fs.existsSync(sharedDist)) return [];

  const sharedFingerprints = new Map(); // fingerprint -> shared file
  function recurseShared(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { recurseShared(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const txt = fs.readFileSync(p, 'utf8');
      const fp = fingerprint(txt);
      if (fp) sharedFingerprints.set(fp, p);
    }
  }
  recurseShared(sharedDist);

  const violations = [];
  for (const file of walkSrcFiles(serviceDir)) {
    const txt = fs.readFileSync(file, 'utf8');
    const fp = fingerprint(txt);
    if (fp && sharedFingerprints.has(fp)) {
      violations.push({
        family: 'D_DUPLICATE_OF_SHARED',
        object: path.relative(serviceDir, file),
        rule: `byte-near-identical to node_modules/${path.relative(serviceDir, sharedFingerprints.get(fp))} — delete and import from @watney/shared`,
        ref: 'M1',
        severity: 'error',
      });
    }
  }
  return violations;
}

function fingerprint(text) {
  // Strip comments + leading whitespace, keep first 5 non-empty meaningful lines.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('import') && !l.startsWith('export') && !l.startsWith('//'))
    .slice(0, 5)
    .join('\n');
  return stripped.length > 80 ? stripped.slice(0, 240) : null;
}

function checkService(serviceDir) {
  const all = [
    ...checkPackageJson(serviceDir),
    ...checkNoConsole(serviceDir),
    ...checkApiRoutesUseZod(serviceDir),
    ...checkNoDuplicateOfShared(serviceDir),
  ];
  return all.map(v => ({ ...v, service: path.basename(serviceDir) }));
}

// ─── agent .md preamble check ──────────────────────────────────────────────

const PREAMBLE_HEADER = '# Security: prompt-injection resistance (M5)';

function checkAgentFiles() {
  const violations = [];
  if (!fs.existsSync(AGENTS_DIR)) {
    return [{
      family: 'E_AGENTS_DIR_MISSING',
      object: AGENTS_DIR,
      rule: `agents directory not found — check --agents-dir`,
      ref: 'M5',
      severity: 'fatal',
    }];
  }
  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name.endsWith('.bak') || entry.name.includes('.bootstrap-')) continue;
    const p = path.join(AGENTS_DIR, entry.name);
    const txt = fs.readFileSync(p, 'utf8');
    if (!txt.includes(PREAMBLE_HEADER)) {
      violations.push({
        family: 'E_AGENT_MD_NO_M5_PREAMBLE',
        object: entry.name,
        rule: `agent .md must include the M5 ANTI_INJECTION_PREAMBLE header verbatim ("${PREAMBLE_HEADER}")`,
        ref: 'M5',
        severity: 'error',
      });
    }
  }
  return violations;
}

// ─── baseline + main ───────────────────────────────────────────────────────

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); }
  catch (e) { logErr(`WARN: bad baseline file (${e.message}); ignoring`); return null; }
}

function violationKey(v) {
  return `${v.family}:${v.service || ''}:${v.object}`;
}

function diffAgainstBaseline(current, baseline) {
  if (!baseline) return current;
  const baseSet = new Set((baseline.violations || []).map(violationKey));
  return current.filter(v => !baseSet.has(violationKey(v)));
}

(async () => {
  let violations = [];

  if (AGENTS_MODE) {
    violations = checkAgentFiles();
  } else if (SERVICE_DIR) {
    violations = checkService(SERVICE_DIR);
  } else if (SERVICES_FROM) {
    if (!fs.existsSync(SERVICES_FROM)) {
      logErr(`ERROR: --services-from file not found: ${SERVICES_FROM}`);
      process.exit(2);
    }
    const dirs = fs.readFileSync(SERVICES_FROM, 'utf8')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('#'));
    for (const d of dirs) {
      if (!fs.existsSync(d)) {
        logErr(`WARN: service dir missing, skipping: ${d}`);
        continue;
      }
      violations.push(...checkService(d));
    }
  } else {
    logErr('ERROR: must provide --service-dir, --services-from, or --agents-mode');
    process.exit(2);
  }

  const baseline = loadBaseline();
  const baselineUsed = baseline ? BASELINE_FILE : null;
  const newViolations = diffAgainstBaseline(violations, baseline);

  if (WRITE_BASELINE) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      captured_at: new Date().toISOString(),
      mode: AGENTS_MODE ? 'agents' : 'services',
      violations,
    }, null, 2));
    logErr(`BASELINE written to ${BASELINE_FILE} (${violations.length} violation(s) recorded)`);
    process.exit(0);
  }

  console.log(JSON.stringify({
    mode: AGENTS_MODE ? 'agents' : 'services',
    baseline_used: baselineUsed,
    total_violations: violations.length,
    new_violations_count: newViolations.length,
    violations: newViolations,
  }, null, 2));

  if (!QUIET) {
    logErr('\n-- QC SHARED LIB GATE - SUMMARY --');
    logErr(`Mode: ${AGENTS_MODE ? 'agents' : 'services'}`);
    logErr(`Baseline: ${baselineUsed || 'NONE'}`);
    logErr(`Total violations: ${violations.length}`);
    logErr(`New (post-baseline) violations: ${newViolations.length}`);
    for (const v of newViolations) {
      const where = v.service ? `[${v.service}] ` : '';
      logErr(`  ${where}[${v.family}] ${v.object} -- ${v.rule} (ref: ${v.ref}${v.severity ? ', sev: ' + v.severity : ''})`);
    }
    logErr('--');
  }

  if (newViolations.length === 0) process.exit(0);

  if (OVERRIDE_REASON && OVERRIDE_REASON.length > 0) {
    logErr(`OVERRIDE accepted (reason: "${OVERRIDE_REASON}") — exit 0 despite ${newViolations.length} new violations`);
    process.exit(0);
  }

  process.exit(1);
})().catch(e => {
  logErr(`FATAL: ${e.stack || e.message}`);
  process.exit(2);
});
