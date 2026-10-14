'use strict';
/**
 * session-log tests — durability, redaction, truncation, pinning, retention.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionLog } = require('../lib/session-log');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'louie-log-')); }

function makeTx(over = {}) {
  return {
    id: 1, start: Date.now(), scheme: 'https', method: 'POST', host: 'api.example.com', port: 443,
    path: '/login', status: 200, durationMs: 12, sslProxied: true, tunneled: false, error: null,
    notes: [{ tool: 'Rewrite', text: 'x' }],
    requestHeaders: { authorization: 'Bearer SECRET', 'content-type': 'application/json', accept: '*/*' },
    requestBody: Buffer.from(JSON.stringify({ user: 'a', password: 'hunter2', token: 'abc' })),
    responseHeaders: { 'set-cookie': 'sid=xyz', 'content-type': 'application/json' },
    responseBody: Buffer.from(JSON.stringify({ ok: true, access_token: 'zzz' })),
    ...over,
  };
}

test('record redacts sensitive headers and JSON fields', () => {
  const log = new SessionLog({ dir: tmp(), enabled: true });
  const rec = log.record(makeTx());
  assert.strictEqual(rec.request.headers.authorization, '[redacted]');
  assert.strictEqual(rec.response.headers['set-cookie'], '[redacted]');
  assert.strictEqual(rec.request.headers.accept, '*/*');
  const reqBody = JSON.parse(rec.request.body.text);
  assert.strictEqual(reqBody.password, '[redacted]');
  assert.strictEqual(reqBody.token, '[redacted]');
  assert.strictEqual(reqBody.user, 'a');
  assert.strictEqual(JSON.parse(rec.response.body.text).access_token, '[redacted]');
});

test('append writes JSONL only when enabled', () => {
  const dir = tmp();
  const off = new SessionLog({ dir, enabled: false });
  assert.strictEqual(off.append(makeTx()), null);
  assert.ok(!fs.existsSync(path.join(dir, 'sessions')));

  const on = new SessionLog({ dir, enabled: true });
  const file = on.append(makeTx());
  assert.ok(file && fs.existsSync(file));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).host, 'api.example.com');
});

test('bodies are truncated at the cap and flagged', () => {
  const log = new SessionLog({ dir: tmp(), enabled: true, maxBodyBytes: 32 });
  const big = Buffer.from('x'.repeat(100));
  const rec = log.record(makeTx({ responseBody: big }));
  assert.strictEqual(rec.response.body.truncated, true);
  assert.strictEqual(rec.response.body.size, 100);
  assert.strictEqual(rec.response.body.text.length, 32);
});

test('oversized reports bodies over the cap; save can keep the full body', () => {
  const log = new SessionLog({ dir: tmp(), enabled: true, maxBodyBytes: 32 });
  const tx = makeTx({ responseBody: Buffer.from('y'.repeat(100)) });
  assert.strictEqual(log.oversized(tx), 100);

  const trunc = log.save(tx, { full: false });
  const a = log.getSaved(trunc.name);
  assert.strictEqual(a.response.body.truncated, true);

  const whole = log.save(tx, { full: true });
  const b = log.getSaved(whole.name);
  assert.strictEqual(b.response.body.truncated, false);
  assert.strictEqual(b.response.body.text.length, 100);
});

test('saved copies are read-only and listed', () => {
  const log = new SessionLog({ dir: tmp(), enabled: true });
  const s = log.save(makeTx());
  const mode = fs.statSync(s.path).mode & 0o777;
  assert.strictEqual(mode, 0o444, `expected 0444, got ${mode.toString(8)}`);
  const list = log.listSaved();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, s.name);
});

test('prune removes session files older than retention, keeps recent', () => {
  const dir = tmp();
  const log = new SessionLog({ dir, enabled: true, retentionDays: 7 });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const old = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) + '.jsonl';
  const recent = new Date().toISOString().slice(0, 10) + '.jsonl';
  fs.writeFileSync(path.join(dir, 'sessions', old), '{}\n');
  fs.writeFileSync(path.join(dir, 'sessions', recent), '{}\n');
  const removed = log.prune();
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'sessions', old)));
  assert.ok(fs.existsSync(path.join(dir, 'sessions', recent)));
});

test('prune never deletes pinned saved copies', () => {
  const dir = tmp();
  const log = new SessionLog({ dir, enabled: true, retentionDays: 7 });
  const s = log.save(makeTx());
  log.prune(Date.now() + 365 * 864e5);
  assert.ok(fs.existsSync(s.path), 'pinned copy must survive retention');
});

test('configure toggles persistence without a restart', () => {
  const dir = tmp();
  const log = new SessionLog({ dir, enabled: false });
  assert.strictEqual(log.append(makeTx()), null);
  log.configure({ enabled: true });
  assert.ok(log.append(makeTx()));
});

test('getSaved rejects path traversal', () => {
  const log = new SessionLog({ dir: tmp(), enabled: true });
  assert.strictEqual(log.getSaved('../secret'), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
