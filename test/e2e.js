#!/usr/bin/env node
'use strict';
/**
 * e2e.js — end-to-end proof that charles-clone works like Charles:
 *   1. plain HTTP forward proxy           (absolute-form request)
 *   2. HTTPS CONNECT blind tunnel         (host NOT in sslLocations)
 *   3. HTTPS MITM                         (host IN sslLocations -> forged leaf cert)
 *   4. Block List tool                    (403)
 *   5. Rewrite tool                       (response body modified)
 *   6. Map Remote tool                    (destination rewritten)
 *   7. Throttle tool                      (latency added)
 *   8. transactions recorded + served via /api
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const assert = require('assert');

const { CertificateAuthority } = require('../lib/ca');
const { Store } = require('../lib/store');
const { ToolPipeline, locMatches } = require('../lib/tools');
const { ProxyEngine } = require('../lib/proxy');
const { WebServer } = require('../lib/web');
const { load } = require('../lib/config');

let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function bad(name, err) { failed++; console.log(`  ❌ ${name}: ${err.message}`); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// ---- test origin servers ----
function startHttpOrigin(name = 'A') {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world', path: req.url, host: req.headers.host, origin: name }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function makeOriginCert(cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', crt, '-days', '2', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn},IP:127.0.0.1`],
    { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}
function startHttpsOrigin(cn = 'localhost') {
  return new Promise((resolve) => {
    const c = makeOriginCert(cn);
    const srv = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('SECRET-ORIGIN-CONTENT path=' + req.url);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, cn }));
  });
}

// HTTP/2-only HTTPS origin (negotiates h2 via ALPN).
function startH2Origin(cn = 'localhost') {
  const http2 = require('http2');
  return new Promise((resolve) => {
    const c = makeOriginCert(cn);
    const srv = http2.createSecureServer({ key: c.key, cert: c.cert, allowHTTP1: false });
    srv.on('stream', (stream, headers) => {
      const proto = stream.session ? stream.session.alpnProtocol : 'unknown';
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ origin: 'H2', proto: proto || 'h2', path: headers[':path'] }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, cn }));
  });
}

// curl through the proxy (ASYNC — execFileSync would block the event loop and
// deadlock the in-process servers). NO_PROXY is cleared so curl actually uses -x.
function curlProxy(proxyPort, target, { cacert, extra = [] } = {}) {
  // NOTE: an empty --noproxy list disables curl's no-proxy rules so -x is always
  // used. '*' is NOT correct here: curl treats '*' as "no proxy for all hosts",
  // which bypasses the proxy entirely and makes every tool test a false pass.
  const args = ['-s', '-S', '--noproxy', '', '--max-time', '15', '-x', `http://127.0.0.1:${proxyPort}`];
  if (cacert) args.push('--cacert', cacert);
  args.push(...extra, target);
  return new Promise((resolve) => {
    execFile('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, body: (stdout || '') + (stderr || ''), code: err.code });
      else resolve({ ok: true, body: stdout });
    });
  });
}

async function main() {
  console.log('\ncharles-clone — end-to-end test\n');

  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-ca-'));
  const configFile = path.join(caDir, 'config.json');

  const origin = await startHttpOrigin('A');
  const httpsOrigin = await startHttpsOrigin('localhost');

  const ca = new CertificateAuthority(caDir);
  ca.ensureRoot();

  const store = new Store();
  const config = load(configFile);
  config.proxyPort = 0; // ephemeral
  config.webPort = 0;
  // MITM only for localhost (the https origin). The http origin stays plain.
  // Using localhost keeps the test self-contained (no /etc/hosts entry needed)
  // while still exercising a real CONNECT -> forged-leaf MITM.
  config.sslLocations = [{ host: 'localhost', port: httpsOrigin.port }];
  const tools = new ToolPipeline(config);
  const proxy = new ProxyEngine({ ca, store, tools });
  const web = new WebServer({ store, tools, ca, config });

  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.server.address().port;
  const webPort = web.server.address().port;
  const caCrt = ca.crtPath;

  // 1. plain HTTP forward proxy
  await test('plain HTTP proxied + JSON body intact', async () => {
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/foo`);
    assert.ok(r.ok, 'curl failed: ' + r.body);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.hello, 'world');
    assert.strictEqual(j.path, '/foo');
  });

  // 2. HTTPS MITM (localhost is in sslLocations)
  await test('HTTPS MITM decrypts via forged cert (trusting clone CA)', async () => {
    const r = await curlProxy(proxyPort, `https://localhost:${httpsOrigin.port}/secret`, { cacert: caCrt });
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.match(r.body, /SECRET-ORIGIN-CONTENT/);
    assert.match(r.body, /path=\/secret/);
  });

  // 3. leaf cert was really generated by the CA for that host
  await test('CA minted a leaf cert for the MITM host', () => {
    assert.ok(ca.generated >= 1, 'no leaf certs generated');
    const pair = ca.forHost('localhost');
    assert.match(pair.cert, /BEGIN CERTIFICATE/);
    // verify the leaf chains to our root
    const leafFile = path.join(caDir, 'leafcheck.pem');
    fs.writeFileSync(leafFile, pair.cert);
    execFileSync('openssl', ['verify', '-CAfile', caCrt, leafFile], { stdio: 'ignore' });
  });

  // 4. transaction recorded with decrypted body visible
  await test('MITM transaction recorded with plaintext body', () => {
    const txs = store.list();
    const hit = txs.find((t) => t.sslProxied && t.path === '/secret');
    assert.ok(hit, 'no sslProxied /secret transaction recorded');
    const full = store.get(hit.id).detail();
    assert.match(full.responseBody.text, /SECRET-ORIGIN-CONTENT/);
  });

  // 4b. HTTP/2: client negotiates h2 and the origin is reached over h2.
  await test('HTTP/2 MITM: client h2 + upstream h2', async () => {
    const h2Origin = await startH2Origin('localhost');
    config.sslLocations = [{ host: 'localhost', port: h2Origin.port }];
    const r = await curlProxy(proxyPort, `https://localhost:${h2Origin.port}/h2`,
      { cacert: caCrt, extra: ['--http2', '-w', '\nHTTPV=%{http_version}'] });
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.match(r.body, /"origin":"H2"/, 'upstream should be HTTP/2: ' + r.body);
    assert.match(r.body, /HTTPV=2/, 'client should negotiate HTTP/2: ' + r.body);
    config.sslLocations = [{ host: 'localhost', port: httpsOrigin.port }];
    h2Origin.srv.close();
  });

  // 4c. HTTP/2 client against an HTTP/1.1-only origin (upstream falls back).
  await test('HTTP/2 client to HTTP/1.1 origin', async () => {
    const r = await curlProxy(proxyPort, `https://localhost:${httpsOrigin.port}/secret`,
      { cacert: caCrt, extra: ['--http2', '-w', '\nHTTPV=%{http_version}'] });
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.match(r.body, /SECRET-ORIGIN-CONTENT/, 'body should pass through: ' + r.body);
    assert.match(r.body, /HTTPV=2/, 'client should negotiate HTTP/2: ' + r.body);
  });

  // 4d. Tools apply to HTTP/2 transactions too.
  await test('Rewrite applies to HTTP/2 transactions', async () => {
    const h2Origin = await startH2Origin('localhost');
    config.sslLocations = [{ host: 'localhost', port: h2Origin.port }];
    config.enabled.rewrite = true;
    config.rewrite = [{ enabled: true, location: { host: 'localhost' }, rules: [
      { type: 'response', target: 'body', match: 'H2', replace: 'H2-REWRITTEN', flags: 'g' },
    ] }];
    const r = await curlProxy(proxyPort, `https://localhost:${h2Origin.port}/x`,
      { cacert: caCrt, extra: ['--http2'] });
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.match(r.body, /H2-REWRITTEN/, 'rewrite should apply over h2: ' + r.body);
    config.enabled.rewrite = false; config.rewrite = [];
    config.sslLocations = [{ host: 'localhost', port: httpsOrigin.port }];
    h2Origin.srv.close();
  });

  // 5. Block List tool — Charles' default action drops the connection.
  await test('Block List default drops the connection', async () => {
    config.enabled.blocklist = true;
    config.blockAction = 'drop';
    config.blocklist = [{ host: '127.0.0.1', port: origin.port }];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/blocked`);
    assert.ok(!r.ok, 'expected the connection to be dropped, got a response: ' + r.body);
    assert.ok(!/403 Forbidden/.test(r.body), 'drop must not send a 403 body');
    config.enabled.blocklist = false; config.blocklist = [];
  });

  // 5b. Block List tool — opt-in 403 response.
  await test('Block List returns 403 when blockAction=403', async () => {
    config.enabled.blocklist = true;
    config.blockAction = '403';
    config.blocklist = [{ host: '127.0.0.1', port: origin.port }];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/blocked`);
    assert.ok(r.ok, 'curl transport failed: ' + r.body);
    assert.match(r.body, /403 Forbidden — blocked/);
    config.enabled.blocklist = false; config.blocklist = []; config.blockAction = 'drop';
  });

  // 6. Rewrite tool (response body)
  await test('Rewrite tool modifies response body', async () => {
    config.enabled.rewrite = true;
    config.rewrite = [{ enabled: true, location: { host: '*' }, rules: [
      { type: 'response', target: 'body', action: 'modify', match: 'world', replace: 'REWRITTEN', flags: 'g' },
    ] }];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/rw`);
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.match(r.body, /REWRITTEN/);
    config.enabled.rewrite = false; config.rewrite = [];
  });

  // 6a. Rewrite body honors the response charset and skips binary.
  await test('Rewrite body honors charset and skips binary', async () => {
    const types = {
      '/latin1': { ct: 'text/plain; charset=iso-8859-1', body: Buffer.from('caf\xe9', 'latin1') },
      '/bin': { ct: 'application/octet-stream', body: Buffer.from('world', 'utf8') },
    };
    const srv = http.createServer((req, res) => {
      const t = types[req.url] || { ct: 'text/plain', body: Buffer.from('world') };
      res.writeHead(200, { 'Content-Type': t.ct });
      res.end(t.body);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;

    config.enabled.rewrite = true;
    config.rewrite = [{ enabled: true, location: { host: '127.0.0.1', port: p }, rules: [
      { type: 'response', target: 'body', action: 'modify', match: '\xe9', replace: 'e', flags: 'g' },
      { type: 'response', target: 'body', action: 'modify', match: 'world', replace: 'CHANGED', flags: 'g' },
    ] }];

    // latin1 body: 'caf\xe9' -> 'cafe' (the \xe9 byte is rewritten via latin1)
    const r1 = await curlProxy(proxyPort, `http://127.0.0.1:${p}/latin1`);
    assert.strictEqual(r1.body, 'cafe', 'latin1 body should be decoded with its charset');

    // binary content-type: body rules must be skipped
    const r2 = await curlProxy(proxyPort, `http://127.0.0.1:${p}/bin`);
    assert.strictEqual(r2.body, 'world', 'binary body must not be rewritten');

    config.enabled.rewrite = false; config.rewrite = [];
    srv.close();
  });

  // 6b. Map Local tool: serve a file, fall through when missing, directory mapping.
  await test('Map Local serves a file, falls through when missing, maps directories', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maplocal-'));
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'LOCAL-FILE-CONTENT');
    config.enabled.mapLocal = true;

    // (a) serve the local file
    config.mapLocal = [{ location: { host: '127.0.0.1', port: origin.port, path: '/local.txt' }, localPath: file }];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/local.txt`);
    assert.match(r.body, /LOCAL-FILE-CONTENT/, 'should serve the local file');

    // (b) missing file must fall through to the origin (Charles behaviour), not 404
    config.mapLocal = [{ location: { host: '127.0.0.1', port: origin.port, path: '/missing.txt' }, localPath: path.join(dir, 'nope.txt') }];
    const r2 = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/missing.txt`);
    const j2 = JSON.parse(r2.body);
    assert.strictEqual(j2.origin, 'A', 'a missing Map Local file must fall through to upstream');

    // (c) directory mapping resolves the unmatched request path beneath the dir
    fs.writeFileSync(path.join(dir, 'sub.txt'), 'SUBDIR-CONTENT');
    config.mapLocal = [{ location: { host: '127.0.0.1', port: origin.port, path: '/*' }, localPath: dir }];
    const r3 = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/sub.txt`);
    assert.match(r3.body, /SUBDIR-CONTENT/, 'directory mapping should resolve the request path');

    config.enabled.mapLocal = false; config.mapLocal = [];
  });

  // 7. Map Remote tool (must prove the DESTINATION changed, not just the path)
  await test('Map Remote rewrites destination', async () => {
    const origin2 = await startHttpOrigin('B');
    config.enabled.mapRemote = true;
    config.mapRemote = [{ from: { host: '127.0.0.1', port: origin.port, path: '/mapped' },
      to: { host: '127.0.0.1', port: origin2.port, protocol: 'http' } }];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/mapped`);
    assert.ok(r.ok, 'curl failed: ' + r.body);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.path, '/mapped');
    // origin2 tags its responses with origin:'B'; origin tags them 'A'. Asserting
    // the marker proves the request actually went to the mapped destination.
    assert.strictEqual(j.origin, 'B', 'request was not mapped to origin B: ' + r.body);
    // origin2 echoed its own host header — proves it served the request
    config.enabled.mapRemote = false; config.mapRemote = [];
    origin2.srv.close();
  });

  // 7b. Map Remote rewrites path, query and Host header.
  await test('Map Remote rewrites path/query/Host', async () => {
    const origin2 = await startHttpOrigin('B');
    config.enabled.mapRemote = true;
    config.mapRemote = [{ from: { host: '127.0.0.1', port: origin.port, path: '/old/*' },
      to: { host: '127.0.0.1', port: origin2.port, protocol: 'http', path: '/new/', query: 'a=1' } }];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/old/thing?x=2`);
    assert.ok(r.ok, 'curl failed: ' + r.body);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.origin, 'B', 'should be mapped to origin B: ' + r.body);
    assert.strictEqual(j.path, '/new/thing?a=1', 'path prefix + query should be rewritten: ' + j.path);
    assert.strictEqual(j.host, `127.0.0.1:${origin2.port}`, 'Host header should follow the mapped destination');
    config.enabled.mapRemote = false; config.mapRemote = [];
    origin2.srv.close();
  });

  // 8. Throttle tool (latency)
  await test('Throttle tool adds latency', async () => {
    config.enabled.throttle = true;
    config.throttle = { latency: 400, hosts: [] };
    const t0 = Date.now();
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/slow`);
    const dt = Date.now() - t0;
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.ok(dt >= 380, `expected >=380ms delay, got ${dt}ms`);
    config.enabled.throttle = false; config.throttle = { latency: 0, hosts: [] };
  });

  // 8b. Throttle tool (bandwidth pacing, like Charles)
  await test('Throttle paces by bandwidth', async () => {
    const big = 'x'.repeat(20 * 1024); // 20 KB
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(big);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    config.enabled.throttle = true;
    config.throttle = { latency: 0, bandwidthDown: 40, hosts: [] }; // 40 KB/s -> 20KB ~= 500ms
    const t0 = Date.now();
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${p}/big`);
    const dt = Date.now() - t0;
    assert.ok(r.ok, 'curl failed: ' + r.body);
    assert.ok(dt >= 400, `expected >=400ms bandwidth pacing, got ${dt}ms`);
    assert.strictEqual(r.body.length, 20 * 1024, 'body should pass through intact');
    config.enabled.throttle = false; config.throttle = { latency: 0, hosts: [] };
    srv.close();
  });

  // 8c. Pipeline ordering: Block List (order 50) must run before Map Local (72).
  await test('pipeline ordering: Block List wins over Map Local', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-'));
    const file = path.join(dir, 'x.txt');
    fs.writeFileSync(file, 'FROM-FILE');
    const loc = { host: '127.0.0.1', port: origin.port, path: '/order.txt' };
    config.enabled.mapLocal = true;
    config.enabled.blocklist = true;
    config.blockAction = 'drop';
    config.mapLocal = [{ location: loc, localPath: file }];
    config.blocklist = [loc];
    const r = await curlProxy(proxyPort, `http://127.0.0.1:${origin.port}/order.txt`);
    assert.ok(!r.ok, 'block should win over map local: ' + r.body);
    config.enabled.mapLocal = false; config.enabled.blocklist = false;
    config.mapLocal = []; config.blocklist = []; config.blockAction = 'drop';
  });

  // 9. web API serves transactions
  await test('web /api/transactions returns recorded rows', async () => {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${webPort}/api/transactions`, (res) => {
        const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString()));
      }).on('error', reject);
    });
    const arr = JSON.parse(body);
    assert.ok(Array.isArray(arr) && arr.length > 0, 'no transactions from API');
    assert.ok(arr.some((t) => t.sslProxied), 'no MITM tx in API list');
  });

  // 10. control API serves the root CA PEM
  await test('control API serves the CA cert', async () => {
    const pem = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${webPort}/api/ca.pem`, (res) => {
        const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString()));
      }).on('error', reject);
    });
    assert.match(pem, /BEGIN CERTIFICATE/);
    // The static web GUI is retired: the server is API-only.
    const root = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${webPort}/`, (res) => {
        const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(c).toString() }));
      }).on('error', reject);
    });
    assert.strictEqual(root.code, 404, 'no static UI should be served');
  });

  // 10b. Root CA identity + trust status via the control API.
  await test('web /api/ca reports root CA identity and trust', async () => {
    const info = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${webPort}/api/ca`, (res) => {
        const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
      }).on('error', reject);
    });
    assert.match(info.fingerprintHex, /^[0-9a-f]{64}$/, 'sha256 fingerprint should be 64 hex chars');
    assert.match(info.subject, /Charles-Clone CA/, 'subject should name the CA');
    assert.strictEqual(typeof info.trusted, 'boolean', 'trusted must be a boolean');
    assert.ok(String(info.path).endsWith('ca.crt'), 'path should point at the root CA');
  });

  // 10c. Import settings from a Charles XML via the control API.
  await test('import from a Charles XML updates the config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charles-import-'));
    const file = path.join(dir, 'com.xk72.charles.config');
    fs.writeFileSync(file,
      '<?xml version="1.0"?><configuration><proxyConfiguration><sslLocations><locationPatterns>' +
      '<locationMatch><location><host>imported.example.com</host><port>443</port></location></locationMatch>' +
      '</locationPatterns></sslLocations></proxyConfiguration></configuration>');
    const payload = JSON.stringify({ path: file });
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: webPort, path: '/api/import/charles', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
      });
      req.on('error', reject); req.end(payload);
    });
    assert.ok(r.ok, 'import failed: ' + JSON.stringify(r));
    assert.strictEqual(r.summary.sslLocations, 1, 'summary should count 1 SSL location');

    const cfg = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${webPort}/api/config`, (res) => {
        const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
      }).on('error', reject);
    });
    assert.ok((cfg.sslLocations || []).some((l) => l.host === 'imported.example.com'),
      'engine config should include the imported SSL host');
  });

  // (The former web-GUI tests — app.css [hidden] and the Tools editor wiring —
  //  were removed along with public/. The native Louie app is the only UI.)

  // 13. Charles-style location matching (canonical URL regex)
  await test('location matching: scheme/port/path/host semantics match Charles', () => {
    const tx = { scheme: 'https', host: 'api.example.com', port: '443', path: '/api/v1/thing?x=1' };
    // scheme is significant
    assert.ok(locMatches({ host: 'api.example.com' }, tx), 'host-only should match');
    assert.ok(!locMatches({ protocol: 'http', host: 'api.example.com' }, tx), 'http pattern must not match https');
    assert.ok(locMatches({ protocol: 'https', host: 'api.example.com' }, tx), 'https pattern should match');
    // host wildcards
    assert.ok(locMatches({ host: '*.example.com' }, tx), 'wildcard subdomain should match');
    assert.ok(locMatches({ host: '*' }, tx), 'empty/* host matches any');
    assert.ok(!locMatches({ host: 'other.com' }, tx), 'non-matching host rejected');
    // port is significant
    assert.ok(locMatches({ host: 'api.example.com', port: 443 }, tx), 'explicit port should match');
    assert.ok(!locMatches({ host: 'api.example.com', port: 8443 }, tx), 'wrong port must not match');
    // path glob
    assert.ok(locMatches({ host: 'api.example.com', path: '/api/*' }, tx), 'path prefix wildcard should match');
    assert.ok(!locMatches({ host: 'api.example.com', path: '/other/*' }, tx), 'other path rejected');
  });

  // cleanup
  origin.srv.close(); httpsOrigin.srv.close(); proxy.close(); web.server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
