// src/index.ts
// Spün MovieBox Worker — main entry point.
// Routes:
//   GET  /                             — API info & route listing (public)
//   GET  /health                       — health check (public)
//   POST /search                       — { keyword, page?, perPage? }
//   GET  /info/:subjectId?detailPath=  — subject detail
//   GET  /season/:subjectId?detailPath= — season/episode structure
//   GET  /stream/:subjectId?se=&ep=&detailPath=  — MP4 URLs for specific episode
//   GET  /stream/:subjectId/all?detailPath=      — all episodes with streams (shorts/series bulk)
//   GET  /download/:subjectId?detailPath=        — full pack grouped by season/episode
//   GET  /home                         — homepage rows + subjects (Africa feed)
//   GET  /home/rows                    — homepage row titles + opIds
//   GET  /home/subjects?opId=X         — subjects for a specific row
//
// All routes except / and /health require X-Worker-Secret header.
//
// ─── 2026-06-27 backend migration notes ──────────────────────────────────────
// The old Android mobile-app endpoints (7-host HMAC-signed pool) started
// uniformly failing with HTTP 440/530 across every host. Confirmed via
// `wrangler tail` during live testing — not a transient outage, every host
// rejected identically, consistent with MovieBox having broken or rotated
// something in that signing scheme upstream.
//
// /search, /info, /season, /stream, /stream/all, and /download have been
// rewritten to use the H5 web API instead (h5-api.aoneroom.com /
// h5.aoneroom.com), which needs no HMAC signing — just a bootstrapped
// session token (see h5session.ts). This was confirmed working end-to-end
// against real MovieBox data before this rewrite, including captions, which
// the H5 download endpoint now returns directly alongside stream URLs
// (previously sourced from the Android pool's get-ext-captions path).
//
// /info and /season now ALSO require knowing the subject's `detailPath`
// (e.g. "avatar-WLDIi21IUBa") because the H5 API has no JSON endpoint for
// subject details — it's extracted from the subject's actual detail PAGE,
// which is addressed by detailPath, not subjectId alone. Since existing
// consumers call these routes with only a subjectId, detailPath is an
// OPTIONAL query param: if omitted, the route returns a 400 with a clear
// explanation rather than silently failing, so existing integrations get
// an actionable error instead of mysterious breakage.
//
// /home, /home/rows, /home/subjects are UNCHANGED — they already used the
// H5 pool and were unaffected by the Android pool's failure.

import { searchMovieBox, getDownload, getSubjectPageData } from './moviebox.js';
import type { MBCaption, MBDownloadItem } from './moviebox.js';

// subjectType: 1=movie, 2=tv, 7=shorts — all others filtered out
const ALLOWED_SUBJECT_TYPES = new Set([1, 2, 7]);

function resolveSubjectType(subjectType: number): 'movie' | 'tv' | 'shorts' {
  if (subjectType === 2) return 'tv';
  if (subjectType === 7) return 'shorts';
  return 'movie';
}

