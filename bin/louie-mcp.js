#!/usr/bin/env node
'use strict';
/**
 * louie-mcp.js — an MCP server over Louie's session history.
 *
 * Speaks the Model Context Protocol over stdio and reads/writes the JSON session
 * files directly, so it works whether or not the Louie engine is running. It is
 * read-only apart from `delete_transactions`, which prunes captured history from
 * disk (it never touches the live engine's in-memory store).
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

const SESSIONS_DIR = path.join(DIR, 'sessions');
const SAVED_DIR = path.join(DIR, 'saved');

/** Session-file lines as { file, index, line, rec } (index = line number). */
function scanSessions() {
  const out = [];
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
      const full = path.join(SESSIONS_DIR, f);
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const rec = JSON.parse(lines[i]);
          rec.saved = false;
          out.push({ file: full, index: i, line: lines[i], rec });
        } catch (_) {}
      }
    }
  } catch (_) {}
  return out;
}

/** Pinned copies as { file, name, rec }. */
function scanSaved() {
  const out = [];
  try {
    for (const f of fs.readdirSync(SAVED_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(SAVED_DIR, f), 'utf8'));
        rec.saved = true;
        rec._file = f;
        out.push({ file: path.join(SAVED_DIR, f), name: f, rec });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

/** Replace a file's contents in one step, so a partial write can't corrupt it. */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function readRecords() {
  const byKey = new Map();
  // Pinned copies mark the matching session record (and add it if absent),
  // rather than being counted as a separate transaction.
  for (const e of scanSessions()) byKey.set(String(e.rec.id), e.rec);
  for (const e of scanSaved()) byKey.set(String(e.rec.id), e.rec);
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
  {
    name: 'delete_transactions',
    description: 'Delete captured calls from Louie\'s session history (irreversible). ' +
      'Uses the same filters as list_transactions, or explicit `ids`. Refuses to ' +
      'delete everything unless confirmAll:true. Pass dryRun:true to preview what ' +
      'would go. Pinned copies are left alone unless includeSaved:true. ' +
      'Example: delete_transactions { host: "abs.twimg.com" } clears bulky assets.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' }, path: { type: 'string' }, method: { type: 'string' },
        status: { type: 'integer' }, tool: { type: 'string' },
        since: { type: 'string', description: 'ISO timestamp lower bound' },
        until: { type: 'string', description: 'ISO timestamp upper bound' },
        savedOnly: { type: 'boolean' },
        ids: { type: 'array', items: { type: 'integer' }, description: 'Explicit transaction ids to delete' },
        includeSaved: { type: 'boolean', description: 'Also remove matching pinned copies' },
        dryRun: { type: 'boolean', description: 'Preview matches without deleting' },
        confirmAll: { type: 'boolean', description: 'Required to delete with no filters or ids' },
        limit: { type: 'integer', description: 'Max matches to list in the result (default 50)' },
      },
    },
    run: (a) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(Number).filter(Number.isFinite) : null;
      const useIds = !!(ids && ids.length);
      const hasFilter = ['host', 'path', 'method', 'status', 'tool', 'since', 'until']
        .some((k) => a[k] !== undefined && a[k] !== '' && a[k] !== null) || a.savedOnly === true;
      if (!useIds && !hasFilter && a.confirmAll !== true) {
        throw new Error('refusing to delete all history: pass filters, ids, or confirmAll:true');
      }

      const isMatch = (rec, isSaved) => {
        if (useIds) return ids.includes(Number(rec.id));
        if (a.savedOnly && !isSaved) return false;
        return filterRecords([rec], a).length > 0;
      };

      const includeSaved = a.includeSaved === true;
      const preview = [];
      const drop = new Map();        // session file -> Set(line index)
      const bytesByFile = new Map(); // session file -> bytes that would be freed
      let matched = 0, wouldFreeBytes = 0, savedSkipped = 0;
      const savedHits = [];

      for (const e of scanSessions()) {
        if (!isMatch(e.rec, false)) continue;
        matched++;
        const bytes = Buffer.byteLength(e.line) + 1;
        wouldFreeBytes += bytes;
        bytesByFile.set(e.file, (bytesByFile.get(e.file) || 0) + bytes);
        if (!drop.has(e.file)) drop.set(e.file, new Set());
        drop.get(e.file).add(e.index);
        if (preview.length < (a.limit || 50)) preview.push(summary(e.rec));
      }
      for (const e of scanSaved()) {
        if (!isMatch(e.rec, true)) continue;
        matched++;
        if (includeSaved) savedHits.push({ ...e, bytes: (() => { try { return fs.statSync(e.file).size; } catch (_) { return 0; } })() });
        else savedSkipped++;
      }

      const plan = [...drop.entries()].map(([file, idx]) => ({ file: path.basename(file), removed: idx.size, bytes: bytesByFile.get(file) || 0 }));
      for (const h of savedHits) plan.push({ file: h.name, removed: 1, bytes: h.bytes });

      let deleted = 0, savedDeleted = 0, freedBytes = 0;
      if (!a.dryRun) {
        for (const [file, idx] of drop) {
          try {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            writeAtomic(file, lines.filter((_, i) => !idx.has(i)).join('\n'));
            deleted += idx.size;
          } catch (_) {}
        }
        for (const h of savedHits) {
          try { fs.unlinkSync(h.file); savedDeleted++; } catch (_) {}
        }
        freedBytes = plan.reduce((s, p) => s + p.bytes, 0);
      }

      return {
        dryRun: !!a.dryRun,
        matched,
        deleted,
        savedDeleted,
        savedSkipped,
        wouldFreeBytes,
        freedBytes,
        files: plan,
        transactions: preview,
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
