// src/moviebox.ts
// MovieBox Mobile API client for Cloudflare Workers.
// Handles host pool fallback, request signing, auth token bootstrap, and all
// endpoint calls.
//
// ─── 2026-06-29 fix ──────────────────────────────────────────────────────────
// fetchWithHostPool now attaches an `Authorization: Bearer {token}` header to
// every request, sourced from signing.ts's KV-backed cache. This was the
// missing piece causing uniform 440/530 rejections across all 7 hosts — the
// HMAC signing itself was always correct, but MovieBox now also requires a
// bearer token obtained via a one-time bootstrap call. See signing.ts for
// the full bootstrap flow and rationale.

import {
  generateClientToken,
  generateSignature,
  getCachedAuthToken,
  bootstrapAuthToken,
  invalidateAuthToken,
  type SigningEnv,
} from './signing.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];

const VERSION_CODE = 50020044;
const VERSION_NAME = '3.0.03.0529.03';
const ANDROID_VERSION = '13';
const ANDROID_BUILD = 'TQ2A.230405.003';
const DEVICE_MODEL = '23078RKD5C';
const DEVICE_BRAND = 'Redmi';

const USER_AGENT =
  `com.community.oneroom/${VERSION_CODE} ` +
  `(Linux; U; Android ${ANDROID_VERSION}; en_US; ` +
  `${DEVICE_MODEL}; Build/${ANDROID_BUILD}; Cronet/135.0.7012.3)`;

// ─── Paths ────────────────────────────────────────────────────────────────────

export const PATHS = {
  search:     '/wefeed-mobile-bff/subject-api/search',
  get:        '/wefeed-mobile-bff/subject-api/get',
  seasonInfo: '/wefeed-mobile-bff/subject-api/season-info',
  resource:   '/wefeed-mobile-bff/subject-api/resource',
  captions:   '/wefeed-mobile-bff/subject-api/get-ext-captions',
  // Lightweight bootstrap target — any signed GET works, this is the
  // smallest/cheapest one. Not used for actual homepage data (that's H5).
  tabOperating: '/wefeed-mobile-bff/tab-operating',
};

// ─── Client identity ──────────────────────────────────────────────────────────
// Generated inside request handlers only — Cloudflare Workers forbid crypto
// calls (getRandomValues, randomUUID) in the global/module scope.

function makeClientInfo(customDeviceId?: string, customGaid?: string): string {
  const deviceId = customDeviceId || Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const gaid = customGaid || crypto.randomUUID();

  return JSON.stringify({
    package_name:    'com.community.oneroom',
    version_name:    VERSION_NAME,
    version_code:    VERSION_CODE,
    os:              'android',
    os_version:      ANDROID_VERSION,
    install_ch:      'ps',
    device_id:       deviceId,
    install_store:   'ps',
    gaid,
    brand:           DEVICE_BRAND,
    model:           DEVICE_MODEL,
    system_language: 'en',
    net:             'NETWORK_WIFI',
    region:          'US',
    timezone:        'America/New_York',
    sp_code:         '40401',
    'X-Play-Mode':   '2',
  });
}

// Lazily cached per isolate lifetime — set on first request, reused after.
// Never called at module load time so global scope restriction is not triggered.
let _clientInfo: string | null = null;
function getClientInfo(deviceId?: string, gaid?: string): string {
  if (deviceId && gaid) {
    return makeClientInfo(deviceId, gaid);
  }
  if (!_clientInfo) _clientInfo = makeClientInfo();
  return _clientInfo;
}

// ─── Signed headers builder ───────────────────────────────────────────────────

