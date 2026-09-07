// Local map preview: static files plus three read-only production API routes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('prototype');
const api = new Set(['/events', '/observations', '/fire-weather']);
const cache = new Map();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.geojson': 'application/geo+json', '.css': 'text/css' };
createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (api.has(url.pathname)) {
      let entry = cache.get(url.pathname);
      if (!entry || Date.now() - entry.at > 30000) {
        const r = await fetch(`https://geospatial-platform.diegoromero.es${url.pathname}`, { signal: AbortSignal.timeout(20000) });
        entry = { at: Date.now(), status: r.status, body: await r.text() };
        if (r.ok) cache.set(url.pathname, entry);
      }
      res.writeHead(entry.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(entry.body);
      return;
    }
    const name = decodeURIComponent(url.pathname).replace(/^\/mapa\/?/, '/');
    const file = resolve(root, `.${name.endsWith('/') ? name + 'index.html' : name}`);
    if (!file.startsWith(root + sep) || /(?:^|\/)\./.test(name)) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(502).end('Preview resource unavailable'); }
}).listen(8000, '127.0.0.1', () => console.log('Map preview: http://127.0.0.1:8000/mapa/'));
