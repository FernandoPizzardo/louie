'use strict';
/**
 * louie-mcp tests — drive the stdio MCP server over a seeded data dir.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'louie-mcp-'));
const SESS = path.join(DIR, 'sessions');
const SAVED = path.join(DIR, 'saved');
fs.mkdirSync(SESS, { recursive: true });
fs.mkdirSync(SAVED, { recursive: true });

const rec = (id, over = {}) => ({
  id, ts: new Date(Date.now() + id * 1000).toISOString(), scheme: 'https', method: 'GET',
  host: 'api.example.com', port: 443, path: `/v1/${id}`, status: id === 2 ? 500 : 200, durationMs: id * 10,
  sslProxied: true, error: null, notes: [{ tool: 'Rewrite', text: 'body rewritten' }],
  request: { headers: { accept: '*/*' }, body: { type: 'text', text: `{\"id\":${id}}`, size: 8, truncated: false } },
  response: { headers: { 'content-type': 'application/json' }, body: { type: 'text', text: `{\"ok\":true,\"n\":${id}}`, size: 16, truncated: false } },
  ...over,
});
const RECS = [rec(1), rec(2), rec(3)];
fs.writeFileSync(path.join(SESS, '2026-01-01.jsonl'), RECS.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(SAVED, '3-123.json'), JSON.stringify({ ...RECS[2], saved: true }));

const child = spawn('node', [path.join(__dirname, '..', 'bin', 'louie-mcp.js'), '--dir', DIR], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function tool(name, args) { return call('tools/call', { name, arguments: args || {} }); }
const parse = (r) => JSON.parse(r.result.content[0].text);

(async () => {
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  await test('tools/list exposes the expected tools', async () => {
    const r = await call('tools/list', {});
    const names = r.result.tools.map((t) => t.name);
    for (const n of ['list_transactions', 'get_transaction', 'search_bodies', 'diff_transactions', 'list_saved', 'get_saved', 'summarize_session', 'delete_transactions']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  });

  await test('list_transactions returns newest first', async () => {
    const r = parse(await tool('list_transactions', {}));
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.transactions[0].id, 3);
  });

  await test('list_transactions filters by status', async () => {
    const r = parse(await tool('list_transactions', { status: 500 }));
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.transactions[0].id, 2);
  });

  await test('get_transaction returns the full record', async () => {
    const r = parse(await tool('get_transaction', { id: 1 }));
    assert.strictEqual(r.host, 'api.example.com');
    assert.match(r.response.body.text, /"ok":true/);
  });

  await test('search_bodies finds text in responses', async () => {
    const r = parse(await tool('search_bodies', { query: 'ok' }));
    assert.ok(r.count >= 3);
  });

  await test('diff_transactions reports the status change', async () => {
    const r = parse(await tool('diff_transactions', { a: 1, b: 2 }));
    assert.strictEqual(r.statusChanged, true);
    assert.strictEqual(r.a.id, 1);
    assert.strictEqual(r.b.id, 2);
  });

  await test('list_saved and get_saved use pinned copies', async () => {
    const ls = parse(await tool('list_saved', {}));
    assert.strictEqual(ls.saved.length, 1);
    const g = parse(await tool('get_saved', { name: '3-123.json' }));
    assert.strictEqual(g.saved, true);
  });

  await test('summarize_session reports totals and errors', async () => {
    const r = parse(await tool('summarize_session', {}));
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.errors, 1);
    assert.ok(r.hosts.some((h) => h.host === 'api.example.com'));
  });

  await test('unknown tool returns a JSON-RPC error', async () => {
    const r = await tool('nope', {});
    assert.ok(r.error && /unknown tool/.test(r.error.message), JSON.stringify(r));
  });

  await test('delete_transactions refuses an unbounded wipe', async () => {
    const r = await tool('delete_transactions', {});
    assert.ok(r.result.isError, JSON.stringify(r));
    const list = parse(await tool('list_transactions', {}));
    assert.strictEqual(list.count, 3);
  });

  await test('delete_transactions dryRun previews without writing', async () => {
    const r = parse(await tool('delete_transactions', { host: 'api.example.com', dryRun: true }));
    assert.strictEqual(r.deleted, 0);
    assert.ok(r.matched >= 3, `matched ${r.matched}`);
    assert.strictEqual(r.savedSkipped, 1);
    assert.strictEqual(r.freedBytes, 0);
    assert.ok(r.wouldFreeBytes > 0);
    const list = parse(await tool('list_transactions', {}));
    assert.strictEqual(list.count, 3);
  });

  await test('delete_transactions removes matching session records', async () => {
    const r = parse(await tool('delete_transactions', { host: 'api.example.com', status: 500 }));
    assert.strictEqual(r.deleted, 1);
    assert.ok(r.freedBytes > 0);
    const list = parse(await tool('list_transactions', {}));
    assert.strictEqual(list.count, 2);
    assert.ok(!list.transactions.some((t) => t.id === 2));
  });

  await test('delete_transactions can drop pinned copies', async () => {
    const r = parse(await tool('delete_transactions', { savedOnly: true, includeSaved: true }));
    assert.strictEqual(r.savedDeleted, 1);
    const ls = parse(await tool('list_saved', {}));
    assert.strictEqual(ls.saved.length, 0);
  });

  child.kill();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
