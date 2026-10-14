'use strict';
/**
 * proxy.js — The proxy engine. Mirrors com/xk72/proxy/*:
 *   - HttpProxyServer   (plain HTTP forward proxy)
 *   - Connection        (a single client<->proxy<->server pipe)
 *   - SSLSnooper / SSLSocketConfigurationGenerator (CONNECT + MITM decision)
 *
 * Flow for an HTTP request:
 *   client -> (absolute-form request line) -> proxy -> tool pipeline -> upstream
 * Flow for HTTPS:
 *   client -> CONNECT host:443 -> proxy decides:
 *      - host NOT in SSL-proxying list => blind TCP tunnel (we only see SNI/host)
 *      - host IN list => terminate TLS with a forged leaf cert, then re-request upstream
 *
 * MITM negotiates ALPN and serves HTTP/2 to the client when it offers `h2`,
 * otherwise HTTP/1.1. Upstream is HTTP/2 when the origin supports it (cached
 * ALPN probe), else HTTP/1.1. Push promises are never used.
 */
const http = require('http');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

class ProxyEngine {
  /**
   * @param {object} opts
   * @param {CertificateAuthority} opts.ca
   * @param {Store} opts.store        transaction store + event bus
   * @param {ToolPipeline} opts.tools  enabled tools (ssl list, rewrite, map, block, throttle)
   */
  constructor(opts) {
    this.ca = opts.ca;
    this.store = opts.store;
    this.tools = opts.tools;
    this._upstreamProto = new Map(); // "host:port" -> 'h2' | 'http/1.1'
    this.server = http.createServer((req, res) => this._onHttp(req, res));
    this.server.on('connect', (req, cltSocket, head) => this._onConnect(req, cltSocket, head));
    this.server.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
  }

  listen(port, host, cb) { this.server.listen(port, host, cb); return this.server; }
  close(cb) { this.server.close(cb); }

  /** Re-bind the proxy to a new interface (e.g. 0.0.0.0 for LAN) on the same port. */
  rebind(host, cb) {
    const addr = this.server.address();
    const port = addr ? addr.port : 0;
    this.server.close(() => {
      const srv = http.createServer((req, res) => this._onHttp(req, res));
      srv.on('connect', (req, sock, head) => this._onConnect(req, sock, head));
      srv.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
      this.server = srv;
      srv.listen(port, host, () => cb && cb(port));
    });
  }

