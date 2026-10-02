// Servidor local para probar SIMTEC sin Vercel: sirve los archivos y la carpeta /api.
// Uso: SIMTEC_DATA_FILE=./datos-local.json node scripts/dev-server.mjs   (puerto 3000)
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SIMTEC_DATA_FILE ||= path.join(root, 'datos-local.json');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname.startsWith('/api/') && !url.pathname.includes('_lib')) {
      const mod = await import(pathToFileURL(path.join(root, url.pathname + '.js')).href);
      const handler = mod[req.method];
      if (!handler) return send(res, 405, 'Método no permitido');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || file.includes('/api/') || file.includes('node_modules')) return send(res, 404, 'No encontrado');
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? 'No encontrado' : String(e.stack || e));
  }
}).listen(port, () => console.log(`SIMTEC en http://localhost:${port}  (datos: ${process.env.SIMTEC_DATA_FILE})`));

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
