// src/signing.ts
// MovieBox Mobile API v3 request signing — Web Crypto API (Cloudflare Workers compatible)
// Ports the Python library's HMAC-MD5 signing logic to the Workers runtime.
// No Node.js crypto — uses SubtleCrypto throughout.

const SECRET_KEY_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const SIGNATURE_BODY_MAX_BYTES = 102_400;

// ─── Base64 helpers ────────────────────────────────────────────────────────────

function b64Decode(value: string): Uint8Array {
  const padding = (4 - (value.length % 4)) % 4;
  const padded = value + '='.repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function b64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// ─── MD5 via SubtleCrypto ──────────────────────────────────────────────────────
// SubtleCrypto supports MD5 in Cloudflare Workers (non-browser context)

async function md5Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('MD5', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── HMAC-MD5 ─────────────────────────────────────────────────────────────────

async function hmacMd5(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'MD5' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

// ─── Token & signature generators ─────────────────────────────────────────────

export async function generateClientToken(ts: number): Promise<string> {
  const tsStr = String(ts);
  const reversed = tsStr.split('').reverse().join('');
  const hash = await md5Hex(reversed);
  return `${tsStr},${hash}`;
}

function sortedQueryString(url: string): string {
  const u = new URL(url);
  const params: string[] = [];
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sorted) {
    params.push(`${key}=${value}`);
  }
  return params.join('&');
}

async function buildCanonicalString(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number
): Promise<string> {
  const u = new URL(url);
  const path = u.pathname;
  const query = sortedQueryString(url);
  const canonicalUrl = query ? `${path}?${query}` : path;

  let bodyHash = '';
  let bodyLength = '';

  if (body !== null) {
    const bodyBytes = new TextEncoder().encode(body);
    const truncated = bodyBytes.slice(0, SIGNATURE_BODY_MAX_BYTES);
    bodyHash = await md5Hex(truncated);
    bodyLength = String(bodyBytes.length);
  }

  return [method.toUpperCase(), accept, contentType, bodyLength, ts, bodyHash, canonicalUrl].join(
    '\n'
  );
}

export async function generateSignature(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number
): Promise<string> {
  const canonical = await buildCanonicalString(method, accept, contentType, url, body, ts);
  const secretBytes = b64Decode(SECRET_KEY_B64);
  const mac = await hmacMd5(secretBytes, canonical);
  return `${ts}|2|${b64Encode(mac)}`;
}
