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

/** LAN IPv4 address (first non-internal), or null. */
function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

/** Root cert as DER bytes (for Android's .cer). */
function caDer(ca) {
  return execFileSync('openssl', ['x509', '-in', ca.crtPath, '-outform', 'der'], { encoding: 'buffer' });
}

/** Apple configuration profile embedding the trusted root certificate. */
function caMobileConfig(ca, payloadName) {
  const b64 = caDer(ca).toString('base64');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>louie-ca.cer</string>
      <key>PayloadContent</key><data>${b64}</data>
      <key>PayloadDescription</key><string>Louie root CA for HTTPS debugging.</string>
      <key>PayloadDisplayName</key><string>Louie Root CA</string>
      <key>PayloadIdentifier</key><string>local.louie.ca</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${'L0UIE000-0000-4000-8000-000000000001'}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>${payloadName || 'Louie Root CA'}</string>
  <key>PayloadIdentifier</key><string>local.louie.profile</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>L0UIE000-0000-4000-8000-000000000002</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>`;
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
  constructor({ store, tools, ca, config, token = null, sessionLog = null, proxy = null }) {
    this.store = store; this.tools = tools; this.ca = ca; this.config = config;
    this.token = token; this.sessionLog = sessionLog; this.proxy = proxy;
    this.caServer = null;
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

  /**
   * Serves ONLY the public root certificate (DER + Apple profile) so a phone can
   * install it. Never serves ca.key. Started on demand and stopped when the CA
   * panel closes.
   */
  _startCAServer(cb) {
    if (this.caServer) { if (cb) cb(); return; }
    const host = this.config.lanEnabled ? '0.0.0.0' : '127.0.0.1';
    const port = this.config.caServePort ?? 8890;
    this.caServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/ca.cer') {
        try { return send(res, 200, 'application/x-x509-ca-cert', caDer(this.ca)); } catch (_) { return send(res, 500, 'text/plain', 'ca error'); }
      }
      if (u.pathname === '/ca.mobileconfig') {
        try { return send(res, 200, 'application/x-apple-aspen-config', Buffer.from(caMobileConfig(this.ca, 'Louie Root CA'))); } catch (_) { return send(res, 500, 'text/plain', 'ca error'); }
      }
      return send(res, 404, 'text/plain', 'not found');
    });
    this.caServer.on('error', () => { this.caServer = null; if (cb) cb(); });
    this.caServer.on('listening', () => { if (cb) cb(); });
    this.caServer.listen(port, host);
  }

  _stopCAServer() {
    if (!this.caServer) return;
    try { this.caServer.close(); } catch (_) {}
    this.caServer = null;
  }

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

    // Pin a single call as a read-only copy for the MCP server.
    const saveMatch = /^\/api\/transaction\/(\d+)\/save$/.exec(p);
    if (saveMatch && req.method === 'POST') {
      if (!this.sessionLog) return json(res, 500, { ok: false, error: 'session log unavailable' });
      const tx = this.store.get(saveMatch[1]);
      if (!tx) return json(res, 404, { ok: false, error: 'not found' });
      const b = await readBody(req);
      const big = this.sessionLog.oversized(tx);
      if (big && b.full === undefined) {
        return json(res, 200, { ok: false, needsConfirm: true, size: big, cap: this.sessionLog.maxBodyBytes });
      }
      const r = this.sessionLog.save(tx, { full: !!b.full });
      return json(res, 200, { ok: true, ...r });
    }

    if (p === '/api/saved') return json(res, 200, this.sessionLog ? this.sessionLog.listSaved() : []);
    if (p.startsWith('/api/saved/')) {
      const name = decodeURIComponent(p.slice('/api/saved/'.length));
      const rec = this.sessionLog && this.sessionLog.getSaved(name);
      return rec ? json(res, 200, rec) : json(res, 404, { error: 'not found' });
    }
    if (p === '/api/persist') {
      if (req.method === 'GET') {
        return json(res, 200, {
          enabled: !!(this.config.persist && this.config.persist.enabled),
          dir: this.sessionLog ? this.sessionLog.dir : null,
          maxBodyBytes: this.sessionLog ? this.sessionLog.maxBodyBytes : 0,
          retentionDays: this.sessionLog ? this.sessionLog.retentionDays : 0,
        });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        this.config.persist = { ...(this.config.persist || {}), ...b };
        if (this.sessionLog) this.sessionLog.configure(this.config.persist);
        this.config._persist && this.config._persist();
        return json(res, 200, { ok: true });
      }
    }

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
    if (p === '/api/net') {
      const on = !!this.config.lanEnabled;
      const ip = on ? (lanAddress() || '127.0.0.1') : '127.0.0.1';
      const port = this.caServer && this.caServer.address() ? this.caServer.address().port : (this.config.caServePort ?? 8890);
      return json(res, 200, {
        lanEnabled: on,
        ip,
        proxyPort: this.config.proxyPort,
        caServePort: port,
        serving: !!this.caServer,
        cerUrl: `http://${ip}:${port}/ca.cer`,
        mobileconfigUrl: `http://${ip}:${port}/ca.mobileconfig`,
        proxyHost: `${ip}:${this.config.proxyPort}`,
      });
    }
    if (p === '/api/lan' && req.method === 'POST') {
      const b = await readBody(req);
      this.config.lanEnabled = !!b.on;
      this.config.bindHost = this.config.lanEnabled ? '0.0.0.0' : '127.0.0.1';
      this.config._persist && this.config._persist();
      if (this.proxy) {
        this.proxy.rebind(this.config.bindHost, () => {});
        return json(res, 200, { ok: true, bindHost: this.config.bindHost, restarting: false });
      }
      return json(res, 200, { ok: true, bindHost: this.config.bindHost });
    }
    if (p === '/api/ca/serve' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.on) await new Promise((resolve) => this._startCAServer(resolve));
      else this._stopCAServer();
      const addr = this.caServer && this.caServer.address();
      const ip = this.config.lanEnabled ? (lanAddress() || '127.0.0.1') : '127.0.0.1';
      const port = addr ? addr.port : (this.config.caServePort ?? 8890);
      return json(res, 200, {
        ok: true, serving: !!this.caServer,
        cerUrl: `http://${ip}:${port}/ca.cer`,
        mobileconfigUrl: `http://${ip}:${port}/ca.mobileconfig`,
      });
    }
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
