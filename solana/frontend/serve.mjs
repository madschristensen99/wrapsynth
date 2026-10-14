// serve.mjs — static server for the devnet frontend.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 8080;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css' };
http.createServer((req, res) => {
  const p = path.normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  const f = path.join(dir, p === '/' ? 'index.html' : p);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(d);
  });
}).listen(port, () => console.log(`frontend on http://localhost:${port}`));
