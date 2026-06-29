// src/h5session.ts
// MovieBox H5 web API session management for Cloudflare Workers.
//
// Replaces signing.ts. The H5 API (h5-api.aoneroom.com / h5.aoneroom.com)
// requires no HMAC signing — instead it uses a bootstrap handshake:
//   1. POST to /subject/search-suggest with any keyword.
//   2. The response's `x-user` HEADER contains JSON: {token, userId, userType, appType}.
//   3. The response also Set-Cookies a `token` cookie.
//   4. All subsequent requests need: `Authorization: Bearer {token}` + that cookie.
//
// The token is a JWT — we decode its `exp` claim and re-bootstrap once it's
// near expiry rather than blindly trusting an in-memory cache forever.
//
// Cached at module scope — reused for the lifetime of the Worker isolate.
// Re-bootstraps automatically on cold start (cache starts empty) or once the
// JWT is close to expiring.

const SEARCH_SUGGEST_URL =
  'https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search-suggest';

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.5',
  'X-Client-Info': '{"timezone":"Africa/Nairobi"}',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Firefox/137.0',
};

// Re-bootstrap this many seconds before actual JWT expiry, so we never
// fire a request with a token that expires mid-flight.
const EXPIRY_SAFETY_MARGIN_SECONDS = 300;

interface UserInfo {
  token: string;
  userId: string;
  userType: number;
  appType: number;
}

interface CachedSession {
  userInfo: UserInfo;
  cookieHeader: string;
  expiresAtSeconds: number;
}

// Module-scope cache — persists across requests within the same isolate,
// reset on cold start. This is the "in-memory" option (vs Workers KV) —
// simplest to reason about, acceptable since re-bootstrapping is cheap
// (a single lightweight POST) and infrequent (JWTs are long-lived, ~90 days
// per the decoded exp/iat delta observed during testing).
let _session: CachedSession | null = null;
let _bootstrapPromise: Promise<CachedSession> | null = null;

// ─── JWT helpers ────────────────────────────────────────────────────────────
// We only need the `exp` claim — no signature verification required since
// we're not validating trust, just reading a value MovieBox itself issued us.

function decodeJwtExpSeconds(jwt: string): number | null {
  try {
    const payloadB64 = jwt.split('.')[1];
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (padded.length % 4)) % 4);
    const json = atob(padded + padding);
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// ─── Cookie helpers ─────────────────────────────────────────────────────────
// We only need to forward the `token` (and `account`, if present) cookies
// that the search-suggest response sets. Cloudflare Workers' fetch() can
// receive multiple Set-Cookie headers via response.headers.getSetCookie().

function extractCookieHeader(response: Response): string {
  const setCookies =
    typeof (response.headers as any).getSetCookie === 'function'
      ? (response.headers as any).getSetCookie()
      : [];

  const pairs: string[] = [];
  for (const raw of setCookies as string[]) {
    // Each Set-Cookie line looks like "token=xyz; Path=/; ...". We only want
    // the "name=value" pair, not the attributes.
    const pair = raw.split(';')[0]?.trim();
    if (pair) pairs.push(pair);
  }
  return pairs.join('; ');
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap(): Promise<CachedSession> {
  const response = await fetch(SEARCH_SUGGEST_URL, {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify({ keyword: 'avatar', perPage: 0 }),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    throw new Error(`[H5Session] Bootstrap failed: HTTP ${response.status}`);
  }

  const xUser = response.headers.get('x-user');
  if (!xUser) {
    throw new Error('[H5Session] Bootstrap response missing x-user header');
  }

  let userInfo: UserInfo;
  try {
    userInfo = JSON.parse(xUser) as UserInfo;
  } catch {
    throw new Error('[H5Session] Failed to parse x-user header as JSON');
  }

  if (!userInfo.token) {
    throw new Error('[H5Session] x-user payload missing token');
  }

  const cookieHeader = extractCookieHeader(response);
  if (!cookieHeader) {
    console.warn('[H5Session] Bootstrap succeeded but no Set-Cookie received');
  }

  const exp = decodeJwtExpSeconds(userInfo.token);
  // Fall back to a conservative 1-hour assumed lifetime if the JWT couldn't
  // be decoded for some reason — better to over-refresh than to silently
  // run forever on a token of unknown lifetime.
  const expiresAtSeconds = exp ?? Math.floor(Date.now() / 1000) + 3600;

  const session: CachedSession = { userInfo, cookieHeader, expiresAtSeconds };
  _session = session;
  return session;
}

function isExpiringSoon(session: CachedSession): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= session.expiresAtSeconds - EXPIRY_SAFETY_MARGIN_SECONDS;
}

/**
 * Returns a valid, ready-to-use session (token + cookies), bootstrapping or
 * re-bootstrapping as needed. Concurrent callers during a cold start share
 * a single in-flight bootstrap rather than firing duplicate handshakes.
 */
export async function getSession(): Promise<CachedSession> {
  if (_session && !isExpiringSoon(_session)) {
    return _session;
  }

  if (!_bootstrapPromise) {
    _bootstrapPromise = bootstrap().finally(() => {
      _bootstrapPromise = null;
    });
  }

  return _bootstrapPromise;
}

/**
 * Convenience helper — returns headers ready to spread into any authenticated
 * H5 fetch call (search, download, info page fetch).
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await getSession();
  const headers: Record<string, string> = {
    ...COMMON_HEADERS,
    Authorization: `Bearer ${session.userInfo.token}`,
  };
  if (session.cookieHeader) {
    headers['Cookie'] = session.cookieHeader;
  }
  return headers;
}

/**
 * Forces a fresh bootstrap on the next getSession()/getAuthHeaders() call.
 * Useful if a downstream request gets a 401-style "invalid token" response
 * despite our local cache believing the token is still valid (e.g. MovieBox
 * revoked it server-side before our decoded exp would suggest).
 */
export function invalidateSession(): void {
  _session = null;
}
