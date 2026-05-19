#!/usr/bin/env node
/**
 * qc-shared-lib-gate-ci.js — CI variant of M1's qc-shared-lib-gate.
 *
 * Per-service checks (run via --service-dir):
 *   A. @watney/shared in package.json dependencies                  (M1)
 *   B. No console.log/console.error/console.warn in src/             (M9 — outside test/)
 *   C. API route handlers (src/app/api/*\/route.ts) contain
 *      .parse( or .safeParse(                                        (M10)
 *   D. No file in src/ duplicates code present in
 *      node_modules/@watney/shared/dist                              (M1)
 *
 * Differences from host-side qc-shared-lib-gate.js:
 *   - No --agents-mode (M5 preamble check is host-side only)
 *   - No baseline (CI runs from scratch each time)
 *   - No --override-reason (PR body override is handled by the workflow)
 *
 * Flags:
 *   --service-dir=PATH      single service to check (required)
 *   --quiet                 suppress human summary
 *
 * Exit:
 *   0 = clean
 *   1 = violations found
 *   2 = internal error (bad args)
 *
 * Source: ~/.claude/plugins/watney-crew/tools/qc-shared-lib-gate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).reduce((acc, a) => {
  if (a.startsWith('--')) {
    const idx = a.indexOf('=');
    if (idx === -1) acc[a.slice(2)] = true;
    else acc[a.slice(2, idx)] = a.slice(idx + 1);
  }
  return acc;
}, {});

const SERVICE_DIR = args['service-dir'] || null;
const QUIET = !!args.quiet;

if (!SERVICE_DIR) {
  console.error('ERROR: --service-dir=PATH is required');
  process.exit(2);
}
if (!fs.existsSync(SERVICE_DIR)) {
  console.error(`ERROR: --service-dir does not exist: ${SERVICE_DIR}`);
  process.exit(2);
}

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
  let pj;
  try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); }
  catch (e) {
    return [{ family: 'A_BAD_PACKAGE_JSON', object: pjPath, rule: e.message, ref: 'M1', severity: 'fatal' }];
  }
  const deps = Object.keys(pj.dependencies || {});
  // Carve-out: pure shared libs / type-only packages don't need @watney/shared
  // (they ARE the shared layer). Heuristic: name starts with @watney/ AND has no
  // server entry (no src/index.* with createServer/listen).
  const isSharedLib = (pj.name || '').startsWith('@watney/') && !pj.scripts?.start;
  if (isSharedLib) return [];
  if (!deps.includes('@watney/shared')) {
    return [{
      family: 'A_MISSING_WATNEY_SHARED_DEP',
      object: `${pj.name || serviceDir} package.json`,
      rule: '"@watney/shared" must appear in dependencies (pin via "github:iamwatney/watney-shared#vX.Y.Z" or workspace:*)',
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
      if (entry.isDirectory()) {
        if (['test', 'tests', '__tests__', 'node_modules', 'dist', 'build'].includes(entry.name)) continue;
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
    let count = 0;
    let m;
    while ((m = re.exec(stripped)) !== null) count++;
    if (count > 0) {
      violations.push({
        family: 'B_CONSOLE_IN_SRC',
        object: path.relative(serviceDir, file),
        count,
        rule: `${count} console.* call(s) — use createLogger from @watney/shared/logger`,
        ref: 'M9',
        severity: 'warn',
      });
    }
  }
  return violations;
}

function checkApiRoutesUseZod(serviceDir) {
  const apiDir = path.join(serviceDir, 'src', 'app', 'api');
  if (!fs.existsSync(apiDir)) return [];
  const violations = [];
  function recurse(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { recurse(p); continue; }
      if (entry.name !== 'route.ts' && entry.name !== 'route.js') continue;
      const text = fs.readFileSync(p, 'utf8');
      const hasPostOrPut =
        /\b(POST|PUT|PATCH)\s*[:=]/.test(text) ||
        /export\s+(async\s+)?function\s+(POST|PUT|PATCH)\b/.test(text);
      if (!hasPostOrPut) continue;
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

function fingerprint(text) {
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

function checkNoDuplicateOfShared(serviceDir) {
  const sharedDist = path.join(serviceDir, 'node_modules', '@watney', 'shared', 'dist');
  if (!fs.existsSync(sharedDist)) return [];
  const sharedFingerprints = new Map();
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

const violations = [
  ...checkPackageJson(SERVICE_DIR),
  ...checkNoConsole(SERVICE_DIR),
  ...checkApiRoutesUseZod(SERVICE_DIR),
  ...checkNoDuplicateOfShared(SERVICE_DIR),
];

console.log(JSON.stringify({
  service_dir: SERVICE_DIR,
  total_violations: violations.length,
  violations,
}, null, 2));

if (!QUIET) {
  logErr(`\n-- QC SHARED LIB GATE (CI mode) --`);
  logErr(`Service: ${SERVICE_DIR}`);
  logErr(`Total violations: ${violations.length}`);
  for (const v of violations) {
    logErr(`  [${v.family}] ${v.object} — ${v.rule} (ref: ${v.ref}, sev: ${v.severity})`);
  }
  logErr('--');
}

// Errors fail the gate; warns do not.
const errorCount = violations.filter(v => v.severity === 'error' || v.severity === 'fatal').length;
process.exit(errorCount === 0 ? 0 : 1);
