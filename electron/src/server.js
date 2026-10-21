'use strict';
// Local server the window loads. It serves the built web UI and forwards the
// control API to the engine with the token attached in the main process, so
// the token never reaches renderer JavaScript.
const fs = require('fs');
const http = require('http');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function isApi(pathname) {
  return pathname === '/events' || pathname.startsWith('/api/');
}

function forward(req, res, { controlPort, token }) {
  const headers = { ...req.headers, 'x-charles-token': token };
  delete headers.host;
  delete headers.origin;

  const up = http.request(
    { host: '127.0.0.1', port: controlPort, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'engine unreachable' }));
  });
  // Stop the upstream request when the browser goes away (closes SSE, etc.).
  res.on('close', () => up.destroy());
  req.pipe(up);
}

function serveStatic(res, uiDir, pathname) {
  const root = path.resolve(uiDir);
  let file = path.resolve(root, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let stat = null;
  try { stat = fs.statSync(file); } catch (_) { stat = null; }
  if (!stat || stat.isDirectory()) file = path.join(root, 'index.html'); // SPA fallback

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/**
 * Starts the UI server on 127.0.0.1 with an ephemeral port.
 * Requests whose Origin is not this server are refused, so a web page open in
 * the user's browser cannot drive the API through this port.
 */
function startUiServer({ uiDir, controlPort, token }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const self = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.origin && req.headers.origin !== self) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (isApi(pathname)) return forward(req, res, { controlPort, token });
      return serveStatic(res, uiDir, pathname);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

module.exports = { startUiServer };
