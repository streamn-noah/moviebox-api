// src/moviebox.ts
// MovieBox Mobile API client for Cloudflare Workers.
// Handles host pool fallback, request signing, and all endpoint calls.

import { generateClientToken, generateSignature } from './signing.js';

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
};

// ─── Client identity ──────────────────────────────────────────────────────────
// Generated inside request handlers only — Cloudflare Workers forbid crypto
// calls (getRandomValues, randomUUID) in the global/module scope.

function makeClientInfo(): string {
  const deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const gaid = crypto.randomUUID();

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
function getClientInfo(): string {
  if (!_clientInfo) _clientInfo = makeClientInfo();
  return _clientInfo;
}

// ─── Signed headers builder ───────────────────────────────────────────────────

async function buildHeaders(
  method: string,
  url: string,
  body: string | null = null
): Promise<Record<string, string>> {
  const accept = 'application/json';
  const contentType = body !== null ? 'application/json; charset=utf-8' : 'application/json';
  const ts = Date.now();

  const [token, signature] = await Promise.all([
    generateClientToken(ts),
    generateSignature(method, accept, contentType, url, body, ts),
  ]);

  return {
    'User-Agent':      USER_AGENT,
    'Accept':          accept,
    'Content-Type':    contentType,
    'Connection':      'keep-alive',
    'X-Client-Token':  token,
    'x-tr-signature':  signature,
    'X-Client-Info':   getClientInfo(),
    'X-Client-Status': '0',
    'X-Play-Mode':     '2',
  };
}

// ─── Host pool fetcher ────────────────────────────────────────────────────────

export async function fetchWithHostPool<T>(
  path: string,
  method: 'GET' | 'POST',
  params?: Record<string, string | number>,
  body?: Record<string, unknown>
): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : null;

  for (const base of HOST_POOL) {
    // Build URL with query params
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const urlStr = url.toString();
    const headers = await buildHeaders(method, urlStr, bodyStr);

    try {
      const response = await fetch(urlStr, {
        method,
        headers,
        body: bodyStr ?? undefined,
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        console.warn(`[MovieBox] Host ${base} returned ${response.status} — trying next`);
        continue;
      }

      const data = await response.json() as { code: number; data?: T };

      if (data.code === 0) {
        return data.data as T;
      }

      console.warn(`[MovieBox] Host ${base} returned API code ${data.code} — trying next`);
    } catch (err) {
      console.warn(`[MovieBox] Host ${base} failed: ${err} — trying next`);
    }
  }

  console.error(`[MovieBox] All ${HOST_POOL.length} hosts exhausted for ${path}`);
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
