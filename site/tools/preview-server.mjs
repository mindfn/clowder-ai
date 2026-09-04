/* Clowder AI — static preview server for the site studies (dev tool).
 *
 * The plate study reads the cat sprites back out of a canvas to halftone them,
 * which a file:// page is not allowed to do, so the studies need to be served
 * over http even though they are static. No caching, so an edit is one reload.
 *
 *   node site/tools/preview-server.mjs [port]
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8123);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const target = join(ROOT, normalize(path === '/' ? '/index.html' : path));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`serving ${ROOT} on http://127.0.0.1:${PORT}\n`));
