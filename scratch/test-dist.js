// src/signing.ts
import nodeCrypto from "node:crypto";
var SECRET_KEY_B64 = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
var SIGNATURE_BODY_MAX_BYTES = 102400;
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
var KV_TOKEN_KEY = "mobile_auth_token";
var KV_TTL_SECONDS = 60 * 60 * 24;
var EXPIRY_SAFETY_MARGIN_SECONDS = 300;
var _bootstrapPromise = null;
function decodeJwtExpSeconds(jwt) {
  try {
    const payloadB64 = jwt.split(".")[1];
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - padded.length % 4) % 4);
    const json = atob(padded + padding);
    const payload = JSON.parse(json);
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
async function bootstrapAuthToken(env2, deviceId, gaid, signedFetch, bootstrapIp) {
  if (!_bootstrapPromise) {
    _bootstrapPromise = (async () => {
      const token = await signedFetch();
      if (!token) {
        throw new Error("[Signing] Bootstrap failed \u2014 no x-user token received from any host");
      }
      const exp = decodeJwtExpSeconds(token);
      const expiresAtSeconds = exp ?? Math.floor(Date.now() / 1e3) + 3600;
      await writeTokenToKv(env2.MOVIEBOX_SESSION_KV, { token, expiresAtSeconds, deviceId, gaid, bootstrapIp });
      return token;
    })().finally(() => {
      _bootstrapPromise = null;
    });
  }
  return _bootstrapPromise;
}
async function getCachedAuthToken(env2) {
  const cached = await readTokenFromKv(env2.MOVIEBOX_SESSION_KV);
  if (cached && !isExpiringSoon(cached)) {
    return cached;
  }
  return null;
}
async function invalidateAuthToken(env2) {
  try {
    await env2.MOVIEBOX_SESSION_KV.delete(KV_TOKEN_KEY);
  } catch (e) {
    console.warn(`[Signing] Failed to invalidate KV token: ${e}`);
  }
}

// src/moviebox.ts
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
    } catch (err) {
      console.warn(`[MovieBox] Host ${base} failed: ${err} \u2014 trying next`);
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
async function fetchWithHostPool(env2, path, method, params, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const cached = await getCachedAuthToken(env2);
  const nigeriaIp = cached?.bootstrapIp || env2.NIGERIA_IP || "197.210.65.1";
  let authToken = cached?.token ?? null;
  let deviceId = cached?.deviceId ?? void 0;
  let gaid = cached?.gaid ?? void 0;
  if (!authToken) {
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
    gaid = crypto.randomUUID();
    try {
      const finalDeviceId = deviceId;
      const finalGaid = gaid;
      authToken = await bootstrapAuthToken(env2, finalDeviceId, finalGaid, async () => {
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
    await bootstrapAuthToken(env2, finalDeviceId, finalGaid, async () => result.freshXUserToken).catch(() => {
    });
  }
  if (result.data !== null) {
    return result.data;
  }
  if (result.authFailure) {
    console.warn(`[MovieBox] Auth failure on ${path} \u2014 invalidating token and retrying once`);
    await invalidateAuthToken(env2);
    deviceId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
    gaid = crypto.randomUUID();
    try {
      const finalDeviceId = deviceId;
      const finalGaid = gaid;
      authToken = await bootstrapAuthToken(env2, finalDeviceId, finalGaid, async () => {
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

// scratch/test.ts
var env = {
  MOVIEBOX_SECRET: "test",
  NIGERIA_IP: "197.210.65.1",
  AUTH_KV: {
    get: async () => null,
    put: async () => {
    },
    delete: async () => {
    }
  }
};
async function test() {
  console.log("Searching for Enola Holmes 3");
  const search = await fetchWithHostPool(env, PATHS.search, "POST", void 0, { keyword: "Enola Holmes 3", page: 1, perPage: 10, subjectType: 0 });
  console.log("Search Result:", JSON.stringify(search, null, 2));
  if (!search || !search.items || !search.items.length) {
    console.log("Not found in search");
    return;
  }
  const id = search.items[0].subjectId;
  console.log(`Using subjectId: ${id}`);
  console.log("\nTesting /resource with normal params");
  const res1 = await fetchWithHostPool(env, PATHS.resource, "GET", { subjectId: id, se: 0, ep: 0, resolution: 720, page: 1, perPage: 10 });
  console.log(JSON.stringify(res1, null, 2));
  console.log("\nTesting /resource with lang=en");
  const res2 = await fetchWithHostPool(env, PATHS.resource, "GET", { subjectId: id, se: 0, ep: 0, resolution: 720, page: 1, perPage: 10, lang: "en" });
  console.log(JSON.stringify(res2, null, 2));
  console.log("\nTesting /resource with audio=en");
  const res3 = await fetchWithHostPool(env, PATHS.resource, "GET", { subjectId: id, se: 0, ep: 0, resolution: 720, page: 1, perPage: 10, audio: "en" });
  console.log(JSON.stringify(res3, null, 2));
  console.log("\nTesting /get-ext-captions");
  const cap = await fetchWithHostPool(env, PATHS.captions, "GET", { subjectId: id, se: 0, ep: 0 });
  console.log(JSON.stringify(cap, null, 2));
}
test().catch(console.error);
