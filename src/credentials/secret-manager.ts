/**
 * GCP Secret Manager REST helpers.
 *
 * Uses the metadata server for auth when running on Cloud Run; falls
 * back to METADATA_SERVER_OVERRIDE_TOKEN env var for local dev.
 *
 * Never logs secret VALUES. Secret names are logged at info level.
 */

export interface SmClientOpts {
  /** GCP project id. Default: env GCP_PROJECT or 'watney-workflows'. */
  project?: string;
  /**
   * Optional pre-fetched access token; used in tests/local dev.
   * In production, omit and the client will fetch from the metadata server.
   */
  accessToken?: string;
}

export interface SmClient {
  list(): Promise<string[]>;
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<string>;
  /** Creates a new SM secret with the given value. Returns the resource name. */
  create(name: string, value: string, opts?: { labels?: Record<string, string> }): Promise<{ resourceName: string; version: number }>;
  /** Adds a new version to an existing SM secret. */
  addVersion(name: string, value: string): Promise<{ version: number }>;
  /** Disables a specific version of a secret. The value remains for forensic retention. */
  disableVersion(name: string, version: number): Promise<boolean>;
  /** Destroys (irrevocably) a specific version. Use sparingly — prefer disable. */
  destroyVersion(name: string, version: number): Promise<boolean>;
  /** Returns the latest version number. */
  latestVersion(name: string): Promise<number>;
}

interface TokenCache { token: string; expiresAt: number }

export function createSmClient(opts: SmClientOpts = {}): SmClient {
  const project = opts.project ?? process.env.GCP_PROJECT ?? 'watney-workflows';
  let cache: TokenCache | null = opts.accessToken
    ? { token: opts.accessToken, expiresAt: Date.now() + 60 * 60 * 1000 }
    : null;

  async function getToken(): Promise<string> {
    const override = process.env.METADATA_SERVER_OVERRIDE_TOKEN;
    if (override) return override;
    const nowMs = Date.now();
    if (cache && cache.expiresAt - 60_000 > nowMs) return cache.token;
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!res.ok) throw new Error(`SM metadata token fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cache = { token: json.access_token, expiresAt: nowMs + json.expires_in * 1000 };
    return json.access_token;
  }

  async function smFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }

  return {
    async list(): Promise<string[]> {
      const names: string[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets`);
        url.searchParams.set('pageSize', '500');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const res = await smFetch(url.toString());
        if (!res.ok) throw new Error(`SM list failed: HTTP ${res.status} ${await res.text()}`);
        const json = (await res.json()) as { secrets?: Array<{ name: string }>; nextPageToken?: string };
        for (const s of json.secrets ?? []) {
          const leaf = s.name.split('/').pop();
          if (leaf) names.push(leaf);
        }
        pageToken = json.nextPageToken;
      } while (pageToken);
      return names.sort();
    },

    async exists(name: string): Promise<boolean> {
      const res = await smFetch(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}`,
      );
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`SM exists check failed: HTTP ${res.status}`);
      return true;
    },

    async read(name: string): Promise<string> {
      const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}/versions/latest:access`;
      const res = await smFetch(url);
      if (!res.ok) throw new Error(`SM read failed: HTTP ${res.status}`);
      const json = (await res.json()) as { payload?: { data?: string } };
      if (!json.payload?.data) throw new Error('SM read returned no payload');
      const raw = Buffer.from(json.payload.data, 'base64').toString('utf8');
      // Strip UTF-8 BOM + trailing whitespace (see feedback_secret_bom.md)
      return raw.replace(/^﻿/, '').replace(/[\r\n]+$/, '');
    },

    async create(name, value, opts = {}): Promise<{ resourceName: string; version: number }> {
      // Step 1: create the secret container
      const createUrl = new URL(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets`);
      createUrl.searchParams.set('secretId', name);
      const body: Record<string, unknown> = {
        replication: { automatic: {} },
      };
      if (opts.labels) body.labels = opts.labels;
      const createRes = await smFetch(createUrl.toString(), {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!createRes.ok && createRes.status !== 409) {
        const text = await createRes.text();
        throw new Error(`SM create failed: HTTP ${createRes.status} ${text}`);
      }
      // Step 2: add the first version with the value
      const addRes = await smFetch(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}:addVersion`,
        {
          method: 'POST',
          body: JSON.stringify({
            payload: { data: Buffer.from(value, 'utf8').toString('base64') },
          }),
        },
      );
      if (!addRes.ok) {
        const text = await addRes.text();
        throw new Error(`SM addVersion failed: HTTP ${addRes.status} ${text}`);
      }
      const addJson = (await addRes.json()) as { name: string };
      // addJson.name format: projects/<num>/secrets/<name>/versions/<n>
      const version = parseInt(addJson.name.split('/').pop() ?? '1', 10);
      return { resourceName: `projects/${project}/secrets/${name}`, version };
    },

    async addVersion(name, value): Promise<{ version: number }> {
      const res = await smFetch(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}:addVersion`,
        {
          method: 'POST',
          body: JSON.stringify({
            payload: { data: Buffer.from(value, 'utf8').toString('base64') },
          }),
        },
      );
      if (!res.ok) throw new Error(`SM addVersion failed: HTTP ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { name: string };
      const version = parseInt(json.name.split('/').pop() ?? '0', 10);
      return { version };
    },

    async disableVersion(name, version): Promise<boolean> {
      const res = await smFetch(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}/versions/${version}:disable`,
        { method: 'POST', body: '{}' },
      );
      return res.ok;
    },

    async destroyVersion(name, version): Promise<boolean> {
      const res = await smFetch(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}/versions/${version}:destroy`,
        { method: 'POST', body: '{}' },
      );
      return res.ok;
    },

    async latestVersion(name): Promise<number> {
      const res = await smFetch(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${encodeURIComponent(name)}/versions/latest`,
      );
      if (!res.ok) throw new Error(`SM latestVersion failed: HTTP ${res.status}`);
      const json = (await res.json()) as { name: string };
      return parseInt(json.name.split('/').pop() ?? '0', 10);
    },
  };
}
