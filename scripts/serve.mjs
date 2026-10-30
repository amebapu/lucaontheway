import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = {
  'index.html': 'text/html; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'app.mjs': 'text/javascript; charset=utf-8',
  'feed.mjs': 'text/javascript; charset=utf-8',
  'feed.json': 'application/json; charset=utf-8',
  'archive.mjs': 'text/javascript; charset=utf-8',
  'archive.json': 'application/json; charset=utf-8',
  'capacity.mjs': 'text/javascript; charset=utf-8',
};
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const name = path === '/' ? 'index.html' : path.slice(1);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!Object.hasOwn(files, name)) { response.writeHead(404); response.end(); return; }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const body = await readFile(new URL(`../dist/${name}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': files[name] });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(8787, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:8787/'));
process.on('SIGINT', () => server.close());
