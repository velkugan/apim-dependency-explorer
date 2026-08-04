import { Pool, sleep } from './util.js';

export const ARM_ENDPOINT = 'https://management.azure.com';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ArmError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ArmError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Thin ARM wrapper.
 *
 * Fetches run from the side panel page. Chrome grants extension pages the
 * host permissions declared in the manifest, so management.azure.com is
 * reachable without a CORS preflight dance.
 */
export class ArmClient {
  constructor({ getToken, concurrency = 4 } = {}) {
    this.getToken = getToken;
    this.pool = new Pool(concurrency);
    this.cache = new Map();
    this.stats = { requests: 0, cacheHits: 0, throttled: 0 };
  }

  clearCache() {
    this.cache.clear();
  }

  buildUrl(path, params = {}, apiVersion) {
    const url = new URL(path.startsWith('http') ? path : ARM_ENDPOINT + path);
    if (apiVersion && !url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', apiVersion);
    }
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /**
   * @returns parsed JSON, or null on 404 (a missing policy is normal, not an error)
   */
  async request(path, opts = {}) {
    const {
      apiVersion,
      params,
      method = 'GET',
      body,
      cache = method === 'GET',
      tolerate404 = true
    } = opts;

    const url = this.buildUrl(path, params, apiVersion);
    const key = `${method} ${url}`;

    if (cache && this.cache.has(key)) {
      this.stats.cacheHits++;
      return this.cache.get(key);
    }

    const exec = async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const token = await this.getToken();
        if (!token) throw new AuthError('No bearer token. Paste one in the panel first.');

        let res;
        try {
          this.stats.requests++;
          res = await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined
          });
        } catch (err) {
          throw new ArmError(`Network error calling ARM: ${err.message}`, 0);
        }

        if (res.status === 401) {
          throw new AuthError('ARM rejected the token (401). It has expired or is for the wrong audience.');
        }
        if (res.status === 403) {
          throw new AuthError('ARM returned 403. The signed-in identity lacks read access on this resource.');
        }
        if (res.status === 404 && tolerate404) return null;
        if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
          this.stats.throttled++;
          const retryAfter = Number(res.headers.get('Retry-After')) || Math.min(2 ** attempt, 20);
          await sleep(retryAfter * 1000);
          continue;
        }

        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON body */
        }

        if (!res.ok) {
          const code = json?.error?.code || String(res.status);
          const message = json?.error?.message || text?.slice(0, 300) || res.statusText;
          throw new ArmError(message, res.status, code);
        }
        return json;
      }
    };

    const promise = this.pool.run(exec);
    if (cache) this.cache.set(key, promise);
    try {
      return await promise;
    } catch (err) {
      if (cache) this.cache.delete(key);
      throw err;
    }
  }

  /** Follows nextLink and returns the flattened value array. */
  async list(path, opts = {}) {
    const out = [];
    let page = await this.request(path, opts);
    let guard = 0;
    while (page && guard++ < 200) {
      if (Array.isArray(page.value)) out.push(...page.value);
      else if (page.id) out.push(page);
      if (!page.nextLink) break;
      page = await this.request(page.nextLink, { ...opts, params: undefined, apiVersion: undefined });
    }
    return out;
  }
}
