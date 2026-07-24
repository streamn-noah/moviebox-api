# Optimizing Proxy Bandwidth and Adding Edge Caching

Your proxy was maxed out because when a user or search bot visits a TV show detail page, the client automatically triggers a background cache pre-warm (`prewarmStreamCache`) for the entire TV show. This calls `/api/stream-all` on the client, which requests the `/download` package on the backend. 

On the Vercel backend, `/download` fetches and paginates through **every single season, episode, and resolution** of the TV show from MovieBox to compile the list. Since Vercel serverless functions have no shared persistence for their in-memory cache, this network-heavy storm runs through the proxy **on every page visit or refresh**, quickly consuming gigabytes of bandwidth.

To resolve this, we propose:
1. **Disabling TV cache pre-warming on the client**: We will load stream sources on-demand (only fetching the active episode being played or selected by the user), completely eliminating `/api/stream-all` background fetches.
2. **Adding CDN Edge Caching on the Vercel Backend**: We will return `Cache-Control` headers for all successful GET requests so that Vercel's Edge CDN caches metadata (24 hours) and stream links (5 minutes). Repeated requests will be served directly from Vercel's global CDN without executing the backend function or consuming proxy traffic.

---

## Proposed Changes

### 1. Web Client (`streamn-client`)

#### [MODIFY] [media-detail-content.tsx](file:///c:/Users/PC/Documents/GitHub/streamn-client/Web/components/streamn/media-detail-content.tsx)
- Disable the automatic `prewarmStreamCache` call inside the `useEffect` hook on page load.

---

### 2. Backend Worker (`spun-moviebox-api`)

#### [MODIFY] [index.ts](file:///C:/Users/PC/Documents/GitHub/spun-moviebox-api/src/index.ts)
- Modify the main router to capture responses and attach `Cache-Control` headers before returning:
  - Cache metadata endpoints (`/info/*`, `/season/*`, `/home`, `/home/rows`, `/home/subjects`) for 24 hours (`public, max-age=86400, s-maxage=86400`).
  - Cache stream/download endpoints (`/stream/*`, `/download/*`) for 5 minutes (`public, max-age=300, s-maxage=300`).

---

## Verification Plan

### Manual Verification
1. We will verify that visiting a TV show detail page no longer makes a background `/api/stream-all` request.
2. We will check that when playing an episode, the client makes a single `/api/stream-source` request for that specific episode.
3. We will inspect the backend response headers to verify that `Cache-Control` headers are correctly set, ensuring CDN caching.
