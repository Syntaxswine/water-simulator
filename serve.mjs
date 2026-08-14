// Static server for the browser view. No dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, normalize } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const PORT = Number(process.env.PORT) || 8750;

createServer(async (req, res) => {
  // fileURLToPath, not new URL().pathname: on Windows a path with a space in it
  // arrives percent-encoded and every read 404s.
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = join(ROOT, normalize(p).replace(/^[\/]+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, () => console.log(`water-simulator on http://localhost:${PORT}`));