async function buildHeaders(
  method: string,
  url: string,
  body: string | null = null,
  authToken: string | null = null,
  deviceId?: string,
  gaid?: string
): Promise<Record<string, string>> {
  const accept = 'application/json';
  const contentType = body !== null ? 'application/json; charset=utf-8' : 'application/json';
  const ts = Date.now();

  const [token, signature] = await Promise.all([
    generateClientToken(ts),
    generateSignature(method, accept, contentType, url, body, ts),
  ]);

  const headers: Record<string, string> = {
    'User-Agent':      USER_AGENT,
    'Accept':          accept,
    'Content-Type':    contentType,
    'Connection':      'keep-alive',
    'X-Client-Token':  token,
    'x-tr-signature':  signature,
    'X-Client-Info':   getClientInfo(deviceId, gaid),
    'X-Client-Status': '0',
    'X-Play-Mode':     '2',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return headers;
}

// ─── Raw, single-attempt host-pool fetch ──────────────────────────────────────
// Tries each host in order with the given auth token attached, returning the
// first successful response along with the x-user header (if present) so the
// caller can absorb a fresh/rotated token.

interface HostPoolAttemptResult<T> {
  data: T | null;
  freshXUserToken: string | null;
  /** True if every host rejected specifically due to auth (401/403, or an
   *  API-level "invalid token" style code) rather than other errors — signals
   *  the caller should bootstrap a new token and retry once. */
  authFailure: boolean;
}

function extractXUserToken(response: Response): string | null {
  const xUser = response.headers.get('x-user');
  if (!xUser) return null;
  try {
    const payload = JSON.parse(xUser) as { token?: string };
    return payload.token ?? null;
  } catch {
    return null;
  }
}

async function attemptHostPool<T>(
  env: SigningEnv,
  path: string,
  method: 'GET' | 'POST',
  params: Record<string, string | number> | undefined,
  bodyStr: string | null,
  authToken: string | null,
  nigeriaIp?: string,
  deviceId?: string,
  gaid?: string
): Promise<HostPoolAttemptResult<T>> {
  let freshXUserToken: string | null = null;
  let sawAuthFailure = false;
  let sawAnyResponse = false;

  for (const base of HOST_POOL) {
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const urlStr = url.toString();
    const headers = await buildHeaders(method, urlStr, bodyStr, authToken, deviceId, gaid);
    if (nigeriaIp && !(env as any).fetch) {
      headers['X-Forwarded-For'] = nigeriaIp;
    }
    console.log(`[MovieBox Outgoing] URL: ${urlStr}`);
    console.log(`[MovieBox Outgoing] Headers:`, JSON.stringify(headers));

    try {
      const activeFetch = (env as any).fetch || fetch;
      const response = await activeFetch(urlStr, {
        method,
        headers: {
          ...headers,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
        body: bodyStr ?? undefined,
        signal: AbortSignal.timeout(12000),
        cache: 'no-store',
      } as any);

      sawAnyResponse = true;

      const xUserToken = extractXUserToken(response);
      if (xUserToken) freshXUserToken = xUserToken;

      if (response.status === 401 || response.status === 403) {
        console.warn(`[MovieBox] Host ${base} returned ${response.status} (auth) — trying next`);
        sawAuthFailure = true;
        continue;
      }

      if (!response.ok) {
        console.warn(`[MovieBox] Host ${base} returned ${response.status} — trying next`);
        continue;
      }

      const data = await response.json() as { code: number; message?: string; data?: T };

      if (data.code === 0) {
        return { data: (data.data ?? null) as T | null, freshXUserToken, authFailure: false };
      }

      console.warn(`[MovieBox] Host ${base} returned API code ${data.code}: ${data.message ?? ''} — trying next`);
      if (data.message && /token|auth/i.test(data.message)) {
        sawAuthFailure = true;
      }
    } catch (err) {
      console.warn(`[MovieBox] Host ${base} failed: ${err} — trying next`);
    }
  }

  console.error(`[MovieBox] All ${HOST_POOL.length} hosts exhausted for ${path}`);
  return {
    data: null,
    freshXUserToken,
    // Only treat as a pure auth failure if we got real responses back (not
    // just transport errors/timeouts) and at least one of them looked like
    // an auth rejection — otherwise this is a genuine host outage, and
    // retrying with a new token won't help.
    authFailure: sawAnyResponse && sawAuthFailure,
  };
}

// ─── Public host pool fetcher (auth-aware) ────────────────────────────────────
// Tries each host in order, returning the first successful response.
// Hosts are mirrors — they all serve the same data — so the first working
// host is sufficient. Firing all hosts simultaneously wastes quota and can
// trigger rate-limits on the upstream API.
//
// Handles the full auth lifecycle: reuses a cached token if we have one,
// bootstraps a fresh one if we don't, retries once if every host rejected
// for auth reasons, and absorbs any rotated token MovieBox hands back via
// the x-user response header so future calls stay current without an extra
// bootstrap round-trip.

export async function fetchWithHostPool<T>(
  env: SigningEnv,
  path: string,
  method: 'GET' | 'POST',
  params?: Record<string, string | number>,
  body?: Record<string, unknown>
): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : null;
  const cached = await getCachedAuthToken(env);
  const nigeriaIp = cached?.bootstrapIp || (env as any).NIGERIA_IP || '197.210.65.1';
  let authToken = cached?.token ?? null;
  let deviceId = cached?.deviceId ?? undefined;
  let gaid = cached?.gaid ?? undefined;

  if (!authToken) {
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    gaid = crypto.randomUUID();

    try {
      const finalDeviceId = deviceId;
      const finalGaid = gaid;
      authToken = await bootstrapAuthToken(env, finalDeviceId, finalGaid, async () => {
        const result = await attemptHostPool<unknown>(
          env,
          PATHS.tabOperating,
          'GET',
          { page: 1, tabId: 0, version: '' },
          null,
          null,
          nigeriaIp,
          finalDeviceId,
          finalGaid
        );
        return result.freshXUserToken;
      });
    } catch (e) {
      console.error(`[MovieBox] Auth bootstrap failed: ${e}`);
      return null;
    }
  }

  let result = await attemptHostPool<T>(env, path, method, params, bodyStr, authToken, nigeriaIp, deviceId, gaid);

  // Absorb any rotated token immediately, regardless of whether this
  // particular call succeeded — keeps the cache current for next time.
  if (result.freshXUserToken && result.freshXUserToken !== authToken) {
    const finalDeviceId = deviceId || '';
    const finalGaid = gaid || '';
    await bootstrapAuthToken(env, finalDeviceId, finalGaid, async () => result.freshXUserToken).catch(() => {});
  }

  if (result.data !== null) {
    return result.data;
  }

  if (result.authFailure) {
    console.warn(`[MovieBox] Auth failure on ${path} — invalidating token and retrying once`);
    await invalidateAuthToken(env);

    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    gaid = crypto.randomUUID();

    try {
      const finalDeviceId = deviceId;
      const finalGaid = gaid;
      authToken = await bootstrapAuthToken(env, finalDeviceId, finalGaid, async () => {
        const bootstrapResult = await attemptHostPool<unknown>(
          env,
          PATHS.tabOperating,
          'GET',
          { page: 1, tabId: 0, version: '' },
          null,
          null,
          nigeriaIp,
          finalDeviceId,
          finalGaid
        );
        return bootstrapResult.freshXUserToken;
      });
    } catch (e) {
      console.error(`[MovieBox] Re-bootstrap after auth failure failed: ${e}`);
      return null;
    }

    result = await attemptHostPool<T>(env, path, method, params, bodyStr, authToken, nigeriaIp, deviceId, gaid);
    return result.data;
  }

  return null;
}

// ─── Raw API response shapes ──────────────────────────────────────────────────

export interface MBSearchItem {
  subjectId:        string;
  subjectType:      number;
  title:            string;
  description?:     string;
  releaseDate?:     string;
  duration?:        string;
  genre?:           string;
  cover?:           { url: string; thumbnail?: string };
  countryName?:     string;
  imdbRatingValue?: string;
  language?:        string;
}

export interface MBSearchData {
  pager: { hasMore: boolean; nextPage: string; page: string; perPage: number; totalCount: number };
  items: MBSearchItem[];
}

export interface MBDetailData {
  // Response is flat — all fields at top level, no subject wrapper
  subjectId:        string;
  subjectType:      number;
  title:            string;
  description?:     string;
  releaseDate?:     string;
  duration?:        number | string;  // "2h 42m" string or seconds number
  genre?:           string;
  cover?:           { url: string };
  countryName?:     string;
  imdbRatingValue?: string;
  hasResource?:     boolean;
  language?:        string;
  staffList?:       Array<{ name: string; role: string; avatar?: { url?: string } }>;
}

export interface MBSeasonData {
  subjectId?:  string;
  subjectType?: number;
  // Season number → se, episode count → maxEp, resolutions show per-quality ep counts
  seasons?: Array<{
    se:           number;
    maxEp:        number;
    allEp?:       string;
    resolutions?: Array<{ resolution: number; epNum: number }>;
  }>;
}

export interface MBResourceItem {
  episode:            number;
  title:              string;
  resourceLink:       string;
  linkType:           number;
  size?:              string;
  resourceId:         string;
  resolution:         number;
  codecName?:         string;
  duration?:          number;
  requireMemberType?: number;
  extCaptions?:       Array<{ lan: string; lanName?: string; url: string }>;
  se:                 number;
  ep:                 number;
}

export interface MBResourceData {
  pager: { hasMore: boolean; totalCount: number; nextPage?: string; page?: string; perPage?: number };
  list:  MBResourceItem[];
}