export interface Env {
  MOVIEBOX_SECRET: string;
  // Nigerian IP for X-Forwarded-For — ensures the H5 upstream returns the full
  // Africa region feed (35 rows). Cloudflare edge IPs get a truncated feed (30 rows).
  // Set in wrangler.toml or Cloudflare dashboard. Falls back to a known MTN Nigeria IP.
  NIGERIA_IP?: string;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function detailPathRequiredError(): Response {
  return err(
    'detailPath query param is required for this route. MovieBox\'s web API ' +
    'has no JSON lookup for subject details by ID alone — detailPath ' +
    '(e.g. "avatar-WLDIi21IUBa") comes from the `detailPath` field already ' +
    'present on every item returned by /search and /home/subjects. ' +
    'Pass it as ?detailPath=... alongside the subjectId.',
    400
  );
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  const secret = request.headers.get('X-Worker-Secret');
  return !!secret && secret === env.MOVIEBOX_SECRET;
}

// ─── Caption mapping ──────────────────────────────────────────────────────────
// The H5 download endpoint returns captions directly as signed .srt URLs —
// no zip extraction, no SubDL needed for anything MovieBox already has.

function mapCaption(cap: MBCaption) {
  return {
    language: cap.lanName || cap.lan,
    language_code: cap.lan,
    url: cap.url,
  };
}

// ─── Download item mapping ────────────────────────────────────────────────────

function mapDownloadItem(item: MBDownloadItem) {
  const sizeMb = item.size
    ? `${Math.round(parseInt(item.size, 10) / (1024 * 1024))} MB`
    : null;

  return {
    quality: `${item.resolution}p`,
    resolution: item.resolution,
    url: item.url,
    format: 'mp4' as const,
    size: sizeMb,
  };
}

// ─── H5 homepage fetcher (UNCHANGED — already working, not part of this fix) ─

const H5_HOSTS = [
  'https://netnaija.film',
  'https://h5.aoneroom.com',
  'https://moviebox.pk',
];

const H5_HOME_PATH = '/wefeed-h5-bff/web/home';

interface H5Subject {
  subjectId: string;
  subjectType: number;
  title: string;
  description?: string;
  releaseDate?: string;
  duration?: number;
  genre?: string;
  cover?: { url?: string; thumbnail?: string };
  countryName?: string;
  imdbRatingValue?: string;
  hasResource?: boolean;
  language?: string;
  detailPath?: string;
}

interface H5Row {
  title: string;
  opId: string;
  type: string;
  subjects: H5Subject[];
}

interface H5HomeData {
  operatingList: H5Row[];
}

async function fetchH5Home(nigeriaIp?: string): Promise<H5HomeData | null> {
  const forwardedIp = nigeriaIp || '197.210.65.1';

  for (const base of H5_HOSTS) {
    try {
      const response = await fetch(`${base}${H5_HOME_PATH}`, {
        method: 'GET',
        headers: {
          'X-Client-Info': '{"timezone":"Africa/Lagos"}',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0',
          'Referer': `${base}/`,
          'X-Forwarded-For': forwardedIp,
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        console.warn(`[H5] Host ${base} returned ${response.status} — trying next`);
        continue;
      }

      const data = (await response.json()) as { code: number; data?: H5HomeData };

      if (data.code === 0 && data.data) {
        return data.data;
      }

      console.warn(`[H5] Host ${base} returned API code ${data.code} — trying next`);
    } catch (e) {
      console.warn(`[H5] Host ${base} failed: ${e} — trying next`);
    }
  }

  console.error('[H5] All hosts exhausted');
  return null;
}

function normalizeH5Subject(item: H5Subject) {
  const rawDuration = item.duration;
  const runtimeMinutes = rawDuration && rawDuration > 0 ? Math.round(rawDuration / 60) : null;

  return {
    subjectId: item.subjectId,
    subjectType: item.subjectType,
    type: resolveSubjectType(item.subjectType),
    title: item.title,
    description: item.description ?? '',
    releaseDate: item.releaseDate ?? null,
    runtime: runtimeMinutes,
    genre: item.genre ?? null,
    poster: item.cover?.url ?? null,
    thumbnail: item.cover?.thumbnail ?? '',
    country: item.countryName ?? null,
    rating: item.imdbRatingValue && item.imdbRatingValue !== '0'
      ? parseFloat(item.imdbRatingValue)
      : null,
    hasResource: item.hasResource ?? false,
    language: item.language ?? null,
    detailPath: item.detailPath ?? null,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleRoot(): Response {
  return json({
    name: 'Spün MovieBox API',
    description: 'An unofficial REST API built by Spün for MovieBox — wrapping the MovieBox H5 web API with session-based auth and structured responses.',
    version: '2.0.0',
    routes: [
      { method: 'GET', path: '/', auth: false, description: 'API info and route listing' },
      { method: 'GET', path: '/health', auth: false, description: 'Worker health check' },
      { method: 'POST', path: '/search', auth: true, description: 'Search for movies, TV shows, and shorts. Body: { keyword, page?, perPage? }' },
      { method: 'GET', path: '/info/:subjectId', auth: true, description: 'Get detail for a subject. Requires ?detailPath= query param (from search/home results).' },
      { method: 'GET', path: '/season/:subjectId', auth: true, description: 'Get season and episode structure for a TV show or shorts series. Requires ?detailPath=.' },
      { method: 'GET', path: '/stream/:subjectId', auth: true, description: 'Stream URLs for a specific episode. Params: se, ep, detailPath (required). Use se=0&ep=0 for movies.' },
      { method: 'GET', path: '/stream/:subjectId/all', auth: true, description: 'All stream URLs for all episodes grouped by episode. Requires ?detailPath=.' },
      { method: 'GET', path: '/download/:subjectId', auth: true, description: 'Full download pack grouped by season → episode → quality. Requires ?detailPath=.' },
      { method: 'GET', path: '/home', auth: true, description: 'MovieBox homepage rows with subjects (Africa/Lagos feed)' },
      { method: 'GET', path: '/home/rows', auth: true, description: 'All homepage row titles and opIds — use to discover rows before fetching subjects' },
      { method: 'GET', path: '/home/subjects?opId=X', auth: true, description: 'Subjects for a specific homepage row by opId' },
    ],
  });
}

async function handleSearch(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err('Invalid JSON body');
  }

  const keyword = body.keyword as string;
  if (!keyword?.trim()) return err('keyword is required');

  const page = Number(body.page ?? 1);
  const perPage = Number(body.perPage ?? 20);

  const data = await searchMovieBox(keyword, page, perPage);

  if (!data) return json({ items: [], pager: null });

  const items = (data.items || [])
    .filter((item) => ALLOWED_SUBJECT_TYPES.has(item.subjectType))
    .map((item) => ({
      subjectId: item.subjectId,
      subjectType: item.subjectType,
      title: item.title,
      description: item.description ?? '',
      releaseDate: item.releaseDate ?? null,
      duration: item.duration ?? null,
      genre: item.genre ?? null,
      poster: item.cover?.url ?? null,
      thumbnail: item.cover?.thumbnail ?? null,
      country: item.countryName ?? null,
      rating: item.imdbRatingValue && item.imdbRatingValue !== '0'
        ? parseFloat(item.imdbRatingValue)
        : null,
      language: item.language ?? null,
      type: resolveSubjectType(item.subjectType),
      // NEW field — needed by /info, /season, /stream, /download going
      // forward. Additive only; does not remove any existing field.
      detailPath: item.detailPath ?? null,
    }));

  return json({ items, pager: data.pager });
}

async function handleInfo(subjectId: string, detailPath: string | null): Promise<Response> {
  if (!detailPath) return detailPathRequiredError();

  const pageData = await getSubjectPageData(subjectId, detailPath);
  if (!pageData?.subject) return err('Not found', 404);

  const { subject, stars } = pageData;

  const rawDuration = subject.duration;
  const runtimeMinutes = typeof rawDuration === 'number' && rawDuration > 0
    ? Math.round(rawDuration / 60)
    : null;

  return json({
    subjectId: subject.subjectId,
    subjectType: subject.subjectType,
    type: resolveSubjectType(subject.subjectType),
    title: subject.title,
    description: subject.description ?? '',
    releaseDate: subject.releaseDate ?? null,
    runtime: runtimeMinutes,
    genre: subject.genre ?? null,
    poster: subject.cover?.url ?? null,
    country: subject.countryName ?? null,
    rating: subject.imdbRatingValue && subject.imdbRatingValue !== '0'
      ? parseFloat(subject.imdbRatingValue)
      : null,
    hasResource: subject.hasResource ?? false,
    // `language` was never populated on the old Android /info response either
    // (it's not a field MovieBox's detail data actually carries) — kept as
    // null here for response-shape compatibility with existing consumers.
    language: null,
    staff: (stars || []).map((s) => ({
      name: s.name,
      role: s.character ?? null,
      avatar: s.avatarUrl ?? null,
    })),
  });
}

async function handleSeason(subjectId: string, detailPath: string | null): Promise<Response> {
  if (!detailPath) return detailPathRequiredError();

  const pageData = await getSubjectPageData(subjectId, detailPath);
  if (!pageData?.resource?.seasons?.length) return json({ seasons: [] });

  return json({
    seasons: pageData.resource.seasons.map((s) => {
      const bestEpCount = s.resolutions?.length
        ? Math.max(...s.resolutions.map((r) => r.epNum))
        : s.maxEp;

      return {
        season: s.se,
        totalEpisode: s.maxEp,
        episodesAvailable: bestEpCount,
        resolutions: s.resolutions || [],
        episodes: Array.from({ length: s.maxEp }, (_, i) => ({
          episode: i + 1,
          title: null,
          releaseDate: null,
        })),
      };
    }),
  });
}

// GET /stream/:subjectId?se=X&ep=Y&detailPath=...
// Returns MP4 URLs (+ captions) for a specific episode.
// Use se=0&ep=0 for movies.

async function handleStream(
  subjectId: string,
  se: number,
  ep: number,
  detailPath: string | null
): Promise<Response> {
  if (!detailPath) return detailPathRequiredError();

  const data = await getDownload(subjectId, se, ep, detailPath);
  if (!data?.hasResource || !data.downloads?.length) {
    return err('No streams available', 404);
  }

  const streams = data.downloads.map(mapDownloadItem);
  const captions = (data.captions || []).map(mapCaption);

  return json({ streams, total: streams.length, captions });
}

// GET /stream/:subjectId/all?detailPath=...
// Loops over episodes and aggregates results — the H5 download endpoint is
// strictly single-episode (confirmed: se=0&ep=0 on a series returns
// hasResource:false), so "all" is built client-side in the worker, same
// approach as before, just hitting the new upstream per call.
//
// For movies, there's only one "episode" (se=0,ep=0). For series/shorts,
// season structure (from the same detail-page fetch) tells us how many
// episodes to loop over.

async function handleStreamAll(subjectId: string, detailPath: string | null): Promise<Response> {
  if (!detailPath) return detailPathRequiredError();

  const pageData = await getSubjectPageData(subjectId, detailPath);
  if (!pageData?.subject) return err('Not found', 404);

  const seasons = pageData.resource?.seasons ?? [];

  // Movie or no season structure — treat as a single se=0/ep=0 item.
  const episodeTargets: Array<{ se: number; ep: number }> = seasons.length
    ? seasons.flatMap((s) =>
        Array.from({ length: s.maxEp }, (_, i) => ({ se: s.se, ep: i + 1 }))
      )
    : [{ se: 0, ep: 0 }];

  // Safety cap — avoids pathological fan-out on a show with an extreme
  // episode count, matching the spirit of the old worker's page-count cap.
  const MAX_EPISODES = 1000;
  const targets = episodeTargets.slice(0, MAX_EPISODES);

  const seasonMap = new Map<number, Map<number, ReturnType<typeof mapDownloadItem>[]>>();
  const captionMap = new Map<number, Map<number, ReturnType<typeof mapCaption>[]>>();

  // Sequential, not parallel — avoids hammering the upstream with hundreds
  // of simultaneous requests for long series, and keeps us within Workers'
  // subrequest limits per invocation.
  for (const { se, ep } of targets) {
    const data = await getDownload(subjectId, se, ep, detailPath);
    if (!data?.hasResource || !data.downloads?.length) continue;

    if (!seasonMap.has(se)) seasonMap.set(se, new Map());
    if (!captionMap.has(se)) captionMap.set(se, new Map());

    seasonMap.get(se)!.set(ep, data.downloads.map(mapDownloadItem));
    captionMap.get(se)!.set(ep, (data.captions || []).map(mapCaption));
  }

  const result = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, streams]) => ({
          episode: epNum,
          streams,
          total: streams.length,
          captions: captionMap.get(seasonNum)?.get(epNum) ?? [],
        })),
    }));

  return json({ seasons: result, total_seasons: result.length });
}

