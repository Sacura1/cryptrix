import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
export function createFrontendServer({
  directory = 'dist',
  backendUrl = process.env.BACKEND_URL,
  proxyToken = process.env.FRONTEND_PROXY_TOKEN,
  trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0),
} = {}) {
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 4)
    throw new Error('Invalid trusted proxy depth');
  if (proxyToken && proxyToken.length < 32)
    throw new Error('Frontend proxy credential is too short');
  const root = resolve(directory);
  const api = backendUrl ? new URL(backendUrl) : undefined;
  if (api && !['https:', 'http:'].includes(api.protocol)) throw new Error('Invalid backend URL');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.avif': 'image/avif',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
  };
  const hop = new Set([
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'x-cryptrix-proxy',
    'x-cryptrix-client-ip',
  ]);
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (path === '/api' || path.startsWith('/api/')) {
        if (!api) {
          res.writeHead(503);
          res.end('Backend is not configured');
          return;
        }
        const incoming = new URL(req.url, 'http://localhost');
        const url = new URL(api);
        url.pathname = api.pathname.replace(/\/$/, '') + (incoming.pathname.slice(4) || '/');
        url.search = incoming.search;
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (!hop.has(k) && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
        if (proxyToken) {
          const chain =
            typeof req.headers['x-forwarded-for'] === 'string'
              ? req.headers['x-forwarded-for'].split(',').map((ip) => ip.trim())
              : [];
          chain.push(req.socket.remoteAddress ?? '');
          const ip = chain[Math.max(0, chain.length - 1 - trustedProxyHops)];
          if (isIP(ip)) {
            headers.set('x-cryptrix-proxy', proxyToken);
            headers.set('x-cryptrix-client-ip', ip);
          }
        }
        const options = { method: req.method, headers, redirect: 'error', signal: abort.signal };
        if (!['GET', 'HEAD'].includes(req.method)) {
          options.body = req;
          options.duplex = 'half';
        }
        const upstream = await fetch(url, options);
        const out = {};
        upstream.headers.forEach((v, k) => {
          if (!hop.has(k) && !['content-encoding', 'content-length'].includes(k)) out[k] = v;
        });
        res.writeHead(upstream.status, out);
        if (upstream.body)
          Readable.fromWeb(upstream.body)
            .on('error', () => res.destroy())
            .pipe(res);
        else res.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      let file = resolve(root, '.' + decodeURIComponent(path));
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let info;
      try {
        info = await stat(file);
      } catch {}
      if (!info?.isFile()) {
        if (extname(path)) {
          res.writeHead(404);
          res.end();
          return;
        }
        file = resolve(root, 'index.html');
      }
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': file.endsWith('index.html')
          ? 'no-cache'
          : path.startsWith('/assets/')
            ? 'public,max-age=31536000,immutable'
            : 'public,max-age=3600',
      });
      if (req.method === 'HEAD') res.end();
      else
        createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end('Connection unavailable');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  createFrontendServer().listen(Number(process.env.PORT ?? 8000), '0.0.0.0');
