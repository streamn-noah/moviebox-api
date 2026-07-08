// api/index.js
import http from 'http';
import fs from 'fs';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import worker from '../scratch/dist.js';

// 1. Initialize Residential Proxy if PROXY_URL is set in environment
if (process.env.PROXY_URL) {
  try {
    const proxyAgent = new ProxyAgent(process.env.PROXY_URL);
    setGlobalDispatcher(proxyAgent);
    console.log('✈️ Global residential proxy configured successfully.');
  } catch (err) {
    console.error('Failed to configure residential proxy:', err.message);
  }
}

// 2. Vercel Memory + Disk KV cache fallback
const vercelMemoryKV = {};
const vercelKVMock = {
  async get(key) {
    if (vercelMemoryKV[key]) return vercelMemoryKV[key];
    const path = '/tmp/vercel_kv_store.json';
    if (fs.existsSync(path)) {
      try {
        const db = JSON.parse(fs.readFileSync(path, 'utf8'));
        vercelMemoryKV[key] = db[key] || null;
        return db[key] || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  },
  async put(key, value) {
    vercelMemoryKV[key] = value;
    const path = '/tmp/vercel_kv_store.json';
    let db = {};
    if (fs.existsSync(path)) {
      try {
        db = JSON.parse(fs.readFileSync(path, 'utf8'));
      } catch (e) {}
    }
    db[key] = value;
    try {
      fs.writeFileSync(path, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {}
  },
  async delete(key) {
    delete vercelMemoryKV[key];
    const path = '/tmp/vercel_kv_store.json';
    if (fs.existsSync(path)) {
      try {
        const db = JSON.parse(fs.readFileSync(path, 'utf8'));
        delete db[key];
        fs.writeFileSync(path, JSON.stringify(db, null, 2), 'utf8');
      } catch (e) {}
    }
  }
};

const env = {
  MOVIEBOX_SESSION_KV: vercelKVMock,
  MOVIEBOX_SECRET: process.env.MOVIEBOX_SECRET || 'local-secret-12345',
  NIGERIA_IP: process.env.NIGERIA_IP || '197.210.65.1'
};

// 3. Vercel Serverless Function entrypoint
export default async function handler(req, res) {
  try {
    // Read request body chunks
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // Build standard Web API Request object
    const protocol = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers.host || 'localhost';
    const url = `${protocol}://${host}${req.url}`;
    
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (Array.isArray(val)) {
        for (const v of val) {
          headers.append(key, v);
        }
      } else if (val !== undefined) {
        headers.set(key, val);
      }
    }

    const webRequest = new Request(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? null : body
    });

    // Call Cloudflare Worker handler
    const webResponse = await worker.fetch(webRequest, env);

    // Send back response headers
    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'transfer-encoding') {
        res.setHeader(name, value);
      }
    });

    // Send back response body
    const resBody = await webResponse.arrayBuffer();
    res.end(Buffer.from(resBody));
  } catch (err) {
    console.error('Error handling serverless request:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
}