// GET /download/:subjectId?detailPath=...
// Same underlying data as /stream/all, reshaped to qualities-per-episode
// grouping, matching the original response contract.

async function handleDownload(subjectId: string, detailPath: string | null): Promise<Response> {
  if (!detailPath) return detailPathRequiredError();

  const pageData = await getSubjectPageData(subjectId, detailPath);
  if (!pageData?.subject) return err('Not found', 404);

  const seasons = pageData.resource?.seasons ?? [];
  const episodeTargets: Array<{ se: number; ep: number }> = seasons.length
    ? seasons.flatMap((s) =>
        Array.from({ length: s.maxEp }, (_, i) => ({ se: s.se, ep: i + 1 }))
      )
    : [{ se: 0, ep: 0 }];

  const MAX_EPISODES = 1000;
  const targets = episodeTargets.slice(0, MAX_EPISODES);

  const seasonMap = new Map<number, Map<number, ReturnType<typeof mapDownloadItem>[]>>();

  for (const { se, ep } of targets) {
    const data = await getDownload(subjectId, se, ep, detailPath);
    if (!data?.hasResource || !data.downloads?.length) continue;

    if (!seasonMap.has(se)) seasonMap.set(se, new Map());
    seasonMap.get(se)!.set(ep, data.downloads.map(mapDownloadItem));
  }

  if (!seasonMap.size) return err('No downloads available', 404);

  const result = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, epMap]) => ({
      season: seasonNum,
      episodes: [...epMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, qualities]) => ({
          episode: epNum,
          qualities,
        })),
    }));

  return json({ seasons: result, total_seasons: result.length });
}

