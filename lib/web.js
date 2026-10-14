'use strict';
/**
 * web.js — the GUI, served over HTTP. Charles is a Swing desktop app; we render
 * the same session-table + inspector as a browser UI and push live updates over
 * Server-Sent Events (the store's event bus -> SSE). This mirrors the
 * gui/session tree + gui/transaction inspector split in charles.jar.
 */
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Root CA identity: subject + sha256 fingerprint via openssl, trust via security. */
function caInfo(ca) {
  const info = { path: ca.crtPath, subject: null, fingerprint: null, fingerprintHex: null, trusted: false };
  try {
    const out = execFileSync('openssl', ['x509', '-in', ca.crtPath, '-noout', '-fingerprint', '-sha256', '-subject'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (line.startsWith('subject=')) info.subject = line.slice('subject='.length).trim();
      const m = /Fingerprint=([0-9A-Fa-f:]+)/.exec(line);
      if (m) { info.fingerprint = m[1].toUpperCase(); info.fingerprintHex = m[1].replace(/:/g, '').toLowerCase(); }
    }
  } catch (_) {}
  try {
    execFileSync('security', ['verify-cert', '-c', ca.crtPath, '-p', 'ssl'], { stdio: ['ignore', 'ignore', 'ignore'] });
    info.trusted = true;
  } catch (_) { info.trusted = false; }
  return info;
}

function loginKeychain() {
  return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    const c = []; req.on('data', (d) => c.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (_) { resolve({}); } });
  });
}

class WebServer {
  constructor({ store, tools, ca, config, token = null }) {
    this.store = store; this.tools = tools; this.ca = ca; this.config = config;
    this.token = token;
    this.clients = new Set();
    this.server = http.createServer((req, res) => this._route(req, res));
    this._wireStore();
  }

  _wireStore() {
    const push = (event, data) => {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of this.clients) { try { c.write(payload); } catch (_) {} }
    };
    this.store.on('tx:new', (s) => push('tx', s));
    this.store.on('tx:update', (s) => push('tx', s));
    this.store.on('clear', () => push('clear', {}));
    this.store.on('recording', (on) => push('recording', { on }));
  }

  listen(port, host, cb) { this.server.listen(port, host, cb); return this.server; }

  async _route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // Access control for the control API when a token is configured.
    if (this.token && (p === '/events' || p.startsWith('/api/'))) {
      const provided = req.headers['x-charles-token'] || url.searchParams.get('token');
      if (provided !== this.token) return json(res, 401, { error: 'unauthorized' });
    }

    if (p === '/events') return this._sse(req, res);
    if (p === '/api/transactions') return json(res, 200, this.store.list());
    if (p.startsWith('/api/transaction/')) {
      const id = p.split('/').pop();
      const tx = this.store.get(id);
      return tx ? json(res, 200, tx.detail()) : json(res, 404, { error: 'not found' });
    }
    if (p === '/api/clear' && req.method === 'POST') { this.store.clear(); return json(res, 200, { ok: true }); }
    if (p === '/api/recording' && req.method === 'POST') {
      const b = await readBody(req); this.store.setRecording(!!b.on); return json(res, 200, { on: this.store.recording });
    }
    if (p === '/api/config') {
      if (req.method === 'GET') return json(res, 200, this.config);
      if (req.method === 'POST') {
        const b = await readBody(req);
        Object.assign(this.config, b);
        this.tools.config = this.config;
        this.tools.enabled = this.config.enabled || {};
        this.config._persist && this.config._persist();
        return json(res, 200, { ok: true });
      }
    }
    if (p === '/api/ca') {
      return json(res, 200, caInfo(this.ca));
    }
    if (p === '/api/ca/trust' && req.method === 'POST') {
      // User-initiated: add the root CA to the login keychain as a trusted root.
      // macOS may prompt for authorization (SecurityAgent).
      try {
        const out = execFileSync('security', ['add-trusted-cert', '-r', 'trustRoot',
          '-k', loginKeychain(), this.ca.crtPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return json(res, 200, { ok: true, output: out || '' });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.stderr || e.message || e) });
      }
    }
    if (p === '/api/ca.pem') return send(res, 200, 'application/x-pem-file', this.ca.rootCertPem());
    if (p === '/api/import/charles' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const { importCharles } = require('./import-charles');
        const r = importCharles(b && b.path ? b.path : undefined, this.config);
        this.tools.config = this.config;
        this.tools.enabled = this.config.enabled || {};
        this.config._persist && this.config._persist();
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (p === '/api/status') return json(res, 200, {
      proxyPort: this.config.proxyPort, webPort: this.config.webPort,
      recording: this.store.recording, count: this.store.order.length,
      leafCertsGenerated: this.ca.generated,
      sslLocations: this.config.sslLocations || [],
      enabled: this.tools.enabled,
    });

    // The native app (Louie) is the only UI now; the server is API-only.
    return json(res, 404, { error: 'not found' });
  }

  _sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ count: this.store.order.length })}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }
}

module.exports = { WebServer };
