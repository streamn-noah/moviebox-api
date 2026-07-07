// scratch/test_auth.js
import crypto from 'crypto';

const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api3.aoneroom.com',
];

const SECRET_KEY_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';

function b64Decode(value) {
  return Buffer.from(value, 'base64');
}

function b64Encode(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function hmacMd5(keyBytes, message) {
  return crypto.createHmac('md5', keyBytes).update(message).digest();
}

function generateClientToken(ts) {
  const tsStr = String(ts);
  const reversed = tsStr.split('').reverse().join('');
  const hash = md5Hex(reversed);
  return `${tsStr},${hash}`;
}

function sortedQueryString(urlStr) {
  const u = new URL(urlStr);
  const params = [];
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sorted) {
    params.push(`${key}=${value}`);
  }
  return params.join('&');
}

function buildCanonicalString(method, accept, contentType, urlStr, body, ts) {
  const u = new URL(urlStr);
  const path = u.pathname;
  const query = sortedQueryString(urlStr);
  const canonicalUrl = query ? `${path}?${query}` : path;

  let bodyHash = '';
  let bodyLength = '';

  if (body !== null) {
    bodyHash = md5Hex(body);
    bodyLength = String(Buffer.byteLength(body));
  }

  return [method.toUpperCase(), accept, contentType, bodyLength, ts, bodyHash, canonicalUrl].join(
    '\n'
  );
}

function generateSignature(method, accept, contentType, urlStr, body, ts) {
  const canonical = buildCanonicalString(method, accept, contentType, urlStr, body, ts);
  const secretBytes = b64Decode(SECRET_KEY_B64);
  const mac = hmacMd5(secretBytes, canonical);
  return `${ts}|2|${b64Encode(mac)}`;
}

function makeClientInfo() {
  const deviceId = crypto.randomBytes(16).toString('hex');
  const gaid = crypto.randomUUID();

  return JSON.stringify({
    package_name:    'com.community.oneroom',
    version_name:    '3.0.03.0529.03',
    version_code:    50020044,
    os:              'android',
    os_version:      '13',
    install_ch:      'ps',
    device_id:       deviceId,
    install_store:   'ps',
    gaid,
    brand:           'Redmi',
    model:           '23078RKD5C',
    system_language: 'en',
    net:             'NETWORK_WIFI',
    region:          'US',
    timezone:        'America/New_York',
    sp_code:         '40401',
    'X-Play-Mode':   '2',
  });
}

async function testRequest(path, params = null) {
  const ts = Date.now();
  const accept = 'application/json';
  const contentType = 'application/json';

  const base = HOST_POOL[0];
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const urlStr = url.toString();
  const token = generateClientToken(ts);
  const signature = generateSignature('GET', accept, contentType, urlStr, null, ts);

  const headers = {
    'User-Agent':      'com.community.oneroom/50020044 (Linux; U; Android 13; en_US; 23078RKD5C; Build/TQ2A.230405.003; Cronet/135.0.7012.3)',
    'Accept':          accept,
    'Content-Type':    contentType,
    'Connection':      'keep-alive',
    'X-Client-Token':  token,
    'x-tr-signature':  signature,
    'X-Client-Info':   makeClientInfo(),
    'X-Client-Status': '0',
    'X-Play-Mode':     '2',
  };

  console.log(`\nTesting: ${urlStr}`);
  try {
    const response = await fetch(urlStr, {
      method: 'GET',
      headers,
    });
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log('x-user header:', response.headers.get('x-user'));
    const body = await response.json();
    console.log('Body:', JSON.stringify(body).slice(0, 300));
  } catch (err) {
    console.error('Request failed:', err);
  }
}

async function run() {
  // Test 1: Original parameters
  await testRequest('/wefeed-mobile-bff/tab-operating', { page: 1, tabId: 0, version: '' });

  // Test 2: No parameters
  await testRequest('/wefeed-mobile-bff/tab-operating');
  
  // Test 3: Tab list (another lightweight public route)
  await testRequest('/wefeed-mobile-bff/tab/list');
}

run();