// GET /home/rows
async function handleHomeRows(env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const rows = (data.operatingList || []).map((row) => ({
    title: row.title,
    opId: row.opId,
  }));

  return json({ total: rows.length, rows });
}

// GET /home
async function handleHome(env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const rows = (data.operatingList || []).map((row) => ({
    title: row.title,
    opId: row.opId,
    type: row.type,
    total: (row.subjects || []).length,
    subjects: (row.subjects || [])
      .filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType))
      .map(normalizeH5Subject),
  }));

  return json({ total: rows.length, rows });
}

// GET /home/subjects?opId=X
async function handleHomeSubjects(opId: string, env: Env): Promise<Response> {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err('Failed to fetch homepage', 502);

  const row = (data.operatingList || []).find((r) => r.opId === opId);
  if (!row) return err('Row not found', 404);

  const subjects = (row.subjects || [])
    .filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType))
    .map(normalizeH5Subject);

  return json({
    opId: row.opId,
    title: row.title,
    total: subjects.length,
    subjects,
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public routes — no auth required
    if (path === '/' && request.method === 'GET') {
      return handleRoot();
    }

    if (path === '/health' && request.method === 'GET') {
      return json({ status: 'ok', worker: 'moviebox-worker', ts: Date.now() });
    }

    if (!isAuthorized(request, env)) {
      return err('Unauthorized', 401);
    }

    // POST /search
    if (path === '/search' && request.method === 'POST') {
      return handleSearch(request);
    }

    // GET /info/:subjectId
    const infoMatch = path.match(/^\/info\/([^/]+)$/);
    if (infoMatch && request.method === 'GET') {
      return handleInfo(infoMatch[1], url.searchParams.get('detailPath'));
    }

    // GET /season/:subjectId
    const seasonMatch = path.match(/^\/season\/([^/]+)$/);
    if (seasonMatch && request.method === 'GET') {
      return handleSeason(seasonMatch[1], url.searchParams.get('detailPath'));
    }

    // GET /stream/:subjectId/all — must be checked before /stream/:subjectId
    const streamAllMatch = path.match(/^\/stream\/([^/]+)\/all$/);
    if (streamAllMatch && request.method === 'GET') {
      return handleStreamAll(streamAllMatch[1], url.searchParams.get('detailPath'));
    }

    // GET /stream/:subjectId?se=X&ep=Y
    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0', 10);
      const ep = parseInt(url.searchParams.get('ep') ?? '0', 10);
      return handleStream(streamMatch[1], se, ep, url.searchParams.get('detailPath'));
    }

    // GET /download/:subjectId
    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'GET') {
      return handleDownload(downloadMatch[1], url.searchParams.get('detailPath'));
    }

    // GET /home/rows — must be checked before /home
    if (path === '/home/rows' && request.method === 'GET') {
      return handleHomeRows(env);
    }

    // GET /home/subjects?opId=X — must be checked before /home
    if (path === '/home/subjects' && request.method === 'GET') {
      const opId = url.searchParams.get('opId');
      if (!opId) return err('opId is required');
      return handleHomeSubjects(opId, env);
    }

    // GET /home
    if (path === '/home' && request.method === 'GET') {
      return handleHome(env);
    }

    return err('Not found', 404);
  },
};
