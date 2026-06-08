// src/index.ts
// MovieBox Worker — main entry point.
// All routes are protected by X-Worker-Secret header.
// Routes:
//   POST /search              { keyword, page?, perPage? }
//   GET  /info/:subjectId
//   GET  /season/:subjectId
//   GET  /stream/:subjectId   ?se=0&ep=0
//   GET  /download/:subjectId ?se=0&ep=0
//   GET  /health

import {
  fetchWithHostPool,
  PATHS,
  type MBSearchData,
  type MBDetailData,
  type MBSeasonData,
  type MBPlayInfoData,
  type MBResourceData,
  type MBResourceItem,
} from './moviebox.js';

// ─── Env bindings ─────────────────────────────────────────────────────────────

export interface Env {
  MOVIEBOX_SECRET: string;
}

// ─── CORS / response helpers ──────────────────────────────────────────────────

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

// ─── Cookie parser (for CloudFront signCookie) ────────────────────────────────

function parseCookies(cookieStr: string): Record<string, string> {
  if (!cookieStr) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = val;
  }
  return cookies;
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

  const items = (data.items || []).map((item) => ({
    subjectId:   item.subjectId,
    subjectType: item.subjectType,   // 1 = movie, 2 = tv
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
    type:        item.subjectType === 2 ? 'tv' : 'movie',
  }));

  return json({ items, pager: data.pager });
}

async function handleInfo(subjectId: string): Promise<Response> {
  // Response is flat — the subject fields are returned directly as `data`,
  // not nested under `data.subject`. staffList is also at the top level.
  const data = await fetchWithHostPool<MBDetailData & MBDetailData['subject']>(
    PATHS.get, 'GET', { subjectId }
  );

  if (!data?.subjectId) return err('Not found', 404);

  // staffList may be at top level or inside a subject wrapper — handle both
  const staffList = (data as any).staffList || [];

  // duration comes back as "2h 42m" string in some responses — convert to minutes
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
    type:        data.subjectType === 2 ? 'tv' : 'movie',
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

  if (!data) return json({ seasons: [] });

  return json({
    seasons: (data.seasons || []).map((s) => ({
      season:       s.season,
      totalEpisode: s.totalEpisode ?? 0,
      episodes:     (s.episodes || []).map((ep) => ({
        episode:     ep.episode,
        title:       ep.title ?? null,
        releaseDate: ep.releaseDate ?? null,
      })),
    })),
  });
}

async function handleStream(subjectId: string, se: number, ep: number): Promise<Response> {
  const data = await fetchWithHostPool<MBPlayInfoData>(
    PATHS.playInfo, 'GET', { subjectId, se, ep }
  );

  if (!data?.streams?.length) return err('No streams available', 404);

  const streams = data.streams.map((s) => ({
    format:      s.format,
    url:         s.url,
    resolutions: s.resolutions ?? '',
    size:        s.size ?? null,
    duration:    s.duration ?? null,
    codecName:   s.codecName ?? null,
    // Parse CloudFront cookies so the frontend can attach them directly
    cookies:     parseCookies(s.signCookie ?? ''),
  }));

  return json({ title: data.title ?? null, streams });
}

async function handleDownload(subjectId: string, se: number, ep: number): Promise<Response> {
  const data = await fetchWithHostPool<MBResourceData>(
    PATHS.resource, 'GET', { subjectId, se, ep }
  );

  if (!data?.list?.length) return err('No downloads available', 404);

  // Only return free content
  const free = data.list.filter((r) => (r.requireMemberType ?? 0) === 0);
  if (!free.length) return err('No free downloads available', 404);

  // Sort best quality first
  const sorted = [...free].sort((a, b) => b.resolution - a.resolution);

  const downloads = sorted.map((item: MBResourceItem) => {
    const sizeMb = item.size
      ? `${Math.round(parseInt(item.size) / (1024 * 1024))} MB`
      : null;

    // Extract captions
    const captions = (item.extCaptions || []).map((cap) => ({
      language:      cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
      language_code: cap.lan,
      url:           cap.url,
    }));

    return {
      quality:    `${item.resolution}p`,
      resolution: item.resolution,
      url:        item.resourceLink,
      format:     'mp4',
      size:       sizeMb,
      codecName:  item.codecName ?? null,
      duration:   item.duration ?? null,
      captions,
      episode:    item.episode,
      se:         item.se,
      ep:         item.ep,
    };
  });

  return json({ downloads, total: downloads.length });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
        },
      });
    }

    // Auth check on all non-health routes
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return json({ status: 'ok', worker: 'moviebox-worker', ts: Date.now() });
    }

    if (!isAuthorized(request, env)) {
      return err('Unauthorized', 401);
    }

    // ── Routes ──────────────────────────────────────────────────────────────

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

    // GET /stream/:subjectId?se=0&ep=0
    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0');
      const ep = parseInt(url.searchParams.get('ep') ?? '0');
      return handleStream(streamMatch[1], se, ep);
    }

    // GET /download/:subjectId?se=0&ep=0
    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'GET') {
      const se = parseInt(url.searchParams.get('se') ?? '0');
      const ep = parseInt(url.searchParams.get('ep') ?? '0');
      return handleDownload(downloadMatch[1], se, ep);
    }

    return err('Not found', 404);
  },
};
