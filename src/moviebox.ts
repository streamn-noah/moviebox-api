// src/moviebox.ts
// MovieBox H5 Web API client for Cloudflare Workers.
//
// REPLACES the old Android mobile-app client (HMAC-signed, 7-host pool).
// As of testing on 2026-06-27, every host in that pool uniformly rejects
// requests with HTTP 440/530 — MovieBox appears to have broken or rotated
// something in that signing scheme upstream. The H5 web API (used here)
// is a separate, working pool that needs no signing at all — just a
// bootstrapped session token (see h5session.ts) and a couple of headers.
//
// Confirmed working during testing:
//   - search           -> h5-api.aoneroom.com/wefeed-h5api-bff/subject/search
//   - stream/download   -> h5.aoneroom.com/wefeed-h5-bff/web/subject/download
//   - info/season       -> h5.aoneroom.com/movies/{detailPath}?id={subjectId}
//                          (HTML page, data extracted via nuxtExtract.ts)
//
// NOTE: the stream/download endpoint is STRICTLY single-episode — passing
// se=0&ep=0 on a TV series subjectId returns hasResource:false, confirmed
// by direct test. There is no upstream bulk mode. /stream/:id/all therefore
// still works the same way it always did: the worker loops over episodes
// itself and aggregates the results.

import { getAuthHeaders, invalidateSession } from './h5session.js';
import { getInfoFromHtml, type MBNuxtPageData } from './nuxtExtract.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SEARCH_URL = 'https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search';
const DOWNLOAD_URL = 'https://h5.aoneroom.com/wefeed-h5-bff/web/subject/download';
const MOVIE_PAGE_BASE = 'https://h5.aoneroom.com/movies';

const REQUEST_TIMEOUT_MS = 12000;

// ─── Raw API response shapes (H5) ─────────────────────────────────────────────

export interface MBSearchItem {
  subjectId: string;
  subjectType: number;
  title: string;
  description?: string;
  releaseDate?: string;
  duration?: number;
  genre?: string;
  cover?: { url: string; thumbnail?: string };
  countryName?: string;
  imdbRatingValue?: string;
  language?: string;
  detailPath?: string;
  hasResource?: boolean;
  subtitles?: string;
}

export interface MBSearchData {
  pager: { hasMore: boolean; nextPage: string; page: string; perPage: number; totalCount: number };
  items: MBSearchItem[];
}

export interface MBCaption {
  id: string;
  lan: string;
  lanName: string;
  url: string;
  size?: string;
  delay?: number;
}

export interface MBDownloadItem {
  id: string;
  url: string;
  resolution: number;
  size?: string;
}

export interface MBDownloadData {
  downloads: MBDownloadItem[];
  captions: MBCaption[];
  limited: boolean;
  limitedCode?: string;
  freeNum?: number;
  hasResource: boolean;
}

// ─── Generic authenticated H5 fetch helper ───────────────────────────────────
// One retry on auth failure: if the upstream rejects our token (e.g. it was
// revoked server-side before our locally-decoded expiry would suggest),
// we invalidate the cached session and retry once with a fresh bootstrap
// rather than failing the whole request outright.

async function fetchH5Json<T>(
  url: string,
  options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; referer?: string } = {}
): Promise<T | null> {
  const { method = 'GET', body, referer } = options;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const authHeaders = await getAuthHeaders();
      const headers: Record<string, string> = { ...authHeaders };
      if (referer) headers['Referer'] = referer;

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`[MovieBox H5] ${url} returned HTTP ${response.status}`);
        if (response.status === 401 || response.status === 403) {
          invalidateSession();
          continue; // retry once with a fresh session
        }
        return null;
      }

      const json = (await response.json()) as { code: number; message?: string; data?: T };

      if (json.code !== 0) {
        console.warn(`[MovieBox H5] ${url} returned API code ${json.code}: ${json.message}`);
        // "invalid token" style errors come back as code !== 0, not HTTP 4xx,
        // so we check the message too before giving up on this attempt.
        if (json.message && /token/i.test(json.message)) {
          invalidateSession();
          continue;
        }
        return null;
      }

      return (json.data ?? null) as T | null;
    } catch (err) {
      console.warn(`[MovieBox H5] ${url} request failed: ${err}`);
      return null;
    }
  }

  console.error(`[MovieBox H5] ${url} failed after retry with fresh session`);
  return null;
}

// ─── Public client functions ──────────────────────────────────────────────────

export async function searchMovieBox(
  keyword: string,
  page: number,
  perPage: number
): Promise<MBSearchData | null> {
  return fetchH5Json<MBSearchData>(SEARCH_URL, {
    method: 'POST',
    body: { keyword, page, perPage, subjectType: 0 },
  });
}

/**
 * Fetches stream/download URLs + captions for a single episode (or a movie,
 * using se=0&ep=0). This single upstream call backs all three of the
 * worker's /stream, /stream/:id/all (looped), and /download routes.
 */
export async function getDownload(
  subjectId: string,
  se: number,
  ep: number,
  detailPath: string
): Promise<MBDownloadData | null> {
  const url = `${DOWNLOAD_URL}?subjectId=${encodeURIComponent(subjectId)}&se=${se}&ep=${ep}`;
  const referer = `${MOVIE_PAGE_BASE}/${detailPath}`;
  return fetchH5Json<MBDownloadData>(url, { referer });
}

/**
 * Fetches and extracts the full detail-page payload (subject info, seasons,
 * cast) for a subject by scraping its H5 detail page's embedded Nuxt state.
 * Unlike the other H5 calls, this isn't a JSON API endpoint — it parses real
 * HTML — so failures here are reported with more context than a flat null.
 */
export async function getSubjectPageData(
  subjectId: string,
  detailPath: string
): Promise<MBNuxtPageData | null> {
  const url = `${MOVIE_PAGE_BASE}/${detailPath}?id=${encodeURIComponent(subjectId)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`[MovieBox H5] Page fetch ${url} returned HTTP ${response.status}`);
        if (response.status === 401 || response.status === 403) {
          invalidateSession();
          continue;
        }
        return null;
      }

      const html = await response.text();
      return getInfoFromHtml(html);
    } catch (err) {
      console.warn(`[MovieBox H5] Page fetch/extraction failed for ${url}: ${err}`);
      return null;
    }
  }

  console.error(`[MovieBox H5] Page fetch failed after retry for ${url}`);
  return null;
}
