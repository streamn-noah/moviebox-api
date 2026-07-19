var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err2) => function __init() {
  if (err2) throw err2[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err2 = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/signing.ts
var signing_exports = {};
__export(signing_exports, {
  bootstrapAuthToken: () => bootstrapAuthToken,
  generateClientToken: () => generateClientToken,
  generateSignature: () => generateSignature,
  getCachedAuthToken: () => getCachedAuthToken,
  invalidateAuthToken: () => invalidateAuthToken
});
import nodeCrypto from "node:crypto";
function b64Decode(value) {
  const padding = (4 - value.length % 4) % 4;
  const padded = value + "=".repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function b64Encode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
async function md5Hex(data) {
  const hash = nodeCrypto.createHash("md5");
  hash.update(data);
  return hash.digest("hex");
}
async function hmacMd5(keyBytes, message) {
  const hmac = nodeCrypto.createHmac("md5", keyBytes);
  hmac.update(message);
  return hmac.digest();
}
async function generateClientToken(ts) {
  const tsStr = String(ts);
  const reversed = tsStr.split("").reverse().join("");
  const hash = await md5Hex(reversed);
  return `${tsStr},${hash}`;
}
function sortedQueryString(url) {
  const u = new URL(url);
  const params = [];
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sorted) {
    params.push(`${key}=${value}`);
  }
  return params.join("&");
}
async function buildCanonicalString(method, accept, contentType, url, body, ts) {
  const u = new URL(url);
  const path = u.pathname;
  const query = sortedQueryString(url);
  const canonicalUrl = query ? `${path}?${query}` : path;
  let bodyHash = "";
  let bodyLength = "";
  if (body !== null) {
    const bodyBytes = new TextEncoder().encode(body);
    const truncated = bodyBytes.slice(0, SIGNATURE_BODY_MAX_BYTES);
    bodyHash = await md5Hex(truncated);
    bodyLength = String(bodyBytes.length);
  }
  return [method.toUpperCase(), accept, contentType, bodyLength, ts, bodyHash, canonicalUrl].join(
    "\n"
  );
}
async function generateSignature(method, accept, contentType, url, body, ts) {
  const canonical = await buildCanonicalString(method, accept, contentType, url, body, ts);
  const secretBytes = b64Decode(SECRET_KEY_B64);
  const mac = await hmacMd5(secretBytes, canonical);
  return `${ts}|2|${b64Encode(mac)}`;
}
function decodeJwtExpSeconds(jwt) {
  try {
    const payloadB64 = jwt.split(".")[1];
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - padded.length % 4) % 4);
    const json2 = atob(padded + padding);
    const payload = JSON.parse(json2);
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
async function readTokenFromKv(kv) {
  try {
    const raw = await kv.get(KV_TOKEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[Signing] Failed to read/parse KV token: ${e}`);
    return null;
  }
}
async function writeTokenToKv(kv, cached) {
  try {
    await kv.put(KV_TOKEN_KEY, JSON.stringify(cached), { expirationTtl: KV_TTL_SECONDS });
  } catch (e) {
    console.warn(`[Signing] Failed to write token to KV: ${e}`);
  }
}
function isExpiringSoon(cached) {
  const nowSeconds = Math.floor(Date.now() / 1e3);
  return nowSeconds >= cached.expiresAtSeconds - EXPIRY_SAFETY_MARGIN_SECONDS;
}
async function bootstrapAuthToken(env, deviceId, gaid, signedFetch, bootstrapIp) {
  if (!_bootstrapPromise) {
    _bootstrapPromise = (async () => {
      const token = await signedFetch();
      if (!token) {
        throw new Error("[Signing] Bootstrap failed \u2014 no x-user token received from any host");
      }
      const exp = decodeJwtExpSeconds(token);
      const expiresAtSeconds = exp ?? Math.floor(Date.now() / 1e3) + 3600;
      await writeTokenToKv(env.MOVIEBOX_SESSION_KV, { token, expiresAtSeconds, deviceId, gaid, bootstrapIp });
      return token;
    })().finally(() => {
      _bootstrapPromise = null;
    });
  }
  return _bootstrapPromise;
}
async function getCachedAuthToken(env) {
  const cached = await readTokenFromKv(env.MOVIEBOX_SESSION_KV);
  if (cached && !isExpiringSoon(cached)) {
    return cached;
  }
  return null;
}
async function invalidateAuthToken(env) {
  try {
    await env.MOVIEBOX_SESSION_KV.delete(KV_TOKEN_KEY);
  } catch (e) {
    console.warn(`[Signing] Failed to invalidate KV token: ${e}`);
  }
}
var SECRET_KEY_B64, SIGNATURE_BODY_MAX_BYTES, KV_TOKEN_KEY, KV_TTL_SECONDS, EXPIRY_SAFETY_MARGIN_SECONDS, _bootstrapPromise;
var init_signing = __esm({
  "src/signing.ts"() {
    "use strict";
    SECRET_KEY_B64 = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
    SIGNATURE_BODY_MAX_BYTES = 102400;
    KV_TOKEN_KEY = "mobile_auth_token";
    KV_TTL_SECONDS = 60 * 60 * 24;
    EXPIRY_SAFETY_MARGIN_SECONDS = 300;
    _bootstrapPromise = null;
  }
});

// src/moviebox.ts
init_signing();
var HOST_POOL = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api4sg.aoneroom.com",
  "https://api3.aoneroom.com",
  "https://api6sg.aoneroom.com",
  "https://api.inmoviebox.com"
];
var VERSION_CODE = 50020044;
var VERSION_NAME = "3.0.03.0529.03";
var ANDROID_VERSION = "13";
var ANDROID_BUILD = "TQ2A.230405.003";
var DEVICE_MODEL = "23078RKD5C";
var DEVICE_BRAND = "Redmi";
var USER_AGENT = `com.community.oneroom/${VERSION_CODE} (Linux; U; Android ${ANDROID_VERSION}; en_US; ${DEVICE_MODEL}; Build/${ANDROID_BUILD}; Cronet/135.0.7012.3)`;
var PATHS = {
  search: "/wefeed-mobile-bff/subject-api/search",
  get: "/wefeed-mobile-bff/subject-api/get",
  seasonInfo: "/wefeed-mobile-bff/subject-api/season-info",
  resource: "/wefeed-mobile-bff/subject-api/resource",
  captions: "/wefeed-mobile-bff/subject-api/get-ext-captions",
  // Lightweight bootstrap target — any signed GET works, this is the
  // smallest/cheapest one. Not used for actual homepage data (that's H5).
  tabOperating: "/wefeed-mobile-bff/tab-operating"
};
function makeClientInfo(customDeviceId, customGaid) {
  const deviceId = customDeviceId || Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const gaid = customGaid || crypto.randomUUID();
  return JSON.stringify({
    package_name: "com.community.oneroom",
    version_name: VERSION_NAME,
    version_code: VERSION_CODE,
    os: "android",
    os_version: ANDROID_VERSION,
    install_ch: "ps",
    device_id: deviceId,
    install_store: "ps",
    gaid,
    brand: DEVICE_BRAND,
    model: DEVICE_MODEL,
    system_language: "en",
    net: "NETWORK_WIFI",
    region: "US",
    timezone: "America/New_York",
    sp_code: "40401",
    "X-Play-Mode": "2"
  });
}
var _clientInfo = null;
function getClientInfo(deviceId, gaid) {
  if (deviceId && gaid) {
    return makeClientInfo(deviceId, gaid);
  }
  if (!_clientInfo) _clientInfo = makeClientInfo();
  return _clientInfo;
}
async function buildHeaders(method, url, body = null, authToken = null, deviceId, gaid) {
  const accept = "application/json";
  const contentType = body !== null ? "application/json; charset=utf-8" : "application/json";
  const ts = Date.now();
  const [token, signature] = await Promise.all([
    generateClientToken(ts),
    generateSignature(method, accept, contentType, url, body, ts)
  ]);
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": accept,
    "Content-Type": contentType,
    "Connection": "keep-alive",
    "X-Client-Token": token,
    "x-tr-signature": signature,
    "X-Client-Info": getClientInfo(deviceId, gaid),
    "X-Client-Status": "0",
    "X-Play-Mode": "2"
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}
function extractXUserToken(response) {
  const xUser = response.headers.get("x-user");
  if (!xUser) return null;
  try {
    const payload = JSON.parse(xUser);
    return payload.token ?? null;
  } catch {
    return null;
  }
}
async function attemptHostPool(path, method, params, bodyStr, authToken, nigeriaIp, deviceId, gaid) {
  let freshXUserToken = null;
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
    if (nigeriaIp) {
      headers["X-Forwarded-For"] = nigeriaIp;
    }
    console.log(`[MovieBox Outgoing] URL: ${urlStr}`);
    console.log(`[MovieBox Outgoing] Headers:`, JSON.stringify(headers));
    try {
      const response = await fetch(urlStr, {
        method,
        headers: {
          ...headers,
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0"
        },
        body: bodyStr ?? void 0,
        signal: AbortSignal.timeout(12e3),
        cache: "no-store"
      });
      sawAnyResponse = true;
      const xUserToken = extractXUserToken(response);
      if (xUserToken) freshXUserToken = xUserToken;
      if (response.status === 401 || response.status === 403) {
        console.warn(`[MovieBox] Host ${base} returned ${response.status} (auth) \u2014 trying next`);
        sawAuthFailure = true;
        continue;
      }
      if (!response.ok) {
        console.warn(`[MovieBox] Host ${base} returned ${response.status} \u2014 trying next`);
        continue;
      }
      const data = await response.json();
      if (data.code === 0) {
        return { data: data.data ?? null, freshXUserToken, authFailure: false };
      }
      console.warn(`[MovieBox] Host ${base} returned API code ${data.code}: ${data.message ?? ""} \u2014 trying next`);
      if (data.message && /token|auth/i.test(data.message)) {
        sawAuthFailure = true;
      }
    } catch (err2) {
      console.warn(`[MovieBox] Host ${base} failed: ${err2} \u2014 trying next`);
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
    authFailure: sawAnyResponse && sawAuthFailure
  };
}
async function fetchWithHostPool(env, path, method, params, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const cached = await getCachedAuthToken(env);
  const nigeriaIp = cached?.bootstrapIp || env.NIGERIA_IP || "197.210.65.1";
  let authToken = cached?.token ?? null;
  let deviceId = cached?.deviceId ?? void 0;
  let gaid = cached?.gaid ?? void 0;
  if (!authToken) {
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
    gaid = crypto.randomUUID();
    try {
      const finalDeviceId = deviceId;
      const finalGaid = gaid;
      authToken = await bootstrapAuthToken(env, finalDeviceId, finalGaid, async () => {
        const result2 = await attemptHostPool(
          PATHS.tabOperating,
          "GET",
          { page: 1, tabId: 0, version: "" },
          null,
          null,
          nigeriaIp,
          finalDeviceId,
          finalGaid
        );
        return result2.freshXUserToken;
      });
    } catch (e) {
      console.error(`[MovieBox] Auth bootstrap failed: ${e}`);
      return null;
    }
  }
  let result = await attemptHostPool(path, method, params, bodyStr, authToken, nigeriaIp, deviceId, gaid);
  if (result.freshXUserToken && result.freshXUserToken !== authToken) {
    const finalDeviceId = deviceId || "";
    const finalGaid = gaid || "";
    await bootstrapAuthToken(env, finalDeviceId, finalGaid, async () => result.freshXUserToken).catch(() => {
    });
  }
  if (result.data !== null) {
    return result.data;
  }
  if (result.authFailure) {
    console.warn(`[MovieBox] Auth failure on ${path} \u2014 invalidating token and retrying once`);
    await invalidateAuthToken(env);
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
    gaid = crypto.randomUUID();
    try {
      const finalDeviceId = deviceId;
      const finalGaid = gaid;
      authToken = await bootstrapAuthToken(env, finalDeviceId, finalGaid, async () => {
        const bootstrapResult = await attemptHostPool(
          PATHS.tabOperating,
          "GET",
          { page: 1, tabId: 0, version: "" },
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
    result = await attemptHostPool(path, method, params, bodyStr, authToken, nigeriaIp, deviceId, gaid);
    return result.data;
  }
  return null;
}

// src/index.ts
var ALLOWED_SUBJECT_TYPES = /* @__PURE__ */ new Set([1, 2, 7]);
function resolveSubjectType(subjectType) {
  if (subjectType === 2) return "tv";
  if (subjectType === 7) return "shorts";
  return "movie";
}
function isNonEnglishDub(title) {
  return /\[.*(hindi|tamil|telugu|malayalam|kannada|spanish|french|german|dub|latino|korean|japanese|arabic|urdu|bengali|portuguese|italian|russian|chinese|thai|indonesian|filipino).*\]/i.test(title);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}
function isAuthorized(request, env) {
  const secret = request.headers.get("X-Worker-Secret");
  return !!secret && secret === env.MOVIEBOX_SECRET;
}
var LANGUAGE_NAMES = {
  en: "English",
  fr: "Fran\xE7ais",
  ar: "Arabic",
  zh: "Chinese",
  ru: "Russian",
  pt: "Portugu\xEAs",
  es: "Spanish",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  it: "Italian",
  sw: "Kiswahili",
  ha: "Hausa",
  ms: "Malay",
  bn: "Bengali",
  ur: "Urdu",
  pa: "Punjabi",
  fil: "Filipino",
  id: "Indonesian"
};
var RESOLUTIONS = [360, 480, 720, 1080];
async function fetchResourcePack(env, subjectId, se = 0, ep = 0) {
  const seenResourceIds = /* @__PURE__ */ new Set();
  const allItems = [];
  const perPage = 10;
  const promises = RESOLUTIONS.map(async (resolution) => {
    let page = 1;
    const resItems = [];
    while (true) {
      const data = await fetchWithHostPool(
        env,
        PATHS.resource,
        "GET",
        { subjectId, se, ep, resolution, page, perPage }
      );
      if (!data?.list?.length) break;
      for (const item of data.list) {
        resItems.push(item);
      }
      if (!data.pager?.hasMore) break;
      page++;
      if (page > 100) break;
    }
    return resItems;
  });
  const results = await Promise.all(promises);
  for (const resItems of results) {
    for (const item of resItems) {
      if (!seenResourceIds.has(item.resourceId)) {
        seenResourceIds.add(item.resourceId);
        allItems.push(item);
      }
    }
  }
  if (!allItems.length) return null;
  return allItems.sort((a, b) => b.resolution - a.resolution);
}
function mapResourceItem(item) {
  const sizeMb = item.size ? `${Math.round(parseInt(item.size) / (1024 * 1024))} MB` : null;
  const captions = (item.extCaptions || []).map((cap) => ({
    language: cap.lanName || LANGUAGE_NAMES[cap.lan] || cap.lan,
    language_code: cap.lan,
    url: cap.url
  }));
  return {
    quality: `${item.resolution}p`,
    resolution: item.resolution,
    url: item.resourceLink,
    format: "mp4",
    size: sizeMb,
    codecName: item.codecName ?? null,
    duration: item.duration ?? null,
    captions,
    se: item.se,
    ep: item.ep
  };
}
var H5_HOSTS = [
  "https://netnaija.film",
  "https://h5.aoneroom.com",
  "https://moviebox.pk"
];
var H5_PATH = "/wefeed-h5-bff/web/home";
async function fetchH5Home(nigeriaIp) {
  const forwardedIp = nigeriaIp || "197.210.65.1";
  for (const base of H5_HOSTS) {
    try {
      const response = await fetch(`${base}${H5_PATH}`, {
        method: "GET",
        headers: {
          "X-Client-Info": '{"timezone":"Africa/Lagos"}',
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
          "Referer": `${base}/`,
          "X-Forwarded-For": forwardedIp
        },
        signal: AbortSignal.timeout(12e3)
      });
      if (!response.ok) {
        console.warn(`[H5] Host ${base} returned ${response.status} \u2014 trying next`);
        continue;
      }
      const data = await response.json();
      if (data.code === 0 && data.data) {
        return data.data;
      }
      console.warn(`[H5] Host ${base} returned API code ${data.code} \u2014 trying next`);
    } catch (e) {
      console.warn(`[H5] Host ${base} failed: ${e} \u2014 trying next`);
    }
  }
  console.error("[H5] All hosts exhausted");
  return null;
}
function normalizeH5Subject(item) {
  const rawDuration = item.duration;
  const runtimeMinutes = rawDuration && rawDuration > 0 ? Math.round(rawDuration / 60) : null;
  return {
    subjectId: item.subjectId,
    subjectType: item.subjectType,
    type: resolveSubjectType(item.subjectType),
    title: item.title,
    description: item.description ?? "",
    releaseDate: item.releaseDate ?? null,
    runtime: runtimeMinutes,
    genre: item.genre ?? null,
    poster: item.cover?.url ?? null,
    thumbnail: item.cover?.thumbnail ?? "",
    country: item.countryName ?? null,
    rating: item.imdbRatingValue && item.imdbRatingValue !== "0" ? parseFloat(item.imdbRatingValue) : null,
    hasResource: item.hasResource ?? false,
    language: item.language ?? null
  };
}
function handleRoot() {
  return json({
    name: "Sp\xFCn MovieBox API",
    description: "An unofficial REST API built by Sp\xFCn for MovieBox \u2014 wrapping the MovieBox Android & H5 APIs with host pool fallback, request signing, and structured responses.",
    version: "1.1.0",
    routes: [
      { method: "GET", path: "/", auth: false, description: "API info and route listing" },
      { method: "GET", path: "/health", auth: false, description: "Worker health check" },
      { method: "POST", path: "/search", auth: true, description: "Search for movies, TV shows, and shorts. Body: { keyword, page?, perPage? }" },
      { method: "GET", path: "/info/:subjectId", auth: true, description: "Get detail for a subject" },
      { method: "GET", path: "/season/:subjectId", auth: true, description: "Get season and episode structure for a TV show or shorts series" },
      { method: "GET", path: "/stream/:subjectId", auth: true, description: "Stream URLs for a specific episode. Params: se (season), ep (episode). Use se=0&ep=0 for movies." },
      { method: "GET", path: "/stream/:subjectId/all", auth: true, description: "All stream URLs for all episodes grouped by episode. Useful for shorts and full series bulk fetch." },
      { method: "GET", path: "/download/:subjectId", auth: true, description: "Full download pack grouped by season \u2192 episode \u2192 quality" },
      { method: "GET", path: "/home", auth: true, description: "MovieBox homepage rows with subjects (Africa/Lagos feed)" },
      { method: "GET", path: "/home/rows", auth: true, description: "All homepage row titles and opIds \u2014 use to discover rows before fetching subjects" },
      { method: "GET", path: "/home/subjects?opId=X", auth: true, description: "Subjects for a specific homepage row by opId" }
    ]
  });
}
async function handleSearch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }
  const keyword = body.keyword;
  if (!keyword?.trim()) return err("keyword is required");
  const page = Number(body.page ?? 1);
  const perPage = Number(body.perPage ?? 20);
  const data = await fetchWithHostPool(
    env,
    PATHS.search,
    "POST",
    void 0,
    { keyword, page, perPage, subjectType: 0 }
  );
  if (!data) return json({ items: [], pager: null });
  const items = (data.items || []).filter((item) => ALLOWED_SUBJECT_TYPES.has(item.subjectType)).filter((item) => !isNonEnglishDub(item.title)).map((item) => ({
    subjectId: item.subjectId,
    subjectType: item.subjectType,
    title: item.title,
    description: item.description ?? "",
    releaseDate: item.releaseDate ?? null,
    duration: item.duration ?? null,
    genre: item.genre ?? null,
    poster: item.cover?.url ?? null,
    thumbnail: item.cover?.thumbnail ?? null,
    country: item.countryName ?? null,
    rating: item.imdbRatingValue && item.imdbRatingValue !== "0" ? parseFloat(item.imdbRatingValue) : null,
    language: item.language ?? null,
    type: resolveSubjectType(item.subjectType)
  }));
  return json({ items, pager: data.pager });
}
async function handleInfo(subjectId, env) {
  const data = await fetchWithHostPool(
    env,
    PATHS.get,
    "GET",
    { subjectId }
  );
  if (!data?.subjectId) return err("Not found", 404);
  const staffList = data.staffList || [];
  const rawDuration = data.duration;
  let runtimeMinutes = null;
  if (typeof rawDuration === "number") {
    runtimeMinutes = Math.round(rawDuration / 60);
  } else if (typeof rawDuration === "string") {
    const hMatch = rawDuration.match(/(\d+)h/);
    const mMatch = rawDuration.match(/(\d+)m/);
    const h = hMatch ? parseInt(hMatch[1]) : 0;
    const m = mMatch ? parseInt(mMatch[1]) : 0;
    runtimeMinutes = h * 60 + m || null;
  }
  return json({
    subjectId: data.subjectId,
    subjectType: data.subjectType,
    type: resolveSubjectType(data.subjectType),
    title: data.title,
    description: data.description ?? "",
    releaseDate: data.releaseDate ?? null,
    runtime: runtimeMinutes,
    genre: data.genre ?? null,
    poster: data.cover?.url ?? null,
    country: data.countryName ?? null,
    rating: data.imdbRatingValue && data.imdbRatingValue !== "0" ? parseFloat(data.imdbRatingValue) : null,
    hasResource: data.hasResource ?? false,
    language: data.language ?? null,
    staff: staffList.map((s) => ({
      name: s.name,
      role: s.role,
      avatar: s.avatar?.url ?? null
    }))
  });
}
async function handleSeason(subjectId, env) {
  const data = await fetchWithHostPool(
    env,
    PATHS.seasonInfo,
    "GET",
    { subjectId }
  );
  if (!data?.seasons?.length) return json({ seasons: [] });
  return json({
    seasons: data.seasons.map((s) => {
      const bestEpCount = s.resolutions?.length ? Math.max(...s.resolutions.map((r) => r.epNum)) : s.maxEp;
      return {
        season: s.se,
        totalEpisode: s.maxEp,
        episodesAvailable: bestEpCount,
        resolutions: s.resolutions || [],
        episodes: Array.from({ length: s.maxEp }, (_, i) => ({
          episode: i + 1,
          title: null,
          releaseDate: null
        }))
      };
    })
  });
}
async function handleStream(subjectId, se, ep, env) {
  const pack = await fetchResourcePack(env, subjectId, se, ep);
  if (!pack) return err("No streams available", 404);
  const isMovie = se === 0 && ep === 0;
  let items = pack;
  if (!isMovie) {
    const filtered = pack.filter((r) => r.se === se && r.ep === ep);
    if (!filtered.length) return err("No streams available for this episode", 404);
    items = filtered;
  }
  const seenQualities = /* @__PURE__ */ new Set();
  const streams = items.filter((item) => {
    const q = `${item.resolution}p`;
    if (seenQualities.has(q)) return false;
    seenQualities.add(q);
    return true;
  }).map(mapResourceItem);
  return json({ streams, total: streams.length });
}
async function handleStreamAll(subjectId, env) {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err("No streams available", 404);
  const seasonMap = /* @__PURE__ */ new Map();
  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;
    if (!seasonMap.has(seKey)) seasonMap.set(seKey, /* @__PURE__ */ new Map());
    const epMap = seasonMap.get(seKey);
    if (!epMap.has(epKey)) epMap.set(epKey, []);
    const streams = epMap.get(epKey);
    const q = `${item.resolution}p`;
    if (!streams.find((x) => x.quality === q)) {
      streams.push(mapResourceItem(item));
    }
  }
  const seasons = [...seasonMap.entries()].sort(([a], [b]) => a - b).map(([seasonNum, epMap]) => ({
    season: seasonNum,
    episodes: [...epMap.entries()].sort(([a], [b]) => a - b).map(([epNum, streams]) => ({
      episode: epNum,
      streams,
      total: streams.length
    }))
  }));
  return json({ seasons, total_seasons: seasons.length });
}
async function handleDownload(subjectId, env) {
  const pack = await fetchResourcePack(env, subjectId);
  if (!pack) return err("No downloads available", 404);
  const seasonMap = /* @__PURE__ */ new Map();
  for (const item of pack) {
    const seKey = item.se;
    const epKey = item.ep;
    if (!seasonMap.has(seKey)) seasonMap.set(seKey, /* @__PURE__ */ new Map());
    const epMap = seasonMap.get(seKey);
    if (!epMap.has(epKey)) epMap.set(epKey, []);
    const qualities = epMap.get(epKey);
    const q = `${item.resolution}p`;
    if (!qualities.find((x) => x.quality === q)) {
      qualities.push(mapResourceItem(item));
    }
  }
  const seasons = [...seasonMap.entries()].sort(([a], [b]) => a - b).map(([seasonNum, epMap]) => ({
    season: seasonNum,
    episodes: [...epMap.entries()].sort(([a], [b]) => a - b).map(([epNum, qualities]) => ({
      episode: epNum,
      qualities
    }))
  }));
  return json({ seasons, total_seasons: seasons.length });
}
async function handleHomeRows(env) {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err("Failed to fetch homepage", 502);
  const rows = (data.operatingList || []).map((row) => ({
    title: row.title,
    opId: row.opId
  }));
  return json({ total: rows.length, rows });
}
async function handleHome(env) {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err("Failed to fetch homepage", 502);
  const rows = (data.operatingList || []).map((row) => ({
    title: row.title,
    opId: row.opId,
    type: row.type,
    total: (row.subjects || []).length,
    subjects: (row.subjects || []).filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType)).filter((s) => !isNonEnglishDub(s.title)).map(normalizeH5Subject)
  }));
  return json({ total: rows.length, rows });
}
async function handleHomeSubjects(opId, env) {
  const data = await fetchH5Home(env.NIGERIA_IP);
  if (!data) return err("Failed to fetch homepage", 502);
  const row = (data.operatingList || []).find((r) => r.opId === opId);
  if (!row) return err("Row not found", 404);
  const subjects = (row.subjects || []).filter((s) => ALLOWED_SUBJECT_TYPES.has(s.subjectType)).filter((s) => !isNonEnglishDub(s.title)).map(normalizeH5Subject);
  return json({
    opId: row.opId,
    title: row.title,
    total: subjects.length,
    subjects
  });
}
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Worker-Secret"
        }
      });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/" && request.method === "GET") {
      return handleRoot();
    }
    if (path === "/health" && request.method === "GET") {
      return json({ status: "ok", worker: "moviebox-worker", ts: Date.now() });
    }
    if (path === "/debug-sig" && request.method === "GET") {
      const ts = 1782346250180;
      const method = "GET";
      const accept = "application/json";
      const contentType = "application/json";
      const url2 = "https://api6.aoneroom.com/wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=";
      const body = null;
      const { generateSignature: generateSignature2 } = await Promise.resolve().then(() => (init_signing(), signing_exports));
      const sig = await generateSignature2(method, accept, contentType, url2, body, ts);
      return json({ signature: sig });
    }
    if (!isAuthorized(request, env)) {
      return err("Unauthorized", 401);
    }
    if (path === "/search" && request.method === "POST") {
      return handleSearch(request, env);
    }
    const infoMatch = path.match(/^\/info\/([^/]+)$/);
    if (infoMatch && request.method === "GET") {
      return handleInfo(infoMatch[1], env);
    }
    const seasonMatch = path.match(/^\/season\/([^/]+)$/);
    if (seasonMatch && request.method === "GET") {
      return handleSeason(seasonMatch[1], env);
    }
    const streamAllMatch = path.match(/^\/stream\/([^/]+)\/all$/);
    if (streamAllMatch && request.method === "GET") {
      return handleStreamAll(streamAllMatch[1], env);
    }
    const streamMatch = path.match(/^\/stream\/([^/]+)$/);
    if (streamMatch && request.method === "GET") {
      const se = parseInt(url.searchParams.get("se") ?? "0");
      const ep = parseInt(url.searchParams.get("ep") ?? "0");
      return handleStream(streamMatch[1], se, ep, env);
    }
    const downloadMatch = path.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === "GET") {
      return handleDownload(downloadMatch[1], env);
    }
    if (path === "/home/rows" && request.method === "GET") {
      return handleHomeRows(env);
    }
    if (path === "/home/subjects" && request.method === "GET") {
      const opId = url.searchParams.get("opId");
      if (!opId) return err("opId is required");
      return handleHomeSubjects(opId, env);
    }
    if (path === "/home" && request.method === "GET") {
      return handleHome(env);
    }
    return err("Not found", 404);
  }
};
export {
  index_default as default
};
