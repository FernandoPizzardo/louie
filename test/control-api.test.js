'use strict';
/**
 * control-api tests — lock down the HTTP contract in lib/web.js that every
 * client depends on (the SwiftUI app today; web/Electron clients next).
 * The contract itself lives in docs/control-api.md. Change one, change both.
 *
 * Self-contained: temp dir, ephemeral ports, a local token. Needs openssl
 * (for the root CA), same as test/e2e.js.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { CertificateAuthority } = require('../lib/ca');
const { Store } = require('../lib/store');
const { ToolPipeline } = require('../lib/tools');
const { WebServer } = require('../lib/web');
const { BreakpointManager } = require('../lib/breakpoint');
const { SessionLog } = require('../lib/session-log');
const { load } = require('../lib/config');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out waiting for condition');
};

/** Small HTTP helper: returns { status, headers, text, json }. */
function request(port, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {};
    if (token) headers['x-charles-token'] = token;
    if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString();
        let json; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('\ncharles-clone — control API contract test\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'louie-api-'));
  const ca = new CertificateAuthority(dir);
  ca.ensureRoot();

  const store = new Store();
  const config = load(path.join(dir, 'config.json'));
  config.proxyPort = 0;
  config.webPort = 0;
  config.caServePort = 0; // ephemeral, so the test can't clash with port 8890
  const tools = new ToolPipeline(config);
  const breakpoints = new BreakpointManager({ config, store });
  tools.breakpoints = breakpoints;
  const sessionLog = new SessionLog({
    dir: path.join(dir, 'session-data'), enabled: true, maxBodyBytes: 64, redact: config.redact,
  });
  const TOKEN = 'test-token';
  const web = new WebServer({ store, tools, ca, config, sessionLog, token: TOKEN, breakpoints });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const port = web.server.address().port;

  // 1. auth
  await test('control API requires the token (header and query)', async () => {
    const anon = await request(port, 'GET', '/api/transactions');
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.json.error, 'unauthorized');
    const hdr = await request(port, 'GET', '/api/transactions', { token: TOKEN });
    assert.strictEqual(hdr.status, 200);
    const q = await request(port, 'GET', `/api/transactions?token=${TOKEN}`);
    assert.strictEqual(q.status, 200);
  });

  await test('GET /api/transactions is an array of summaries', async () => {
    const r = await request(port, 'GET', '/api/transactions', { token: TOKEN });
    assert.ok(Array.isArray(r.json), 'expected an array');
  });

  await test('unknown route and bad method are 404 JSON', async () => {
    const unknown = await request(port, 'GET', '/api/nope', { token: TOKEN });
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.json.error, 'not found');
    const wrongMethod = await request(port, 'GET', '/api/clear', { token: TOKEN });
    assert.strictEqual(wrongMethod.status, 404);
  });

  await test('POST /api/recording toggles and /api/status reflects it', async () => {
    const off = await request(port, 'POST', '/api/recording', { token: TOKEN, body: { on: false } });
    assert.strictEqual(off.json.on, false);
    const st = await request(port, 'GET', '/api/status', { token: TOKEN });
    for (const k of ['proxyPort', 'webPort', 'recording', 'count', 'leafCertsGenerated', 'sslLocations', 'enabled']) {
      assert.ok(k in st.json, `status missing ${k}`);
    }
    assert.strictEqual(st.json.recording, false);
    await request(port, 'POST', '/api/recording', { token: TOKEN, body: { on: true } });
  });

  // 2. transaction detail
  await test('GET /api/transaction/:id returns detail; unknown id is 404', async () => {
    const tx = store.create({ scheme: 'https', method: 'POST', host: 'api.example.com', port: 443, path: '/v1/login' });
    tx.setRequest('POST', { 'content-type': 'application/json' }, Buffer.from('{"a":1}'), '/v1/login');
    tx.setResponse(201, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'), 7);
    store.finalize(tx);
    const r = await request(port, 'GET', `/api/transaction/${tx.id}`, { token: TOKEN });
    assert.strictEqual(r.status, 200);
    for (const k of ['id', 'requestHeaders', 'requestBody', 'responseHeaders', 'responseBody', 'reqSize', 'resSize']) {
      assert.ok(k in r.json, `detail missing ${k}`);
    }
    assert.strictEqual(r.json.status, 201);
    const miss = await request(port, 'GET', '/api/transaction/999999', { token: TOKEN });
    assert.strictEqual(miss.status, 404);
  });

  // 3. save / saved
  await test('save → list → fetch a pinned copy', async () => {
    const tx = store.create({ scheme: 'https', method: 'GET', host: 'api.example.com', port: 443, path: '/pin' });
    tx.setResponse(200, { 'content-type': 'application/json' }, Buffer.from('{"pinned":true}'), 3);
    store.finalize(tx);
    const save = await request(port, 'POST', `/api/transaction/${tx.id}/save`, { token: TOKEN, body: {} });
    assert.strictEqual(save.status, 200);
    assert.strictEqual(save.json.ok, true);
    assert.ok(save.json.name, 'save should return a file name');
    const list = await request(port, 'GET', '/api/saved', { token: TOKEN });
    assert.ok(Array.isArray(list.json));
    assert.ok(list.json.some((f) => f.name === save.json.name && typeof f.size === 'number'),
      'saved list should include the new file with a size');
    const one = await request(port, 'GET', `/api/saved/${encodeURIComponent(save.json.name)}`, { token: TOKEN });
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.json.saved, true);
    const miss = await request(port, 'GET', '/api/saved/nope.json', { token: TOKEN });
    assert.strictEqual(miss.status, 404);
  });

  await test('save asks for confirmation when the body is over the cap', async () => {
    const tx = store.create({ scheme: 'https', method: 'GET', host: 'api.example.com', port: 443, path: '/big' });
    tx.setResponse(200, { 'content-type': 'application/octet-stream' }, Buffer.alloc(1024), 3);
    store.finalize(tx);
    const r = await request(port, 'POST', `/api/transaction/${tx.id}/save`, { token: TOKEN, body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.needsConfirm, true);
    assert.ok(r.json.size > r.json.cap, 'size should exceed cap');
    const full = await request(port, 'POST', `/api/transaction/${tx.id}/save`, { token: TOKEN, body: { full: true } });
    assert.strictEqual(full.json.ok, true);
    assert.strictEqual(full.json.truncated, false);
  });

  // 4. persist
  await test('GET/POST /api/persist round-trips', async () => {
    const before = await request(port, 'GET', '/api/persist', { token: TOKEN });
    for (const k of ['enabled', 'dir', 'maxBodyBytes', 'retentionDays']) {
      assert.ok(k in before.json, `persist missing ${k}`);
    }
    const on = await request(port, 'POST', '/api/persist', { token: TOKEN, body: { enabled: true } });
    assert.strictEqual(on.json.ok, true);
    const after = await request(port, 'GET', '/api/persist', { token: TOKEN });
    assert.strictEqual(after.json.enabled, true);
  });

  // 5. config
  await test('GET/POST /api/config round-trips', async () => {
    const cfg = await request(port, 'GET', '/api/config', { token: TOKEN });
    assert.ok(cfg.json && typeof cfg.json === 'object');
    assert.ok('proxyPort' in cfg.json, 'config should expose proxyPort');
    const post = await request(port, 'POST', '/api/config', { token: TOKEN, body: { throttle: { latency: 0, bandwidthDown: 0, bandwidthUp: 0, hosts: [] } } });
    assert.strictEqual(post.json.ok, true);
  });

  // 6. CA identity + PEM
  await test('GET /api/ca and /api/ca.pem describe the root CA', async () => {
    const info = await request(port, 'GET', '/api/ca', { token: TOKEN });
    for (const k of ['path', 'subject', 'fingerprint', 'fingerprintHex', 'trusted']) {
      assert.ok(k in info.json, `ca missing ${k}`);
    }
    const pem = await request(port, 'GET', '/api/ca.pem', { token: TOKEN });
    assert.strictEqual(pem.status, 200);
    assert.match(pem.text, /BEGIN CERTIFICATE/);
  });

  // 7. CA-serving listener
  await test('CA listener serves the cert but never the key', async () => {
    const started = await request(port, 'POST', '/api/ca/serve', { token: TOKEN, body: { on: true } });
    assert.strictEqual(started.json.serving, true);
    const m = /:(\d+)\/ca\.cer$/.exec(started.json.cerUrl);
    assert.ok(m, 'cerUrl should carry the port');
    const caPort = Number(m[1]);
    const cer = await request(caPort, 'GET', '/ca.cer');
    assert.strictEqual(cer.status, 200);
    assert.match(cer.headers['content-type'], /x509/);
    const mc = await request(caPort, 'GET', '/ca.mobileconfig');
    assert.strictEqual(mc.status, 200);
    assert.match(mc.text, /<plist/);
    const key = await request(caPort, 'GET', '/ca.key');
    assert.strictEqual(key.status, 404);
    await request(port, 'POST', '/api/ca/serve', { token: TOKEN, body: { on: false } });
  });

  // 8. net + lan
  await test('GET /api/net reports endpoints; POST /api/lan flips the bind host', async () => {
    const net = await request(port, 'GET', '/api/net', { token: TOKEN });
    for (const k of ['lanEnabled', 'ip', 'proxyPort', 'caServePort', 'serving', 'cerUrl', 'mobileconfigUrl', 'proxyHost']) {
      assert.ok(k in net.json, `net missing ${k}`);
    }
    assert.strictEqual(net.json.lanEnabled, false);
    assert.match(net.json.cerUrl, /^http:\/\/[^/]+\/ca\.cer$/);

    const on = await request(port, 'POST', '/api/lan', { token: TOKEN, body: { on: true } });
    assert.strictEqual(on.json.bindHost, '0.0.0.0');
    const off = await request(port, 'POST', '/api/lan', { token: TOKEN, body: { on: false } });
    assert.strictEqual(off.json.bindHost, '127.0.0.1');
  });

  // 8b. profiles (shareable tool configuration)
  await test('POST /api/profile/export returns an envelope and no secrets', async () => {
    const tx = store.create({ scheme: 'https', method: 'POST', host: 'api.example.com', port: 443, path: '/login' });
    tx.setRequest('POST', { authorization: 'Bearer LEAK-ME', 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ user: 'a', password: 'hunter2' })), '/login');
    tx.setResponse(200, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'), 4);
    store.finalize(tx);

    const r = await request(port, 'POST', '/api/profile/export', {
      token: TOKEN, body: { name: 'contract test', includeCaptures: true },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.ok(r.json.fileName.endsWith('.louie.json'), `bad fileName ${r.json.fileName}`);
    assert.ok(r.json.profile, 'export should return the profile body');
    assert.strictEqual(r.json.profile.kind, 'louie-profile');
    assert.ok(r.json.captures >= 1, 'expected the capture to be embedded');
    const raw = JSON.stringify(r.json.profile);
    assert.ok(!raw.includes('LEAK-ME'), 'Authorization leaked into the exported profile');
    assert.ok(!raw.includes('hunter2'), 'password leaked into the exported profile');
  });

  await test('POST /api/profile/inspect validates and describes without applying', async () => {
    const exported = await request(port, 'POST', '/api/profile/export', { token: TOKEN, body: { name: 'inspect me' } });
    const ok = await request(port, 'POST', '/api/profile/inspect', { token: TOKEN, body: { profile: exported.json.profile } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.info.name, 'inspect me');
    assert.ok('blocklist' in ok.json.info.sections, 'sections should be described');

    const bad = await request(port, 'POST', '/api/profile/inspect', { token: TOKEN, body: { profile: { kind: 'nope' } } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.ok, false);
    assert.ok(bad.json.error, 'inspect should explain why it rejected');
  });

  await test('POST /api/profile/import merges the selected sections', async () => {
    const profile = {
      kind: 'louie-profile', louieProfile: 1, name: 'import me',
      tools: {
        blocklist: [{ host: 'imported.example.com' }],
        enabled: { blocklist: true },
        sslLocations: [],
        mapRemote: [], mapLocal: [], rewrite: [],
        throttle: { latency: 0, bandwidthDown: 0, bandwidthUp: 0, hosts: [] },
      },
    };
    const r = await request(port, 'POST', '/api/profile/import', { token: TOKEN, body: { profile, sections: ['blocklist'] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.ok(r.json.applied.includes('blocklist'));

    const cfg = await request(port, 'GET', '/api/config', { token: TOKEN });
    assert.deepStrictEqual(cfg.json.blocklist, [{ host: 'imported.example.com' }],
      'the imported section should be live in the config');

    const bad = await request(port, 'POST', '/api/profile/import', { token: TOKEN, body: { profile: [] } });
    assert.strictEqual(bad.status, 400);
  });

  // 9. import error path
  await test('POST /api/import/charles reports a missing file', async () => {
    const r = await request(port, 'POST', '/api/import/charles', { token: TOKEN, body: { path: path.join(dir, 'nope.xml') } });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.ok, false);
  });

  // 10. SSE
  await test('/events streams hello then live tx updates', async () => {
    const chunks = [];
    let contentType = null;
    const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET', headers: { 'x-charles-token': TOKEN } }, (res) => {
      assert.strictEqual(res.statusCode, 200);
      contentType = res.headers['content-type'];
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
    });
    req.end();
    await waitFor(() => chunks.join('').includes('event: hello'));
    const tx = store.create({ scheme: 'https', method: 'GET', host: 'api.example.com', port: 443, path: '/live' });
    tx.setResponse(200, {}, Buffer.alloc(0), 1);
    store.finalize(tx);
    await waitFor(() => chunks.join('').includes('event: tx'));
    const text = chunks.join('');
    assert.match(contentType, /text\/event-stream/);
    assert.match(text, /event: hello\ndata: \{"count":\d+\}/);
    assert.match(text, /event: tx\ndata: \{/);
    req.destroy();
  });

  // 11. breakpoints
  await test('GET /api/breakpoints/pending is an empty array with no rules', async () => {
    const r = await request(port, 'GET', '/api/breakpoints/pending', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, []);
  });

  await test('breakpoint routes 404 for unknown ids', async () => {
    for (const op of ['continue', 'abort', 'edit']) {
      const r = await request(port, 'POST', `/api/breakpoint/424242/${op}`, { token: TOKEN, body: {} });
      assert.strictEqual(r.status, 404, `${op} should 404`);
      assert.strictEqual(r.json.ok, false);
      assert.strictEqual(r.json.error, 'not found');
    }
  });

  await test('a suspended transaction appears in /api/breakpoints/pending and is resumable', async () => {
    // Suspend a synthesized transaction against the manager directly: the API
    // contract is what is pinned here, the proxy path is covered in e2e.js.
    config.breakpoints = { enabled: true, timeoutMs: 10000,
      rules: [{ enabled: true, scope: 'request', location: { host: 'api.example.com' } }] };
    breakpoints.setConfig(config);
    const tx = store.create({ scheme: 'https', method: 'POST', host: 'api.example.com', port: 443, path: '/bp' });
    tx.setRequest('POST', { 'content-type': 'application/json' }, Buffer.from('{"a":1}'), '/bp');
    const suspended = breakpoints.maybeSuspend(tx, 'request');

    await waitFor(() => breakpoints.pending.size === 1);
    const pending = await request(port, 'GET', '/api/breakpoints/pending', { token: TOKEN });
    assert.strictEqual(pending.json.length, 1);
    const hit = pending.json[0];
    for (const k of ['id', 'transactionId', 'phase', 'summary', 'request', 'response', 'deadline']) {
      assert.ok(k in hit, `hit missing ${k}`);
    }
    assert.strictEqual(hit.phase, 'request');
    assert.strictEqual(hit.request.method, 'POST');
    assert.strictEqual(hit.request.body.type, 'text');
    assert.strictEqual(hit.request.body.editable, true);

    // status reports it
    const st = await request(port, 'GET', '/api/status', { token: TOKEN });
    assert.strictEqual(st.json.breakpointsEnabled, true);
    assert.strictEqual(st.json.pendingBreakpoints, 1);

    const cont = await request(port, 'POST', `/api/breakpoint/${hit.id}/continue`, { token: TOKEN, body: {} });
    assert.strictEqual(cont.status, 200);
    assert.strictEqual(cont.json.ok, true);
    assert.strictEqual(cont.json.action, 'continue');
    assert.strictEqual(cont.json.transactionId, tx.id);
    const result = await suspended;
    assert.strictEqual(result.action, 'continue');
    assert.strictEqual(breakpoints.pending.size, 0);

    config.breakpoints = { enabled: false, timeoutMs: 10000, rules: [] };
    breakpoints.setConfig(config);
  });

  await test('edit applies the request changes before resuming', async () => {
    config.breakpoints = { enabled: true, timeoutMs: 10000,
      rules: [{ enabled: true, scope: 'request', location: { host: 'api.example.com' } }] };
    breakpoints.setConfig(config);
    const tx = store.create({ scheme: 'https', method: 'GET', host: 'api.example.com', port: 443, path: '/edit-me' });
    tx.setRequest('GET', {}, Buffer.alloc(0), '/edit-me');
    const suspended = breakpoints.maybeSuspend(tx, 'request');
    await waitFor(() => breakpoints.pending.size === 1);
    const hit = [...breakpoints.pending.values()][0];

    const r = await request(port, 'POST', `/api/breakpoint/${hit.id}/edit`, { token: TOKEN, body: {
      request: { method: 'PUT', body: { type: 'text', text: 'PATCHED' } },
    } });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.edited, true);
    await suspended;
    assert.strictEqual(tx.method, 'PUT');
    assert.strictEqual(tx.requestBody.toString(), 'PATCHED');
    assert.strictEqual(tx.requestHeaders['content-length'], '7');

    config.breakpoints = { enabled: false, timeoutMs: 10000, rules: [] };
    breakpoints.setConfig(config);
  });

  await test('abort resolves the breakpoint with the abort action', async () => {
    config.breakpoints = { enabled: true, timeoutMs: 10000,
      rules: [{ enabled: true, scope: 'response', location: { host: 'api.example.com' } }] };
    breakpoints.setConfig(config);
    const tx = store.create({ scheme: 'https', method: 'GET', host: 'api.example.com', port: 443, path: '/abort-me' });
    tx.setResponse(200, { 'content-type': 'text/plain' }, Buffer.from('hi'), 1);
    const suspended = breakpoints.maybeSuspend(tx, 'response');
    await waitFor(() => breakpoints.pending.size === 1);
    const hit = [...breakpoints.pending.values()][0];
    const r = await request(port, 'POST', `/api/breakpoint/${hit.id}/abort`, { token: TOKEN, body: {} });
    assert.strictEqual(r.json.action, 'abort');
    const result = await suspended;
    assert.strictEqual(result.action, 'abort');

    config.breakpoints = { enabled: false, timeoutMs: 10000, rules: [] };
    breakpoints.setConfig(config);
  });

  await test('/events emits a breakpoint frame on hit and on resume', async () => {
    const chunks = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET', headers: { 'x-charles-token': TOKEN } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
    });
    req.end();
    await waitFor(() => chunks.join('').includes('event: hello'));

    config.breakpoints = { enabled: true, timeoutMs: 10000,
      rules: [{ enabled: true, scope: 'request', location: { host: 'sse.example.com' } }] };
    breakpoints.setConfig(config);
    const tx = store.create({ scheme: 'https', method: 'GET', host: 'sse.example.com', port: 443, path: '/sse' });
    tx.setRequest('GET', {}, Buffer.alloc(0), '/sse');
    const suspended = breakpoints.maybeSuspend(tx, 'request');

    await waitFor(() => chunks.join('').includes('event: breakpoint'));
    const text = chunks.join('');
    assert.match(text, /event: breakpoint\ndata: \{[^\n]*"pending":true/, 'hit frame should be pending');

    const hit = [...breakpoints.pending.values()][0];
    await request(port, 'POST', `/api/breakpoint/${hit.id}/continue`, { token: TOKEN, body: {} });
    await suspended;
    await waitFor(() => /"pending":false/.test(chunks.join('')));
    assert.match(chunks.join(''), /"pending":false/, 'resume frame should not be pending');

    config.breakpoints = { enabled: false, timeoutMs: 10000, rules: [] };
    breakpoints.setConfig(config);
    req.destroy();
  });

  // 12. clear
  await test('POST /api/clear empties the session', async () => {
    const before = await request(port, 'GET', '/api/transactions', { token: TOKEN });
    assert.ok(before.json.length > 0, 'should have transactions to clear');
    const c = await request(port, 'POST', '/api/clear', { token: TOKEN });
    assert.strictEqual(c.json.ok, true);
    const after = await request(port, 'GET', '/api/transactions', { token: TOKEN });
    assert.strictEqual(after.json.length, 0);
  });

  await new Promise((r) => web.server.close(r));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
