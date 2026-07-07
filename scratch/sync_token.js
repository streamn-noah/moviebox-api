// scratch/sync_token.js
import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';

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

function makeClientInfo(customDeviceId, customGaid) {
  const deviceId = customDeviceId || crypto.randomBytes(16).toString('hex');
  const gaid = customGaid || crypto.randomUUID();

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

async function request(path, method, params, bodyObj, authToken, deviceId, gaid) {
  const ts = Date.now();
  const accept = 'application/json';
  const contentType = bodyObj !== null ? 'application/json; charset=utf-8' : 'application/json';
  const bodyStr = bodyObj !== null ? JSON.stringify(bodyObj) : null;

  // Try each host in order
  for (const base of HOST_POOL) {
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const urlStr = url.toString();
    const token = generateClientToken(ts);
    const signature = generateSignature(method, accept, contentType, urlStr, bodyStr, ts);

    const headers = {
      'User-Agent':      'com.community.oneroom/50020044 (Linux; U; Android 13; en_US; 23078RKD5C; Build/TQ2A.230405.003; Cronet/135.0.7012.3)',
      'Accept':          accept,
      'Content-Type':    contentType,
      'Connection':      'keep-alive',
      'X-Client-Token':  token,
      'x-tr-signature':  signature,
      'X-Client-Info':   makeClientInfo(deviceId, gaid),
      'X-Client-Status': '0',
      'X-Play-Mode':     '2',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      const response = await fetch(urlStr, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(10000)
      });

      if (response.status === 200) {
        const resBody = await response.json();
        const xUser = response.headers.get('x-user');
        return { status: 200, xUser, body: resBody };
      }
      console.warn(`Host ${base} returned status ${response.status}`);
    } catch (err) {
      console.warn(`Host ${base} failed: ${err.message}`);
    }
  }
  throw new Error('All hosts failed');
}

async function run() {
  try {
    const deviceId = crypto.randomBytes(16).toString('hex');
    const gaid = crypto.randomUUID();

    // Get local public IP to align X-Forwarded-For in the Cloudflare Worker
    let bootstrapIp = '197.210.65.1';
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json').then(r => r.json());
      if (ipRes && ipRes.ip) {
        bootstrapIp = ipRes.ip;
        console.log(`Detected local public IP: ${bootstrapIp}`);
      }
    } catch (e) {
      console.warn('Failed to detect local public IP, using fallback:', e.message);
    }

    console.log('1. Bootstrapping token from local residential IP...');
    const boot = await request('/wefeed-mobile-bff/tab-operating', 'GET', { page: 1, tabId: 0, version: '' }, null, null, deviceId, gaid);
    
    if (boot.status !== 200 || !boot.xUser) {
      console.error('Bootstrap failed!', boot);
      return;
    }

    const userData = JSON.parse(boot.xUser);
    const token = userData.token;
    console.log('Successfully obtained token!');

    // Structure matches CachedToken interface in signing.ts (expiresAtSeconds set to max 32-bit int)
    const kvValue = JSON.stringify({
      token: token,
      expiresAtSeconds: 2147483647,
      deviceId: deviceId,
      gaid: gaid,
      bootstrapIp: bootstrapIp
    });

    const tempPath = './scratch/kv_val.json';
    fs.writeFileSync(tempPath, kvValue);

    console.log('\n2. Syncing token to Local KV namespace...');
    try {
      execSync(`npx wrangler kv key put --binding MOVIEBOX_SESSION_KV "mobile_auth_token" --path ${tempPath}`, { stdio: 'inherit' });
      console.log('✨ Local KV updated successfully!');
    } catch (e) {
      console.error('Failed to update Local KV:', e.message);
    }

    console.log('\n3. Syncing token to Production Cloudflare KV namespace...');
    try {
      execSync(`npx wrangler kv key put --binding MOVIEBOX_SESSION_KV "mobile_auth_token" --path ${tempPath} --remote`, { stdio: 'inherit' });
      console.log('✨ Production Cloudflare KV updated successfully!');
    } catch (e) {
      console.error('Failed to update Production KV:', e.message);
    }

    console.log('\n4. Syncing token to Local JSON KV (for Node.js runner)...');
    try {
      const localStorePath = './scratch/kv_store.json';
      let store = {};
      if (fs.existsSync(localStorePath)) {
        try {
          store = JSON.parse(fs.readFileSync(localStorePath, 'utf8'));
        } catch (e) {}
      }
      store['mobile_auth_token'] = kvValue;
      fs.writeFileSync(localStorePath, JSON.stringify(store, null, 2), 'utf8');
      console.log('✨ Local JSON KV updated successfully!');
    } catch (e) {
      console.error('Failed to update Local JSON KV:', e.message);
    }

    // Clean up temp file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (err) {
    console.error('Error during run:', err);
  }
}

run();
