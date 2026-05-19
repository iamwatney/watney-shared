#!/usr/bin/env node
/**
 * qc-rls-gate-file.js — CI-friendly RLS file-mode gate (M7 vendored from C4).
 *
 * Pure file-parser: NO Supabase reads, NO secrets needed. Runs in
 * GitHub Actions on every PR that touches supabase/migrations/.
 *
 * Catches:
 *   A. CREATE TABLE in public without ENABLE ROW LEVEL SECURITY (AP-021)
 *   B. CREATE FUNCTION in public without REVOKE EXECUTE FROM PUBLIC, anon, authenticated (AP-021 + AP-025)
 *   C. CREATE VIEW in public without security_invoker=true (AP-021)
 *   D. CREATE SCHEMA without GRANT USAGE to authenticator, service_role, anon (AP-051)
 *
 * Flags:
 *   --migration-dir=PATH     dir to scan (default: ./supabase/migrations)
 *   --migration-file=PATH    single file
 *   --quiet                  suppress human summary
 *
 * Exit:
 *   0 = clean
 *   1 = violations found
 *   2 = internal error
 *
 * Source: ~/.claude/plugins/watney-crew/tools/qc-rls-gate.js (host variant
 * with prod audit + baseline machinery stripped).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).reduce((acc, a) => {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    acc[k] = v === undefined ? true : v;
  }
  return acc;
}, {});

const MIGRATION_DIR = args['migration-dir'] || path.join(process.cwd(), 'supabase', 'migrations');
const MIGRATION_FILE = args['migration-file'] || null;
const QUIET = !!args.quiet;

function logErr(msg) { if (!QUIET) console.error(msg); }

function checkFile(filepath) {
  const sql = fs.readFileSync(filepath, 'utf8');
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
  const violations = [];

  // A — CREATE TABLE in public
  const tableRe = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?<schema>\w+)\.)?(?<name>\w+)/gi;
  let m;
  while ((m = tableRe.exec(stripped)) !== null) {
    const schema = (m.groups.schema || 'public').toLowerCase();
    const name = m.groups.name;
    if (schema !== 'public') continue;
    const rlsRe = new RegExp(
      `\\balter\\s+table\\s+(?:public\\.)?${name}\\s+enable\\s+row\\s+level\\s+security\\b`,
      'i',
    );
    if (!rlsRe.test(stripped)) {
      violations.push({
        family: 'A_RLS_OFF',
        object: `public.${name}`,
        rule: 'CREATE TABLE in public requires ALTER TABLE <name> ENABLE ROW LEVEL SECURITY in the same file',
        ref: 'AP-021',
      });
    }
  }

  // B — CREATE FUNCTION in public
  const fnRe = /\bcreate(?:\s+or\s+replace)?\s+function\s+(?:(?<schema>\w+)\.)?(?<name>\w+)\s*\(/gi;
  while ((m = fnRe.exec(stripped)) !== null) {
    const schema = (m.groups.schema || 'public').toLowerCase();
    const name = m.groups.name;
    if (schema !== 'public') continue;
    const revokeRe = new RegExp(
      `\\brevoke\\s+(?:all(?:\\s+privileges)?|execute)[^;]*?\\bon\\s+(?:function\\s+)?(?:public\\.)?${name}\\s*\\([^;]*?\\bfrom\\s+([^;]+);`,
      'gi',
    );
    let r;
    let ok = false;
    while ((r = revokeRe.exec(stripped)) !== null) {
      const targets = r[1].toLowerCase().replace(/\s+/g, ' ');
      if (/\bpublic\b/.test(targets) && /\banon\b/.test(targets) && /\bauthenticated\b/.test(targets)) {
        ok = true; break;
      }
    }
    if (!ok) {
      violations.push({
        family: 'B_FUNCTION_PUBLIC',
        object: `public.${name}()`,
        rule: 'CREATE FUNCTION in public requires REVOKE EXECUTE ON FUNCTION <name>(...) FROM PUBLIC, anon, authenticated',
        ref: 'AP-021 + AP-025',
      });
    }
  }

  // C — CREATE VIEW in public
  const viewRe = /\bcreate(?:\s+or\s+replace)?\s+view\s+(?:(?<schema>\w+)\.)?(?<name>\w+)/gi;
  while ((m = viewRe.exec(stripped)) !== null) {
    const schema = (m.groups.schema || 'public').toLowerCase();
    const name = m.groups.name;
    if (schema !== 'public') continue;
    const inlineRe = new RegExp(
      `\\bcreate(?:\\s+or\\s+replace)?\\s+view\\s+(?:public\\.)?${name}\\b[^;]*?with\\s*\\([^)]*security_invoker\\s*=\\s*true`,
      'is',
    );
    const alterRe = new RegExp(
      `\\balter\\s+view\\s+(?:public\\.)?${name}\\s+set\\s*\\([^)]*security_invoker\\s*=\\s*true`,
      'i',
    );
    if (!inlineRe.test(stripped) && !alterRe.test(stripped)) {
      violations.push({
        family: 'C_VIEW_NO_INVOKER',
        object: `public.${name}`,
        rule: 'CREATE VIEW in public requires WITH (security_invoker = true) or ALTER VIEW <name> SET (security_invoker = true)',
        ref: 'AP-021',
      });
    }
  }

  // D — CREATE SCHEMA (AP-051)
  const schemaRe = /\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?(?<name>\w+)/gi;
  while ((m = schemaRe.exec(stripped)) !== null) {
    const name = m.groups.name;
    if (['public', 'auth', 'storage', 'realtime', 'extensions', 'graphql', 'vault'].includes(name.toLowerCase())) continue;
    const grantRe = new RegExp(
      `\\bgrant\\s+usage\\s+on\\s+schema\\s+${name}\\s+to\\s+([^;]+);`,
      'gi',
    );
    let g;
    let ok = false;
    while ((g = grantRe.exec(stripped)) !== null) {
      const targets = g[1].toLowerCase().replace(/\s+/g, ' ');
      if (/\bauthenticator\b/.test(targets) && /\bservice_role\b/.test(targets) && /\banon\b/.test(targets)) {
        ok = true; break;
      }
    }
    if (!ok) {
      violations.push({
        family: 'D_SCHEMA_NO_GRANT',
        object: `schema ${name}`,
        rule: 'CREATE SCHEMA requires GRANT USAGE ON SCHEMA <name> TO authenticator, service_role, anon',
        ref: 'AP-051',
      });
    }
  }

  return violations.map(v => ({ ...v, file: filepath }));
}

function checkAllFiles() {
  const out = [];
  if (MIGRATION_FILE) {
    if (!fs.existsSync(MIGRATION_FILE)) {
      logErr(`ERROR: migration file not found: ${MIGRATION_FILE}`);
      process.exit(2);
    }
    out.push(...checkFile(MIGRATION_FILE));
    return out;
  }
  if (!fs.existsSync(MIGRATION_DIR)) {
    logErr(`NOTE: migration dir not found: ${MIGRATION_DIR} (nothing to check)`);
    return out;
  }
  const files = fs.readdirSync(MIGRATION_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) out.push(...checkFile(path.join(MIGRATION_DIR, f)));
  return out;
}

const violations = checkAllFiles();

console.log(JSON.stringify({
  total_violations: violations.length,
  violations,
}, null, 2));

if (!QUIET) {
  logErr('\n-- QC RLS GATE (file mode) --');
  logErr(`Total violations: ${violations.length}`);
  for (const v of violations) {
    logErr(`  [${v.family}] ${v.object} in ${path.basename(v.file)} — ${v.rule} (ref: ${v.ref})`);
  }
  logErr('--');
}

process.exit(violations.length === 0 ? 0 : 1);
