// src/vercel_adapter.ts
// Vercel serverless function adapter — bundles the CloudFlare Worker handler
// with a residential proxy dispatcher and a /tmp-backed KV mock.
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetch as undiciFetch, setGlobalDispatcher, ProxyAgent } from 'undici';
import worker from './index';

// ─── Residential Proxy ────────────────────────────────────────────────────────
if (process.env.PROXY_URL) {
  try {
    setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
    console.log('✈️  Residential proxy configured.');
  } catch (err: unknown) {
    console.error('Proxy setup failed:', (err as Error).message);
  }
}

// ─── KV mock (memory + /tmp disk) ────────────────────────────────────────────
const memKV: Record<string, string> = {};
const KV_PATH = '/tmp/vercel_kv.json';

function readDiskKV(): Record<string, string> {
  try {
    return fs.existsSync(KV_PATH) ? JSON.parse(fs.readFileSync(KV_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

function writeDiskKV(db: Record<string, string>) {
  try { fs.writeFileSync(KV_PATH, JSON.stringify(db), 'utf8'); } catch { /* /tmp may be read-only */ }
}

const kvMock = {
  async get(key: string) {
    if (memKV[key]) return memKV[key];
    const v = readDiskKV()[key] ?? null;
    if (v) memKV[key] = v;
    return v;
  },
  async put(key: string, value: string) {
    memKV[key] = value;
    const db = readDiskKV();
    db[key] = value;
    writeDiskKV(db);
  },
  async delete(key: string) {
    delete memKV[key];
    const db = readDiskKV();
    delete db[key];
    writeDiskKV(db);
  },
};

const env = {
  MOVIEBOX_SESSION_KV: kvMock,
  MOVIEBOX_SECRET: process.env.MOVIEBOX_SECRET ?? 'local-secret-12345',
  NIGERIA_IP:       process.env.NIGERIA_IP       ?? '197.210.65.1',
  fetch:            process.env.PROXY_URL        ? undiciFetch : fetch,
};

// ─── Vercel handler ───────────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
    const host  = req.headers.host ?? 'localhost';
    const url   = `${proto}://${host}${(req as IncomingMessage & { url: string }).url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
      else if (v) headers.set(k, v);
    }

    const webReq = new Request(url, {
      method:  req.method ?? 'GET',
      headers,
      body: ['GET', 'HEAD'].includes(req.method ?? '') ? null : body,
    });

    const webRes = await worker.fetch(webReq, env as never);

    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
    });
    res.end(Buffer.from(await webRes.arrayBuffer()));
  } catch (err: unknown) {
    console.error('Handler error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}
