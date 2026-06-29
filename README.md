<div align="center">

# 🎬 Spün MovieBox API

**An unofficial REST API built by [Spün](https://byspun.xyz) for MovieBox — wrapping the MovieBox H5 web API with session-based auth, multi-quality stream resolution, embedded subtitles, and structured JSON responses, deployed on Cloudflare Workers.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-BSL%201.1-green?style=flat)](./LICENSE)
[![Status](https://img.shields.io/badge/Status-Production-brightgreen?style=flat)]()

</div>

---

## 📖 Table of Contents

- [Overview](#overview)
- [2026-06-27 Migration Notice](#2026-06-27-migration-notice)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [API Reference](#api-reference)
  - [Public Routes](#public-routes)
  - [Search](#post-search)
  - [Info](#get-infosubjectiddetailpath)
  - [Season](#get-seasonsubjectiddetailpath)
  - [Stream](#get-streamsubjectiddetailpath)
  - [Stream All](#get-streamsubjectidalldetailpath)
  - [Download](#get-downloadsubjectiddetailpath)
  - [Home](#get-home)
  - [Home Rows](#get-homerows)
  - [Home Subjects](#get-homesubjectsopidx)
- [Subject Types](#subject-types)
- [Known Quirks](#known-quirks)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Overview

This worker wraps the **MovieBox H5 web API** into a single, clean REST interface — search, subject detail, season structure, streaming, downloads, captions, and the homepage feed, all from one consistent auth scheme.

All routes except `/` and `/health` are protected by an `X-Worker-Secret` header.

---

## 2026-06-27 Migration Notice

This worker previously ran on the **MovieBox Android mobile API** (a 7-host pool, HMAC-MD5 signed). That pool started uniformly rejecting every request with HTTP 440/530 across all 7 hosts — confirmed live via `wrangler tail`, not a transient blip. This is consistent with MovieBox having broken or rotated something in that signing scheme upstream, with no fix available short of a maintainer re-reverse-engineering it.

**Every route has been rewritten to run on the H5 web API instead** (`h5-api.aoneroom.com` / `h5.aoneroom.com`), which needs no HMAC signing at all — just a bootstrapped session token. This was the same API surface already powering `/home`, so it's a known-stable foundation, not a new unknown.

**What changed for API consumers:**

- ✅ `/search`, `/stream`, `/stream/:id/all`, `/download`, `/home*` — **same response shape as before**, no breaking changes.
- ⚠️ `/info` and `/season` now require an additional **`?detailPath=`** query param. The H5 API has no JSON lookup for subject details by ID alone — detail data is extracted from the subject's actual web page, which is addressed by `detailPath` (e.g. `"avatar-WLDIi21IUBa"`), not `subjectId`. Every `/search` and `/home/subjects` response already includes `detailPath` on each item — pass it straight through. Calling either route without it now returns a clear `400` explaining why, instead of a confusing failure.
- 🎉 **New:** `/stream` and `/stream/:id/all` responses now include a `captions` array — direct, signed `.srt` subtitle URLs sourced straight from MovieBox, no separate subtitle provider needed for anything MovieBox already has covered.

---

## Architecture

```
Client Request
      │
      ▼
Cloudflare Worker (src/index.ts)
      │
      ├── H5 Session (src/h5session.ts)
      │         │
      │         └── Bootstrap handshake → search-suggest endpoint
      │                   │                returns x-user header (JWT) + cookies
      │                   └── Cached in-memory per isolate, re-bootstrapped
      │                       automatically when the JWT nears expiry
      │
      ├── Search / Stream / Download (src/moviebox.ts)
      │         │
      │         ├── h5-api.aoneroom.com/.../subject/search
      │         └── h5.aoneroom.com/wefeed-h5-bff/web/subject/download
      │                   (single episode per call — se=0&ep=0 for movies)
      │
      ├── Info / Season (src/moviebox.ts + src/nuxtExtract.ts)
      │         │
      │         └── Fetch h5.aoneroom.com/movies/{detailPath}?id={subjectId}
      │                   │
      │                   └── Extract & resolve the page's embedded
      │                       __NUXT_DATA__ payload (Nuxt's devalue-style
      │                       flat reference array) to recover subject,
      │                       season, and cast data
      │
      └── Home Routes (UNCHANGED — already on H5, unaffected by the migration)
                │
                └── fetchH5Home() → 3-host fallback, no signing
                          │         + X-Forwarded-For Nigerian IP pin
                          └── netnaija.film (primary)
                              h5.aoneroom.com
                              moviebox.pk
```

### Why the Nigerian IP pin?

The H5 home upstream returns different homepage feeds based on the requester's IP geolocation. Cloudflare edge nodes have US/EU IPs and receive a truncated 30-row feed. By sending `X-Forwarded-For` with a Nigerian IP via the `NIGERIA_IP` environment variable, the upstream returns the full 35-row Africa region feed — including the Nollywood, Football Highlights, and Must-watch Black Shows rows.

### Why the bootstrap handshake?

The H5 API has no API-key or HMAC auth — instead, a POST to its search-suggest endpoint returns a short-lived JWT (in an `x-user` response header) plus session cookies. Every subsequent authenticated request needs both attached. The worker bootstraps once per isolate lifetime and re-bootstraps automatically once the JWT is close to expiring, or immediately if an upstream call comes back with an auth-style rejection.

### Why is `/stream` single-episode only?

Confirmed via direct testing: passing `se=0&ep=0` (the old "bulk" trick) against a TV series subjectId on the H5 download endpoint returns `hasResource: false` — there's no native bulk mode here. `/stream/:id/all` and `/download` therefore loop over each episode themselves and aggregate the results, the same approach as before, just hitting the new upstream per call instead of the old Android one.

### Why does `/info`/`/season` need `detailPath`?

Unlike search or download, MovieBox's H5 API has no JSON endpoint for subject details — that data only exists embedded in the subject's actual detail **page** HTML (a Nuxt.js app), addressed by `detailPath`, not `subjectId`. The worker fetches that page and extracts the embedded `__NUXT_DATA__` payload — a flat, deduplicated reference array (Nuxt's "devalue" serialization) — then walks the reference chain to recover the real `subject`, `resource.seasons`, and `stars` (cast) objects. This was verified by hand against a real page before being implemented, including resolving cast member references to confirm the walk was correct end-to-end.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MOVIEBOX_SECRET` | ✅ Yes | Auth secret. Must match `X-Worker-Secret` on every request. Set via `wrangler secret put MOVIEBOX_SECRET` — never put in `wrangler.toml`. |
| `NIGERIA_IP` | ✅ Yes | A Nigerian IP address for `X-Forwarded-For`. Ensures the H5 upstream returns the full Africa region feed. Update in Cloudflare dashboard without redeploying. Falls back to `197.210.65.1` (MTN Nigeria) if not set. |

---

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- A Cloudflare account with Workers enabled

### Steps

**1. Star and fork this repo**

Hit ⭐ Star then click **Fork** at the top right of this page.

**2. Clone your fork**

```bash
git clone https://github.com/YOUR_USERNAME/spun-moviebox-api
cd spun-moviebox-api
```

**3. Install dependencies**

```bash
npm install
```

**4. Authenticate Wrangler**

```bash
wrangler login
```

**5. Set your secret**

```bash
wrangler secret put MOVIEBOX_SECRET
# Enter your chosen secret when prompted
```

**6. Configure `wrangler.toml`**

```toml
name = "spun-moviebox"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[vars]
NIGERIA_IP = "YOUR_NIGERIAN_IP"  # curl https://api.ipify.org to get yours

[[routes]]
pattern = "your-domain.com/*"
zone_name = "your-domain.com"
```

**7. Deploy**

```bash
wrangler deploy
```

**8. Test your deployment**

```bash
curl -s "https://your-worker.workers.dev/health" | python3 -m json.tool
```

---

## API Reference

All authenticated routes require the `X-Worker-Secret` header:

```bash
-H "X-Worker-Secret: your_secret_here"
```

---

### Public Routes

#### `GET /`

API info and route listing. No auth required.

```bash
curl -s "https://your-worker.workers.dev/"
```

```json
{
  "name": "Spün MovieBox API",
  "description": "An unofficial REST API built by Spün for MovieBox...",
  "version": "2.0.0",
  "routes": [ ... ]
}
```

---

#### `GET /health`

Worker health check. No auth required.

```bash
curl -s "https://your-worker.workers.dev/health"
```

```json
{
  "status": "ok",
  "worker": "moviebox-worker",
  "ts": 1781168254381
}
```

---

### `POST /search`

Search for movies, TV shows, and shorts.

**Body:**

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `keyword` | string | ✅ | — |
| `page` | number | ❌ | `1` |
| `perPage` | number | ❌ | `20` |

```bash
curl -s -X POST "https://your-worker.workers.dev/search" \
  -H "X-Worker-Secret: your_secret" \
  -H "Content-Type: application/json" \
  -d '{"keyword": "avatar", "page": 1}'
```

```json
{
  "items": [
    {
      "subjectId": "8906247916759695608",
      "subjectType": 1,
      "title": "Avatar",
      "type": "movie",
      "releaseDate": "2009-12-18",
      "duration": 9720,
      "genre": "Action,Adventure,Fantasy",
      "poster": "https://pbcdnw.aoneroom.com/image/...",
      "rating": 7.9,
      "language": null,
      "country": "United States",
      "detailPath": "avatar-WLDIi21IUBa"
    }
  ],
  "pager": {
    "hasMore": true,
    "page": "1",
    "perPage": 20,
    "totalCount": 79
  }
}
```

> **Note:** `detailPath` is a new field on each item — required for `/info` and `/season`. Carry it through wherever you store subject data.

---

### `GET /info/:subjectId?detailPath=`

Get full detail for a subject including cast list. **Requires `detailPath`** — see the [migration notice](#2026-06-27-migration-notice).

```bash
curl -s "https://your-worker.workers.dev/info/8906247916759695608?detailPath=avatar-WLDIi21IUBa" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "subjectId": "8906247916759695608",
  "subjectType": 1,
  "type": "movie",
  "title": "Avatar",
  "description": "A paraplegic Marine dispatched to the moon Pandora...",
  "releaseDate": "2009-12-18",
  "runtime": 162,
  "genre": "Action,Adventure,Fantasy",
  "poster": "https://pbcdnw.aoneroom.com/image/...",
  "country": "United States",
  "rating": 7.9,
  "hasResource": true,
  "language": null,
  "staff": [
    { "name": "Sam Worthington", "role": "Jake Sully", "avatar": "https://pbcdnw.aoneroom.com/image/..." }
  ]
}
```

---

### `GET /season/:subjectId?detailPath=`

Get season and episode structure for a TV show or shorts series. **Requires `detailPath`**. The `episodesAvailable` field reflects the highest episode count across all available resolutions.

```bash
curl -s "https://your-worker.workers.dev/season/7850278583678682192?detailPath=avatar-the-last-airbender-YoJu6LgmUl9" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "seasons": [
    {
      "season": 1,
      "totalEpisode": 8,
      "episodesAvailable": 8,
      "resolutions": [
        { "resolution": 360, "epNum": 8 },
        { "resolution": 480, "epNum": 8 },
        { "resolution": 720, "epNum": 8 },
        { "resolution": 1080, "epNum": 7 }
      ],
      "episodes": [
        { "episode": 1, "title": null, "releaseDate": null }
      ]
    }
  ]
}
```

---

### `GET /stream/:subjectId?detailPath=`

Stream URLs (+ captions) for a specific episode, one URL per quality.

**Query Params:**

| Param | Required | Description |
|-------|----------|-------------|
| `se` | ❌ (default `0`) | Season number. Use `0` for movies. |
| `ep` | ❌ (default `0`) | Episode number. Use `0` for movies. |
| `detailPath` | ✅ | Subject's detail path, from `/search` or `/home/subjects`. |

```bash
# Movie
curl -s "https://your-worker.workers.dev/stream/8906247916759695608?se=0&ep=0&detailPath=avatar-WLDIi21IUBa" \
  -H "X-Worker-Secret: your_secret"

# TV Episode
curl -s "https://your-worker.workers.dev/stream/7850278583678682192?se=1&ep=1&detailPath=avatar-the-last-airbender-YoJu6LgmUl9" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "streams": [
    {
      "quality": "1080p",
      "resolution": 1080,
      "url": "https://bcdnxw.hakunaymatata.com/resource/....mp4?sign=...&t=...",
      "format": "mp4",
      "size": "619 MB"
    }
  ],
  "total": 4,
  "captions": [
    {
      "language": "English",
      "language_code": "en",
      "url": "https://cacdn.hakunaymatata.com/subtitle/....srt?Policy=...&Signature=...&Key-Pair-Id=..."
    }
  ]
}
```

> **Note:** Stream and caption URLs are signed and time-limited by the upstream CDN. Fetch them fresh on each playback session — do not cache the URLs themselves.

---

### `GET /stream/:subjectId/all?detailPath=`

All stream URLs (+ captions) for every episode, grouped by season → episode. The H5 download endpoint is strictly single-episode, so this loops internally and aggregates — sequentially, not in parallel, to stay within Workers' subrequest limits on long series.

```bash
curl -s "https://your-worker.workers.dev/stream/7850278583678682192/all?detailPath=avatar-the-last-airbender-YoJu6LgmUl9" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "seasons": [
    {
      "season": 1,
      "episodes": [
        {
          "episode": 1,
          "streams": [
            { "quality": "720p", "resolution": 720, "url": "https://bcdnxw.hakunaymatata.com/...", "format": "mp4", "size": "385 MB" }
          ],
          "total": 1,
          "captions": [
            { "language": "English", "language_code": "en", "url": "https://cacdn.hakunaymatata.com/..." }
          ]
        }
      ]
    }
  ],
  "total_seasons": 1
}
```

---

### `GET /download/:subjectId?detailPath=`

Full download pack grouped by season → episode → qualities. Same underlying data as `/stream/all` but reshaped — the `qualities` key name makes the intent clearer for download managers.

```bash
curl -s "https://your-worker.workers.dev/download/7850278583678682192?detailPath=avatar-the-last-airbender-YoJu6LgmUl9" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "seasons": [
    {
      "season": 1,
      "episodes": [
        {
          "episode": 1,
          "qualities": [
            { "quality": "1080p", "resolution": 1080, "url": "https://bcdnxw.hakunaymatata.com/...", "format": "mp4", "size": "649 MB" }
          ]
        }
      ]
    }
  ],
  "total_seasons": 1
}
```

---

### `GET /home`

Full MovieBox homepage with all rows and their subjects. Africa/Lagos region feed — includes Nollywood, Anime Dubbed, Hot Short TV, Must-watch Black Shows, and more. **Unchanged by the migration.**

```bash
curl -s "https://your-worker.workers.dev/home" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "total": 45,
  "rows": [
    {
      "title": "Nollywood Movie",
      "opId": "359580746379676048",
      "type": "SUBJECTS_MOVIE",
      "total": 20,
      "subjects": [
        {
          "subjectId": "6021098917113354936",
          "subjectType": 1,
          "type": "movie",
          "title": "YOURS BEFORE WORDS",
          "poster": "https://pbcdnw.aoneroom.com/image/...",
          "hasResource": true,
          "detailPath": "yours-before-words-xxxxxxxxx"
        }
      ]
    }
  ]
}
```

---

### `GET /home/rows`

Lightweight endpoint — returns just row titles and opIds. Use this first to discover which rows exist and their opIds before fetching subjects. opIds change dynamically so do not hardcode them. **Unchanged by the migration.**

```bash
curl -s "https://your-worker.workers.dev/home/rows" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "total": 45,
  "rows": [
    { "title": "Nollywood Movie", "opId": "359580746379676048" },
    { "title": "Anime[English Dubbed]", "opId": "5992193223496810920" },
    { "title": "🔥Hot Short TV", "opId": "4322548590817198760" },
    { "title": "Must-watch Black Shows", "opId": "6956721858884814888" }
  ]
}
```

---

### `GET /home/subjects?opId=X`

Subjects for a specific homepage row identified by `opId`. **Unchanged by the migration.**

**Query Params:**

| Param | Required | Description |
|-------|----------|-------------|
| `opId` | ✅ | The opId of the row. Discover opIds via `/home/rows`. |

```bash
curl -s "https://your-worker.workers.dev/home/subjects?opId=359580746379676048" \
  -H "X-Worker-Secret: your_secret"
```

```json
{
  "opId": "359580746379676048",
  "title": "Nollywood Movie",
  "total": 20,
  "subjects": [
    {
      "subjectId": "6021098917113354936",
      "subjectType": 1,
      "type": "movie",
      "title": "YOURS BEFORE WORDS",
      "description": "",
      "releaseDate": "2026-06-09",
      "runtime": null,
      "genre": "drama",
      "poster": "https://pbcdnw.aoneroom.com/image/...",
      "thumbnail": "",
      "country": "Nigeria",
      "rating": null,
      "hasResource": true,
      "language": null,
      "detailPath": "yours-before-words-xxxxxxxxx"
    }
  ]
}
```

---

## Subject Types

| `subjectType` | `type` field | Description |
|---------------|-------------|-------------|
| `1` | `"movie"` | Feature film |
| `2` | `"tv"` | TV series |
| `7` | `"shorts"` | Vertical short-form content (Dramabox, ReelShorts, etc.) |

All other subject types are filtered out from responses.

---

## Known Quirks

**`detailPath` is now mandatory for `/info`, `/season`, `/stream`, `/stream/all`, and `/download`** — MovieBox's H5 API has no by-ID JSON lookup for subject detail data; it only exists embedded in the subject's web page, which is addressed by `detailPath`. Every `/search` and `/home/subjects` response already includes it.

**Signed, time-limited stream and caption URLs** — CDN URLs include a `sign`/`Signature` param and a `t`/expiry param. They expire. Always fetch fresh from `/stream` at playback time, including for subtitles.

**`/stream` is strictly single-episode upstream** — confirmed via direct testing: there is no native "all episodes in one call" mode on the H5 download endpoint (unlike the old Android resource endpoint's `se=0&ep=0` bulk trick). `/stream/:id/all` and `/download` loop over episodes internally to compensate.

**Shorts are structured like TV** — Despite being short-form vertical content, shorts subjects use `se=1` and a flat episode list under season 1. Use `/stream/:id?se=1&ep=X` for individual episodes or `/stream/:id/all` for the full pack.

**opIds change** — Homepage row opIds are dynamic and can change without notice. Always use `/home/rows` to discover current opIds rather than hardcoding them.

**Resolution availability varies** — Not every episode is available in every quality. The `resolutions[].epNum` field in `/season` tells you exactly how many episodes exist per quality tier.

**Session tokens are cached in-memory per Worker isolate** — not in Workers KV. This keeps the implementation simple, since re-bootstrapping is cheap and infrequent (JWTs observed to be long-lived), but means a cold start triggers one extra bootstrap request before the first real call succeeds.

---

## Acknowledgements

**[moviebox-api](https://github.com/Simatwa/moviebox-api) by Simatwa** — The foundation this worker is built on. The H5 web API's endpoints, the search-suggest auth handshake, and the `__NUXT_DATA__` detail-page extraction approach were all discovered through studying their Python library's v1/v2 implementation, after the older Android-API-based approach (also originally sourced from this project) was broken upstream.

**[Claude by Anthropic](https://claude.ai)** — Instrumental in diagnosing the Android pool's failure via live `wrangler tail` logs, reverse-engineering the H5 session bootstrap and `__NUXT_DATA__` payload structure by hand against real responses before writing a single line of the new client, and rebuilding the worker's request layer end-to-end while preserving every existing route's response contract for other projects depending on this API.

---

## License

This project is licensed under the **Business Source License 1.1 (BSL 1.1)**.

- ✅ Free for personal and non-commercial use
- ✅ You may study, fork, and self-host
- ❌ You may not sell, sublicense, or use this in a commercial product without written permission from the author
- 🔄 Converts to MIT License 4 years from the date of each release

See [LICENSE](./LICENSE) for full terms.

For commercial licensing inquiries, contact **Spün**.

---

<div align="center">

*This API was built entirely on a mobile phone using Termux on Android.*
*If I can do it, you can do it too.* 🙌

**~ Danny Daniels**

</div>
