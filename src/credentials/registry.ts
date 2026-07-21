/**
 * Registry helpers — PostgREST against cockpit Supabase.
 *
 * Uses @watney/shared/supabase createRestClient under the hood. The
 * registry is the source of truth for credential metadata; SM is the
 * source of truth for credential values.
 */
import { createRestClient, type RestClient } from '../supabase';
import type { CanonicalKey, CredentialEvent, CredentialRow } from './types';

export interface RegistryOpts {
  url?: string;
  serviceRoleKey?: string;
  rest?: RestClient;
}

export interface CredentialRegistry {
  /** Lookup by exact canonical name (DB `canonical_name` column or `name` for historical). */
  findByName(name: string): Promise<CredentialRow | null>;
  /** Lookup by canonical key (scope + vendor + purpose + env). */
  findByCanonicalKey(key: CanonicalKey): Promise<CredentialRow | null>;
  /** All rows for a vendor (case-insensitive). Used by the reuse-first resolver. */
  listByVendor(vendor: string): Promise<CredentialRow[]>;
  /** Fetch all credentials (paginated up to 1000). */
  listAll(): Promise<CredentialRow[]>;
  /** Insert a brand-new credential row. */
  insert(row: Partial<CredentialRow>): Promise<CredentialRow>;
  /** Partial update. */
  update(id: string, patch: Partial<CredentialRow>): Promise<CredentialRow>;
  /** Append a credential_events row. Best-effort — never throws. */
  insertEvent(evt: CredentialEvent): Promise<boolean>;
  /** Count autonomous events today (for rate-limit checks). */
  countAutonomousActionsToday(opts?: { vendor?: string; actor?: string }): Promise<number>;
}

export function createRegistry(opts: RegistryOpts = {}): CredentialRegistry {
  const rest = opts.rest ?? createRestClient({ url: opts.url, serviceRoleKey: opts.serviceRoleKey });

  async function rawSelect(path: string): Promise<unknown> {
    const res = await rest.request('GET', path);
    if (!res.ok) throw new Error(`registry SELECT failed: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }

  return {
    async findByName(name: string): Promise<CredentialRow | null> {
      const rows = (await rawSelect(
        `/rest/v1/credentials?or=(canonical_name.eq.${encodeURIComponent(name)},name.eq.${encodeURIComponent(name)})&select=*&limit=1`,
      )) as CredentialRow[];
      return rows[0] ?? null;
    },

    async findByCanonicalKey(key: CanonicalKey): Promise<CredentialRow | null> {
      // Use the canonical_name as the indexed key; fall back to the
      // composite (scope,vendor,purpose,env) for old rows that pre-date
      // the v2 schema.
      const expected = `${key.scope}_${key.vendor}_${key.purpose}${key.env ? '_' + key.env : ''}`;
      const byName = await this.findByName(expected);
      if (byName) return byName;
      const filters: string[] = [
        `scope=eq.${encodeURIComponent(key.scope)}`,
        `vendor=eq.${encodeURIComponent(key.vendor.toLowerCase())}`,
        `purpose=eq.${encodeURIComponent(key.purpose)}`,
      ];
      if (key.env) filters.push(`env=eq.${encodeURIComponent(key.env)}`);
      else filters.push(`env=is.null`);
      const rows = (await rawSelect(
        `/rest/v1/credentials?${filters.join('&')}&select=*&limit=1`,
      )) as CredentialRow[];
      return rows[0] ?? null;
    },

    async listByVendor(vendor: string): Promise<CredentialRow[]> {
      // `ilike` with no wildcards = case-insensitive exact match (vendor is stored
      // lowercase, but callers pass 'GCP'/'gcp' interchangeably).
      return (await rawSelect(
        `/rest/v1/credentials?vendor=ilike.${encodeURIComponent(vendor)}&select=*&order=name.asc&limit=200`,
      )) as CredentialRow[];
    },

    async listAll(): Promise<CredentialRow[]> {
      return (await rawSelect('/rest/v1/credentials?select=*&order=name.asc&limit=1000')) as CredentialRow[];
    },

    async insert(row: Partial<CredentialRow>): Promise<CredentialRow> {
      const res = await rest.request('POST', '/rest/v1/credentials', [row]);
      if (!res.ok) {
        throw new Error(`registry INSERT failed: HTTP ${res.status} ${await res.text()}`);
      }
      // PostgREST with Prefer:return=minimal returns no body; re-fetch by name.
      const inserted = await this.findByName(row.canonical_name || row.name || '');
      if (!inserted) throw new Error('registry INSERT succeeded but re-fetch returned nothing');
      return inserted;
    },

    async update(id: string, patch: Partial<CredentialRow>): Promise<CredentialRow> {
      const res = await rest.request('PATCH', `/rest/v1/credentials?id=eq.${id}`, patch);
      if (!res.ok) throw new Error(`registry UPDATE failed: HTTP ${res.status} ${await res.text()}`);
      const rows = (await rawSelect(`/rest/v1/credentials?id=eq.${id}&select=*&limit=1`)) as CredentialRow[];
      if (!rows[0]) throw new Error(`registry UPDATE succeeded but re-fetch returned nothing for id=${id}`);
      return rows[0];
    },

    async insertEvent(evt: CredentialEvent): Promise<boolean> {
      try {
        const body: Record<string, unknown> = {
          credential_name: evt.credential_name,
          event_type: evt.event_type,
          actor: evt.actor,
          result: evt.result,
          details: evt.details,
        };
        if (evt.credential_id) body.credential_id = evt.credential_id;
        const res = await rest.request('POST', '/rest/v1/credential_events', body);
        return res.ok;
      } catch {
        // never throw — audit failures must not break the primary path
        return false;
      }
    },

    async countAutonomousActionsToday(opts: { vendor?: string; actor?: string } = {}): Promise<number> {
      const sinceIso = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
      const filters: string[] = [
        `occurred_at=gte.${encodeURIComponent(sinceIso)}`,
        `event_type=in.(created,rotated,deprecated,flagged)`,
      ];
      if (opts.actor) filters.push(`actor=eq.${encodeURIComponent(opts.actor)}`);
      else filters.push(`actor=like.*steward*`);
      const res = await rest.request('GET', `/rest/v1/credential_events?${filters.join('&')}&select=id`);
      if (!res.ok) return 0;
      const rows = (await res.json()) as Array<unknown>;
      // If vendor filter requested, we'd need a join — instead filter client-side
      // via name lookup. For v1 we just return the unfiltered count; vendor-specific
      // counts can be done by passing actor='credential-steward-daily-<vendor>' style.
      return rows.length;
    },
  };
}
