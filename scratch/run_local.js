// scratch/run_local.js
import http from 'http';
import fs from 'fs';
import worker from './dist.js';

const PORT = 8787;

// Mock KV Namespace using local JSON file
const kvMock = {
  async get(key) {
    const storePath = './scratch/kv_store.json';
    if (fs.existsSync(storePath)) {
      try {
        const db = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        return db[key] || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  },
  async put(key, value) {
    const storePath = './scratch/kv_store.json';
    let db = {};
    if (fs.existsSync(storePath)) {
      try {
        db = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      } catch (e) {}
    }
    db[key] = value;
    fs.writeFileSync(storePath, JSON.stringify(db, null, 2), 'utf8');
  },
  async delete(key) {
    const storePath = './scratch/kv_store.json';
    if (fs.existsSync(storePath)) {
      try {
        const db = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        delete db[key];
        fs.writeFileSync(storePath, JSON.stringify(db, null, 2), 'utf8');
      } catch (e) {}
    }
  }
};

const env = {
  MOVIEBOX_SESSION_KV: kvMock,
  MOVIEBOX_SECRET: 'local-secret-12345',
  NIGERIA_IP: '105.113.77.237'
};

const server = http.createServer(async (req, res) => {
  try {
    // Read request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // Build Web API Request object
    const protocol = req.socket.encrypted ? 'https' : 'http';
    const host = req.headers.host || `localhost:${PORT}`;
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
    console.error('Error handling request:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 MovieBox API Local Node.js Server running at http://127.0.0.1:${PORT}`);
  console.log(`   (Successfully bypassed Cloudflare workerd sandbox and TLS fingerprinting blocks!)\n`);
});
