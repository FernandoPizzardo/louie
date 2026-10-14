#!/usr/bin/env node
'use strict';
/**
 * louie-mcp.js — a read-only MCP server over Louie's session history.
 *
 * Speaks the Model Context Protocol over stdio and reads the JSON session files
 * directly, so it works whether or not the Louie engine is running.
 *
 * Data dir: --dir <path>, or $LOUIE_DATA_DIR, else the app's default
 * (~/Library/Application Support/Louie/sessions-data) or the CLI default
 * (~/.charles-clone/sessions-data), whichever exists.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIRS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Louie', 'sessions-data'),
  path.join(os.homedir(), '.charles-clone', 'sessions-data'),
];

function resolveDir() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--dir');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  if (process.env.LOUIE_DATA_DIR) return process.env.LOUIE_DATA_DIR;
  for (const d of DEFAULT_DIRS) if (fs.existsSync(d)) return d;
  return DEFAULT_DIRS[0];
}

const DIR = resolveDir();

function readRecords() {
  const byKey = new Map();
  const sessions = path.join(DIR, 'sessions');
  const saved = path.join(DIR, 'saved');
  try {
    for (const f of fs.readdirSync(sessions).filter((f) => f.endsWith('.jsonl')).sort()) {
      let text = '';
      try { text = fs.readFileSync(path.join(sessions, f), 'utf8'); } catch (_) { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          r.saved = false;
          byKey.set(String(r.id), r);
        } catch (_) {}
      }
    }
  } catch (_) {}
  // Pinned copies mark the matching session record (and add it if absent),
  // rather than being counted as a separate transaction.
  try {
    for (const f of fs.readdirSync(saved).filter((f) => f.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(saved, f), 'utf8'));
        r.saved = true;
        r._file = f;
        byKey.set(String(r.id), r);
      } catch (_) {}
    }
  } catch (_) {}
  const recs = [...byKey.values()];
  recs.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return recs;
}

const lower = (s) => String(s == null ? '' : s).toLowerCase();

function filterRecords(recs, a = {}) {
  let out = recs;
  if (a.host) out = out.filter((r) => lower(r.host).includes(lower(a.host)));
  if (a.path) out = out.filter((r) => lower(r.path).includes(lower(a.path)));
  if (a.method) out = out.filter((r) => lower(r.method) === lower(a.method));
  if (a.status) out = out.filter((r) => Number(r.status) === Number(a.status));
  if (a.tool) out = out.filter((r) => (r.notes || []).some((n) => lower(n.tool).includes(lower(a.tool))));
  if (a.since) out = out.filter((r) => (r.ts || '') >= a.since);
  if (a.until) out = out.filter((r) => (r.ts || '') <= a.until);
  if (a.savedOnly) out = out.filter((r) => r.saved);
  return out;
}

function summary(r) {
  return {
    id: r.id, ts: r.ts, method: r.method, scheme: r.scheme, host: r.host, port: r.port,
    path: r.path, status: r.status, durationMs: r.durationMs, sslProxied: r.sslProxied,
    error: r.error, saved: !!r.saved,
    tools: (r.notes || []).map((n) => n.tool),
    reqBytes: r.request && r.request.body ? r.request.body.size : 0,
    resBytes: r.response && r.response.body ? r.response.body.size : 0,
    truncated: !!((r.request && r.request.body && r.request.body.truncated) ||
                  (r.response && r.response.body && r.response.body.truncated)),
  };
}

const TOOLS = [
  {
    name: 'list_transactions',
    description: 'List captured calls, newest first. Optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' }, path: { type: 'string' }, method: { type: 'string' },
        status: { type: 'integer' }, tool: { type: 'string' },
        since: { type: 'string', description: 'ISO timestamp lower bound' },
        until: { type: 'string', description: 'ISO timestamp upper bound' },
        savedOnly: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    },
    run: (a) => {
      const recs = filterRecords(readRecords(), a).slice(0, a.limit || 50);
      return { count: recs.length, transactions: recs.map(summary) };
    },
  },
  {
    name: 'get_transaction',
    description: 'Full record for one call (headers, bodies, notes, timing).',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: (a) => {
      const r = readRecords().find((x) => Number(x.id) === Number(a.id));
      if (!r) throw new Error(`transaction ${a.id} not found`);
      return r;
    },
  },
  {
    name: 'search_bodies',
    description: 'Case-insensitive text search across request and response bodies.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    run: (a) => {
      const q = lower(a.query);
      const hits = [];
      for (const r of readRecords()) {
        const reqT = (r.request && r.request.body && r.request.body.text) || '';
        const resT = (r.response && r.response.body && r.response.body.text) || '';
        if (lower(reqT).includes(q) || lower(resT).includes(q)) {
          hits.push({ ...summary(r), inRequest: lower(reqT).includes(q), inResponse: lower(resT).includes(q) });
        }
        if (hits.length >= (a.limit || 50)) break;
      }
      return { query: a.query, count: hits.length, matches: hits };
    },
  },
  {
    name: 'diff_transactions',
    description: 'Compare two calls: status, headers and bodies (useful before/after a Rewrite).',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    },
    run: (a) => {
      const recs = readRecords();
      const x = recs.find((r) => Number(r.id) === Number(a.a));
      const y = recs.find((r) => Number(r.id) === Number(a.b));
      if (!x || !y) throw new Error('one or both transactions not found');
      const bodyOf = (r) => (r.response && r.response.body && r.response.body.text) || '';
      const hdrsOf = (r) => (r.response && r.response.headers) || {};
      const keys = new Set([...Object.keys(hdrsOf(x)), ...Object.keys(hdrsOf(y))]);
      const headerDiffs = [];
      for (const k of keys) {
        const xv = hdrsOf(x)[k], yv = hdrsOf(y)[k];
        if (JSON.stringify(xv) !== JSON.stringify(yv)) headerDiffs.push({ header: k, a: xv ?? null, b: yv ?? null });
      }
      return {
        a: summary(x), b: summary(y),
        statusChanged: x.status !== y.status,
        headerDiffs,
        bodyChanged: bodyOf(x) !== bodyOf(y),
        bodyA: bodyOf(x).slice(0, 4000),
        bodyB: bodyOf(y).slice(0, 4000),
      };
    },
  },
  {
    name: 'list_saved',
    description: 'List pinned (user-saved) calls.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ saved: readRecords().filter((r) => r.saved).map(summary) }),
  },
  {
    name: 'get_saved',
    description: 'Full record for a pinned call by its file name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: (a) => {
      const r = readRecords().find((x) => x._file === a.name);
      if (!r) throw new Error(`saved record ${a.name} not found`);
      return r;
    },
  },
  {
    name: 'summarize_session',
    description: 'Hosts, error rate and slowest endpoints across captured calls.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, limit: { type: 'integer' } } },
    run: (a) => {
      const recs = filterRecords(readRecords(), a);
      const byHost = {}, byEndpoint = {};
      let errors = 0;
      for (const r of recs) {
        byHost[r.host] = (byHost[r.host] || 0) + 1;
        const ep = `${r.method} ${r.host}${r.path}`;
        byEndpoint[ep] = byEndpoint[ep] || { count: 0, maxMs: 0 };
        byEndpoint[ep].count++;
        byEndpoint[ep].maxMs = Math.max(byEndpoint[ep].maxMs, r.durationMs || 0);
        if ((r.status && r.status >= 400) || r.error) errors++;
      }
      const slowest = Object.entries(byEndpoint).map(([ep, v]) => ({ endpoint: ep, ...v }))
        .sort((x, y) => y.maxMs - x.maxMs).slice(0, a.limit || 10);
      return {
        total: recs.length,
        errors,
        errorRate: recs.length ? +(errors / recs.length).toFixed(3) : 0,
        hosts: Object.entries(byHost).map(([host, count]) => ({ host, count })).sort((x, y) => y.count - x.count),
        slowest,
      };
    },
  },
];

// ---------------- MCP stdio plumbing ----------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'louie-mcp', version: '1.0.0' },
    } };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    } };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params && params.name}` } };
    try {
      const result = tool.run((params && params.arguments) || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } };
    }
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return null;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).then((r) => { if (r) send(r); }).catch((e) => {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
    });
  }
});
process.stdin.on('end', () => process.exit(0));
