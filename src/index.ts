// src/index.ts
// MovieBox Worker — main entry point.
// All routes are protected by X-Worker-Secret header.
// Routes:
//   POST /search              { keyword, page?, perPage? }
//   GET  /info/:subjectId
//   GET  /season/:subjectId
//   GET  /stream/:subjectId   ?se=X&ep=Y  — returns MP4 URLs for specific episode
//   GET  /download/:subjectId             — returns full pack grouped by season/episode
//   GET  /health
//
// /stream and /download both use the /resource endpoint (direct MP4 links).
// The old DASH /play-info endpoint is no longer used.

import {
  fetchWithHostPool,
  PATHS,
  type MBSearchData,
  type MBDetailData,
  type MBSeasonData,
  type MBResourceData,
  type MBResourceItem,
} from './moviebox.js';

// subjectType: 1=movie, 2=tv, 7=shorts — 5,6,8 filtered out
const ALLOWED_SUBJECT_TYPES = new Set([1, 2, 7]);

function resolveSubjectType(subjectType: number): 'movie' | 'tv' | 'shorts' {
  if (subjectType === 2) return 'tv';
  if (subjectType === 7) return 'shorts';
  return 'movie';
}

export interface Env {
  MOVIEBOX_SECRET: string;
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

// ─── Auth guard ───────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  const secret = request.headers.get('X-Worker-Secret');
  return !!secret && secret === env.MOVIEBOX_SECRET;
}

// ─── Language name map ────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',   fr: 'Français',  ar: 'Arabic',    zh: 'Chinese',
  ru: 'Russian',   pt: 'Português', es: 'Spanish',   de: 'German',
  ja: 'Japanese',  ko: 'Korean',    it: 'Italian',   sw: 'Kiswahili',
  ha: 'Hausa',     ms: 'Malay',     bn: 'Bengali',   ur: 'Urdu',
  pa: 'Punjabi',   fil: 'Filipino', id: 'Indonesian',
};

// ─── Shared: fetch full resource pack (all resolutions, all pages) ───────────
// MovieBox's resource endpoint is resolution-filtered — omitting the resolution
// param causes the server to return only one quality. We loop over every known
// resolution and paginate each until hasMore=false, deduplicating by resourceId
// across passes. se=0&ep=0 is the magic value that returns all episodes in bulk.

const RESOLUTIONS = [360, 480, 720, 1080];

async function fetchResourcePack(subjectId: string): Promise<MBResourceItem[] | null> {
  const seenResourceIds = new Set<string>();
  const allItems: MBResourceItem[] = [];
  const perPage = 10; // server silently rejects values above 10

  for (const resolution of RESOLUTIONS) {
    let page = 1;

    while (true) {
      const data = await fetchWithHostPool<MBResourceData>(
        PATHS.resource, 'GET', { subjectId, se: 0, ep: 0, resolution, page, perPage }
      );

      if (!data?.list?.length) break;

      for (const item of data.list) {
        if (!seenResourceIds.has(item.resourceId)) {
          seenResourceIds.add(item.resourceId);
          allItems.push(item);
        }
      }

      if (!data.pager?.hasMore) break;

      page++;

      // Safety cap — 100 pages x 50 items = 5000 items per resolution,
      // enough for the longest series on MovieBox (e.g. One Piece ~1100 eps).
      if (page > 100) break;
    }
  }

  if (!allItems.length) return null;

  return allItems.sort((a, b) => b.resolution - a.resolution);
}

// ─── Shared: map a resource item to a download object ────────────────────────