  // ---------------- plain HTTP (absolute-form) ----------------
  async _onHttp(req, res) {
    const targetUrl = req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`;
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { res.writeHead(400); return res.end('Bad request URL'); }

    const reqBody = await readBody(req);
    await this._transaction({
      scheme: 'http',
      host: parsed.hostname,
      port: parsed.port || 80,
      method: req.method,
      path: parsed.pathname + parsed.search,
      headers: { ...req.headers },
      body: reqBody,
      sslProxied: false,
      clientIp: req.socket.remoteAddress,
      respond: (status, headers, body) => sendResponse(res, status, headers, body),
      respondDrop: () => { try { res.destroy(); } catch (_) {} },
    });
  }

  // ---------------- HTTPS CONNECT ----------------
  _onConnect(req, cltSocket, head) {
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr || '443', 10);

    if (!this.tools.sslEnabled(host, port)) {
      const tx = this.store.create({
        scheme: 'https', method: 'CONNECT', host, port, path: '',
        clientIp: cltSocket.remoteAddress, sslProxied: false,
      });
      cltSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const upstream = net.connect(port, host, () => {
        if (head && head.length) upstream.write(head);
        cltSocket.pipe(upstream).pipe(cltSocket);
      });
      const finish = () => { tx.setTunneled(Date.now()); this.store.finalize(tx); };
      upstream.on('error', () => { tx.setError('tunnel upstream error', 0); this.store.finalize(tx); cltSocket.destroy(); });
      upstream.on('close', finish);
      cltSocket.on('error', () => upstream.destroy());
      cltSocket.on('close', () => upstream.destroy());
      return;
    }

    // MITM — terminate TLS with a forged cert for `host`, negotiate ALPN.
    const pair = this.ca.forHost(host);
    cltSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tlsServer = tls.createServer({
      key: pair.key,
      cert: pair.cert,
      ALPNProtocols: ['h2', 'http/1.1'],
      SNICallback: (servername, cbx) => {
        const p = this.ca.forHost(servername || host);
        cbx(null, tls.createSecureContext({ key: p.key, cert: p.cert }));
      },
    }, (tlsSock) => {
      if (tlsSock.alpnProtocol === 'h2') {
        this._serveH2(tlsSock, host, port);
      } else {
        const parser = new HttpStreamParser((m) => this._handleMitmH1(m, host, port));
        parser.socket = tlsSock;
        tlsSock.on('data', (d) => parser.feed(d));
      }
    });
    tlsServer.on('error', () => { try { cltSocket.destroy(); } catch (_) {} });
    tlsServer.emit('connection', cltSocket);
  }

  // ---------------- MITM: HTTP/1.1 ----------------
  async _handleMitmH1(msg, host, port) {
    await this._transaction({
      scheme: 'https',
      host,
      port,
      method: msg.method,
      path: msg.path,
      headers: msg.headers,
      body: msg.body,
      sslProxied: true,
      clientIp: msg.socket.remoteAddress,
      respond: (status, headers, body) => writeRaw(msg, status, statusText(status), headers, body),
      respondDrop: () => { try { msg.socket.destroy(); } catch (_) {} },
    });
  }

  // ---------------- MITM: HTTP/2 (client side) ----------------
  _serveH2(socket, host, port) {
    const server = http2.createServer({ settings: { enablePush: false } });
    server.on('error', () => { try { socket.destroy(); } catch (_) {} });
    server.on('session', (s) => s.on('error', () => {}));
    server.on('stream', (stream, headers) => this._handleH2Stream(stream, headers, host, port, socket));
    server.emit('connection', socket);
  }

  async _handleH2Stream(stream, headers, host, port, socket) {
    const method = headers[':method'] || 'GET';
    const path = headers[':path'] || '/';
    const authority = String(headers[':authority'] || `${host}:${port}`);
    const [h, p] = authority.split(':');
    const reqHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith(':')) continue;
      reqHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const chunks = [];
    stream.on('error', () => {});
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', async () => {
      await this._transaction({
        scheme: 'https',
        host: h || host,
        port: Number(p) || port,
        method,
        path,
        headers: reqHeaders,
        body: Buffer.concat(chunks),
        sslProxied: true,
        clientIp: socket.remoteAddress,
        respond: (status, hdrs, body) => {
          try {
            stream.respond(h2ResponseHeaders(status, hdrs));
            stream.end(body);
          } catch (_) {}
        },
        respondDrop: () => {
          try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch (_) {}
          try { stream.destroy(); } catch (_) {}
        },
      });
    });
  }

  // ---------------- shared transaction handling (all protocols) ----------------
  async _transaction(t) {
    const started = Date.now();
    const tx = this.store.create({
      scheme: t.scheme, method: t.method, host: t.host, port: t.port,
      path: t.path, clientIp: t.clientIp, sslProxied: t.sslProxied,
    });
    tx.setRequest(t.method, t.headers, t.body, t.path);

    let decision;
    try { decision = await this.tools.onRequest(tx); }
    catch (e) { decision = { blocked: false, rewriteUrl: null }; }

    if (decision.blocked) {
      if (decision.action === 'drop') {
        tx.setResponse(0, {}, Buffer.alloc(0), Date.now() - started);
        tx.note('Blocklist', 'connection dropped (no response sent)');
        this.store.finalize(tx);
        return t.respondDrop();
      }
      tx.setResponse(decision.status, decision.headers || {}, decision.body || Buffer.alloc(0), Date.now() - started);
      this.store.finalize(tx);
      return t.respond(tx.status, tx.responseHeaders, tx.responseBody);
    }

    const dest = decision.rewriteUrl ? new URL(decision.rewriteUrl) : null;
    const dScheme = dest ? dest.protocol.replace(':', '') : t.scheme;
    const dHost = dest ? dest.hostname : t.host;
    const dPort = dest ? (dest.port || (dScheme === 'https' ? 443 : 80)) : t.port;
    const dPath = dest ? dest.pathname + dest.search : t.path;

    try {
      const up = await this._forward({
        scheme: dScheme, host: dHost, port: dPort, method: t.method, path: dPath,
        headers: stripHop(tx.requestHeaders, { hostname: dHost, port: dPort }),
        body: tx.requestBody,
      });
      tx.setResponse(up.status, up.headers, up.body, Date.now() - started);
      await this.tools.onResponse(tx);
      this.store.finalize(tx);
      t.respond(tx.status, tx.responseHeaders, tx.responseBody);
    } catch (err) {
      tx.setError(err.message, Date.now() - started);
      this.store.finalize(tx);
      t.respond(502, { 'content-type': 'text/plain' }, Buffer.from(`502 ${err.message}`));
    }
  }

  // ---------------- upstream forwarding ----------------
  async _forward(o) {
    if (o.scheme === 'https') {
      const proto = await this._detectUpstream(o.host, o.port);
      if (proto === 'h2') {
        try { return await this._forwardH2(o); } catch (_) { /* fall back */ }
      }
      return await this._forwardH1TLS(o);
    }
    return await this._forwardH1(o);
  }

  _forwardH1(o) {
    const mod = o.scheme === 'https' ? require('https') : http;
    const opts = {
      hostname: o.host, port: o.port, method: o.method, path: o.path, headers: o.headers,
    };
    if (o.scheme === 'https') { opts.servername = o.host; opts.rejectUnauthorized = false; }
    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (o.body && o.body.length) req.write(o.body);
      req.end();
    });
  }
  _forwardH1TLS(o) { return this._forwardH1(o); }

  _forwardH2(o) {
    return new Promise((resolve, reject) => {
      const session = http2.connect(`${o.scheme}://${o.host}:${o.port}`, {
        rejectUnauthorized: false, servername: o.host,
      });
      const fail = (e) => { try { session.close(); } catch (_) {} reject(e); };
      session.once('error', fail);
      const headers = { ':method': o.method, ':path': o.path, ':authority': `${o.host}:${o.port}` };
      for (const [k, v] of Object.entries(o.headers || {})) {
        const key = k.toLowerCase();
        if (key === 'host' || key === 'content-length' || HOP_BY_HOP.has(key)) continue;
        headers[key] = v;
      }
      const req = session.request(headers);
      let status = 0; const resHeaders = {}; const chunks = [];
      req.on('response', (h) => {
        status = Number(h[':status']) || 0;
        for (const [k, v] of Object.entries(h)) {
          if (k.startsWith(':')) continue;
          resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        }
      });
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { try { session.close(); } catch (_) {} resolve({ status, headers: resHeaders, body: Buffer.concat(chunks) }); });
      req.on('error', fail);
      if (o.body && o.body.length) req.write(o.body);
      req.end();
    });
  }

  /** Probe (and cache) whether an https origin speaks h2. */
  _detectUpstream(host, port) {
    const key = `${host}:${port}`;
    if (this._upstreamProto.has(key)) return Promise.resolve(this._upstreamProto.get(key));
    return new Promise((resolve) => {
      let done = false;
      const finish = (proto) => {
        if (done) return; done = true;
        this._upstreamProto.set(key, proto);
        resolve(proto);
      };
      const sock = tls.connect({
        host, port, servername: host, rejectUnauthorized: false,
        ALPNProtocols: ['h2', 'http/1.1'],
      }, () => {
        const p = sock.alpnProtocol === 'h2' ? 'h2' : 'http/1.1';
        try { sock.end(); } catch (_) {}
        finish(p);
      });
      sock.setTimeout(3000, () => { try { sock.destroy(); } catch (_) {} finish('http/1.1'); });
      sock.on('error', () => finish('http/1.1'));
    });
  }
}

