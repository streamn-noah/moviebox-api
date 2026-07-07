// scratch/compare_crypto.js
import crypto from 'crypto';

const SECRET_KEY_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';

function b64Decode(value) {
  return Buffer.from(value, 'base64');
}

function b64Encode(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function md5HexNode(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function hmacMd5Node(keyBytes, message) {
  return crypto.createHmac('md5', keyBytes).update(message).digest();
}

// Web Crypto equivalents
async function md5HexWeb(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await globalThis.crypto.subtle.digest('MD5', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacMd5Web(keyBytes, message) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'MD5' },
    false,
    ['sign']
  );
  return globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

async function run() {
  const ts = 1782346250180;
  const method = 'GET';
  const accept = 'application/json';
  const contentType = 'application/json';
  const url = 'https://api6.aoneroom.com/wefeed-mobile-bff/tab-operating?page=1&tabId=0&version=';
  const body = null;

  // Canonical String
  const u = new URL(url);
  const path = u.pathname;
  const query = [...u.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalUrl = query ? `${path}?${query}` : path;
  
  const canonical = [method.toUpperCase(), accept, contentType, '', ts, '', canonicalUrl].join('\n');

  console.log('Canonical String:\n' + canonical.replace(/\n/g, '\\n') + '\n');

  // Node Signature
  const secretBytes = b64Decode(SECRET_KEY_B64);
  const macNode = hmacMd5Node(secretBytes, canonical);
  const sigNode = `${ts}|2|${b64Encode(macNode)}`;
  console.log('Node Signature: ', sigNode);

  // Web Crypto Signature
  const macWeb = await hmacMd5Web(secretBytes, canonical);
  const sigWeb = `${ts}|2|${b64Encode(macWeb)}`;
  console.log('Web Signature:  ', sigWeb);

  console.log('Match?', sigNode === sigWeb);
}

run();