function mapResourceItem(item: MBResourceItem) {
  const sizeMb = item.size
    ? `${Math.round(parseInt(item.size) / (1024 * 1024))} MB`
    : null;

  const captions = (item.extCaptions || []).map((cap) => ({
    language:      cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
    language_code: cap.lan,
    url:           cap.url,
  }));

  return {
    quality:    `${item.resolution}p`,
    resolution: item.resolution,
    url:        item.resourceLink,
    format:     'mp4' as const,
    size:       sizeMb,
    codecName:  item.codecName ?? null,
    duration:   item.duration ?? null,
    captions,
    se:         item.se,
    ep:         item.ep,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleSearch(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return err('Invalid JSON body');
  }

  const keyword = body.keyword as string;
  if (!keyword?.trim()) return err('keyword is required');

  const page    = Number(body.page ?? 1);
  const perPage = Number(body.perPage ?? 20);

  const data = await fetchWithHostPool<MBSearchData>(
    PATHS.search, 'POST', undefined,
    { keyword, page, perPage, subjectType: 0 }
  );

  if (!data) return json({ items: [], pager: null });

  const items = (data.items || [])
    .filter((item) => ALLOWED_SUBJECT_TYPES.has(item.subjectType))
    .map((item) => ({
    subjectId:   item.subjectId,
    subjectType: item.subjectType,
    title:       item.title,
    description: item.description ?? '',
    releaseDate: item.releaseDate ?? null,
    duration:    item.duration ?? null,
    genre:       item.genre ?? null,
    poster:      item.cover?.url ?? null,
    thumbnail:   item.cover?.thumbnail ?? null,
    country:     item.countryName ?? null,
    rating:      item.imdbRatingValue && item.imdbRatingValue !== '0'
                   ? parseFloat(item.imdbRatingValue)
                   : null,
    language:    item.language ?? null,
    type:        resolveSubjectType(item.subjectType),
  }));

  return json({ items, pager: data.pager });
}

async function handleInfo(subjectId: string): Promise<Response> {
  const data = await fetchWithHostPool<MBDetailData>(
    PATHS.get, 'GET', { subjectId }
  );

  if (!data?.subjectId) return err('Not found', 404);

  const staffList = (data as any).staffList || [];

  const rawDuration = (data as any).duration;
  let runtimeMinutes: number | null = null;
  if (typeof rawDuration === 'number') {
    runtimeMinutes = Math.round(rawDuration / 60);
  } else if (typeof rawDuration === 'string') {
    const hMatch = rawDuration.match(/(\d+)h/);
    const mMatch = rawDuration.match(/(\d+)m/);
    const h = hMatch ? parseInt(hMatch[1]) : 0;
    const m = mMatch ? parseInt(mMatch[1]) : 0;
    runtimeMinutes = h * 60 + m || null;
  }

  return json({
    subjectId:   data.subjectId,
    subjectType: data.subjectType,
    type:        resolveSubjectType(data.subjectType),
    title:       data.title,
    description: data.description ?? '',
    releaseDate: data.releaseDate ?? null,
    runtime:     runtimeMinutes,
    genre:       data.genre ?? null,
    poster:      data.cover?.url ?? null,
    country:     data.countryName ?? null,
    rating:      data.imdbRatingValue && data.imdbRatingValue !== '0'
                   ? parseFloat(data.imdbRatingValue)
                   : null,
    hasResource: data.hasResource ?? false,
    language:    data.language ?? null,
    staff:       staffList.map((s: any) => ({
      name:   s.name,
      role:   s.role,
      avatar: s.avatar?.url ?? null,
    })),
  });
}

async function handleSeason(subjectId: string): Promise<Response> {
  const data = await fetchWithHostPool<MBSeasonData>(
    PATHS.seasonInfo, 'GET', { subjectId }
  );

  if (!data?.seasons?.length) return json({ seasons: [] });

  return json({
    seasons: data.seasons.map((s) => {
      const bestEpCount = s.resolutions?.length
        ? Math.max(...s.resolutions.map((r) => r.epNum))
        : s.maxEp;

      return {
        season:            s.se,
        totalEpisode:      s.maxEp,
        episodesAvailable: bestEpCount,
        resolutions:       s.resolutions || [],
        episodes:          Array.from({ length: s.maxEp }, (_, i) => ({
          episode:     i + 1,
          title:       null,
          releaseDate: null,
        })),
      };
    }),
  });
}

// GET /stream/:subjectId?se=X&ep=Y
// Fetches full resource pack, filters to the specific episode, deduplicates by quality.
// Returns MP4 URLs — player picks quality.

async function handleStream(subjectId: string, se: number, ep: number): Promise<Response> {
  const pack = await fetchResourcePack(subjectId);
  if (!pack) return err('No streams available', 404);

  // For movies se=0&ep=0 — return full pack as-is (single item per quality)
  // For TV filter to the specific episode
  const isMovie = se === 0 && ep === 0;
  let items = pack;

  if (!isMovie) {
    const filtered = pack.filter((r) => r.se === se && r.ep === ep);
    if (!filtered.length) return err('No streams available for this episode', 404);
    items = filtered;
  }

  // Deduplicate by quality — keep first (best encode per resolution)
  const seenQualities = new Set<string>();
  const streams = items
    .filter((item) => {
      const q = `${item.resolution}p`;
      if (seenQualities.has(q)) return false;
      seenQualities.add(q);
      return true;
    })
    .map(mapResourceItem);

  return json({ streams, total: streams.length });
}

// GET /download/:subjectId
// Returns full pack grouped by season → episodes → qualities.
// No se/ep params — always returns everything available.

async function handleDownload(subjectId: string): Promise<Response> {
  const pack = await fetchResourcePack(subjectId);
  if (!pack) return err('No downloads available', 404);

  // Group by season (se) → episode (ep) → deduplicated qualities
  const seasonMap = new Map<number, Map<number, ReturnType<typeof mapResourceItem>[]>>();

  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;

    if (!seasonMap.has(seKey)) seasonMap.set(seKey, new Map());
    const episodeMap = seasonMap.get(seKey)!;

    if (!episodeMap.has(epKey)) episodeMap.set(epKey, []);
    const qualities = episodeMap.get(epKey)!;

    // Deduplicate by quality within each episode
    const q = `${item.resolution}p`;
    if (!qualities.find((x) => x.quality === q)) {
      qualities.push(mapResourceItem(item));
    }
  }

  // Convert to Option B shape: seasons[] → episodes[] → qualities[]
  const seasons = [...seasonMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, episodeMap]) => ({
      season: seasonNum,
      episodes: [...episodeMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([epNum, qualities]) => ({
          episode:  epNum,
          qualities,
        })),
    }));

  return json({ seasons, total_seasons: seasons.length });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
        },
      });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
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
      return handleInfo(infoMatch[1]);
    }

    // GET /season/:subjectId
    const seasonMatch = path.match(/^\/season\/([^/]+)$/);
    if (seasonMatch && request.method === 'GET') {
      return handleSeason(seasonMatch[1]);
    }

    // GET /stream/:subjectId?se=X&ep=Y
    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0');
      const ep = parseInt(url.searchParams.get('ep') ?? '0');
      return handleStream(streamMatch[1], se, ep);
    }

    // GET /download/:subjectId  (no se/ep — always full pack)
    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'GET') {
      return handleDownload(downloadMatch[1]);
    }

    // TEMP DEBUG — remove after testing
    // GET /debug/resource/:subjectId        — raw single page call
    // GET /debug/pack/:subjectId            — full fetchResourcePack run with diagnostics
    const debugMatch = path.match(/^\/debug\/resource\/([^/]+)$/);
    if (debugMatch && request.method === 'GET') {
      const resolution = parseInt(url.searchParams.get('resolution') ?? '1080');
      const page       = parseInt(url.searchParams.get('page') ?? '1');
      const raw = await fetchWithHostPool<unknown>(
        PATHS.resource, 'GET',
        { subjectId: debugMatch[1], se: 0, ep: 0, resolution, page, perPage: 10 }
      );
      return json({ raw });
    }

    const debugPackMatch = path.match(/^\/debug\/pack\/([^/]+)$/);
    if (debugPackMatch && request.method === 'GET') {
      const subjectId = debugPackMatch[1];
      const log: unknown[] = [];
      const seenResourceIds = new Set<string>();
      const allItems: MBResourceItem[] = [];
      const perPage = 10; // server silently rejects values above 10
      const RES = [360, 480, 720, 1080];

      for (const resolution of RES) {
        let page = 1;
        let pagesForRes = 0;

        while (true) {
          const data = await fetchWithHostPool<MBResourceData>(
            PATHS.resource, 'GET', { subjectId, se: 0, ep: 0, resolution, page, perPage }
          );

          if (!data) {
            log.push({ resolution, page, result: 'null — fetchWithHostPool returned null' });
            break;
          }

          if (!data.list) {
            log.push({ resolution, page, result: 'no list field', keys: Object.keys(data) });
            break;
          }

          if (!data.list.length) {
            log.push({ resolution, page, result: 'empty list', hasMore: data.pager?.hasMore });
            break;
          }

          const newItems = data.list.filter(item => !seenResourceIds.has(item.resourceId));
          newItems.forEach(item => {
            seenResourceIds.add(item.resourceId);
            allItems.push(item);
          });

          log.push({
            resolution,
            page,
            itemsOnPage: data.list.length,
            newItems: newItems.length,
            hasMore: data.pager?.hasMore,
            totalCount: data.pager?.totalCount,
          });

          if (!data.pager?.hasMore) break;
          page++;
          pagesForRes++;
          if (page > 100) { log.push({ resolution, note: 'hit 100 page cap' }); break; }
        }
      }

      return json({
        totalCollected: allItems.length,
        log,
        sample: allItems.slice(0, 3).map(i => ({ se: i.se, ep: i.ep, resolution: i.resolution, resourceId: i.resourceId })),
      });
    }

    return err('Not found', 404);
  },
};