// ---- helpers ----
function stripHop(headers, dest) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (dest && dest.hostname) out.host = dest.hostname + (dest.port ? `:${dest.port}` : '');
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function sendResponse(res, status, headers, body) {
  const h = { ...headers };
  delete h['transfer-encoding'];
  delete h['content-length'];
  h['content-length'] = Buffer.byteLength(body);
  try { res.writeHead(status, h); res.end(body); }
  catch (_) { try { res.end(); } catch (__) {} }
}

function h2ResponseHeaders(status, headers) {
  const out = { ':status': status };
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key.startsWith(':')) continue;
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'connection' || key === 'transfer-encoding' || key === 'content-length') continue;
    out[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function writeRaw(msg, status, reason, headers, body) {
  const h = { ...headers };
  delete h['transfer-encoding'];
  delete h['content-encoding'];
  h['content-length'] = Buffer.byteLength(body);
  let head = `HTTP/1.1 ${status} ${reason}\r\n`;
  for (const [k, v] of Object.entries(h)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const vv of vals) head += `${k}: ${vv}\r\n`;
  }
  head += '\r\n';
  try { msg.socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body])); } catch (_) {}
  if (String(h['connection'] || '').toLowerCase() === 'close') { try { msg.socket.end(); } catch (_) {} }
}

function statusText(code) {
  return ({ 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
    302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
    403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error',
    502: 'Bad Gateway', 503: 'Service Unavailable' })[code] || 'Status ' + code;
}

/**
 * Minimal HTTP/1.1 request parser over a TLS stream (one request at a time).
 * Handles Content-Length bodies; chunked is passed through as-is.
 */
class HttpStreamParser {
  constructor(onRequest) { this.onRequest = onRequest; this.buf = Buffer.alloc(0); this.cur = null; this.socket = null; }
  feed(data) {
    this.buf = Buffer.concat([this.buf, data]);
    this._parse();
  }
  _parse() {
    while (true) {
      if (!this.cur) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headStr = this.buf.slice(0, idx).toString('latin1');
        this.buf = this.buf.slice(idx + 4);
        const lines = headStr.split('\r\n');
        const [method, path] = lines[0].split(' ');
        const headers = {};
        for (let i = 1; i < lines.length; i++) {
          const c = lines[i].indexOf(':');
          if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
        }
        this.cur = { method, path, headers, body: Buffer.alloc(0),
          contentLength: parseInt(headers['content-length'] || '0', 10) || 0,
          chunked: String(headers['transfer-encoding'] || '').includes('chunked'),
          socket: this.socket };
      }
      const need = this.cur.contentLength - this.cur.body.length;
      if (need > 0) {
        const take = this.buf.slice(0, need);
        this.cur.body = Buffer.concat([this.cur.body, take]);
        this.buf = this.buf.slice(take.length);
        if (this.cur.body.length < this.cur.contentLength) return;
      }
      const msg = this.cur; this.cur = null;
      msg.socket = this.socket;
      this.onRequest(msg);
      if (this.buf.length === 0) return;
    }
  }
}

module.exports = { ProxyEngine, HttpStreamParser, statusText };
