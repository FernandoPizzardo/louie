'use strict';
/**
 * session-log.js — durable, redacted session history for the MCP server.
 *
 * Two kinds of records:
 *   sessions/YYYY-MM-DD.jsonl   append-only log of finished calls (auto, opt-in,
 *                               7-day retention, bodies truncated at a cap)
 *   saved/<id>-<ts>.json        a pinned, read-only copy the user chose to keep
 *                               (full bodies, exempt from retention)
 *
 * Redaction runs before anything is written, so secrets never reach disk.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BODY = 512 * 1024;   // 512 KB
const DEFAULT_RETENTION_DAYS = 7;

class SessionLog {
  constructor(opts = {}) {
    this.dir = opts.dir;
    this.enabled = !!opts.enabled;
    this.maxBodyBytes = opts.maxBodyBytes || DEFAULT_MAX_BODY;
    this.retentionDays = opts.retentionDays || DEFAULT_RETENTION_DAYS;
    this.redact = opts.redact || {};
    this.sessionDir = path.join(this.dir || '.', 'sessions');
    this.savedDir = path.join(this.dir || '.', 'saved');
  }

  _ensure(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }

  /** Apply changed settings (persist / redact) without a restart. */
  configure(opts = {}) {
    if (opts.dir) { this.dir = opts.dir; this.sessionDir = path.join(this.dir, 'sessions'); this.savedDir = path.join(this.dir, 'saved'); }
    if (opts.enabled !== undefined) this.enabled = !!opts.enabled;
    if (opts.maxBodyBytes) this.maxBodyBytes = opts.maxBodyBytes;
    if (opts.retentionDays) this.retentionDays = opts.retentionDays;
    if (opts.redact) this.redact = opts.redact;
  }

  // ---------- redaction ----------
  _redactHeaders(headers) {
    if (!headers || this.redact.enabled === false) return { ...(headers || {}) };
    const names = new Set((this.redact.headers || ['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])
      .map((h) => h.toLowerCase()));
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = names.has(k.toLowerCase()) ? '[redacted]' : v;
    }
    return out;
  }

  _redactText(text, contentType) {
    if (this.redact.enabled === false || typeof text !== 'string' || !text) return text;
    const fields = new Set((this.redact.fields || ['password', 'token', 'access_token', 'refresh_token', 'secret', 'apikey', 'api_key', 'authorization'])
      .map((f) => f.toLowerCase()));
    const looksJSON = /json/i.test(contentType || '') || /^\s*[[{]/.test(text);
    if (looksJSON) {
      try {
        const obj = JSON.parse(text);
        const walk = (v) => {
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const o = {};
            for (const [k, val] of Object.entries(v)) o[k] = fields.has(k.toLowerCase()) ? '[redacted]' : walk(val);
            return o;
          }
          return v;
        };
        return JSON.stringify(walk(obj));
      } catch (_) { /* fall through to regex */ }
    }
    // form-encoded / plain: mask "key=value" pairs for known fields
    let out = text;
    for (const f of fields) {
      const re = new RegExp('("?' + f + '"?\\s*[=:]\\s*)("[^"]*"|[^&\\s,}]+)', 'ig');
      out = out.replace(re, '$1[redacted]');
    }
    return out;
  }

  _body(buf, headers) {
    if (!buf || !buf.length) return { type: 'empty', text: '', size: 0, truncated: false };
    const ct = headers && (headers['content-type'] || headers['Content-Type']);
    const size = buf.length;
    const truncated = size > this.maxBodyBytes;
    const slice = truncated ? buf.slice(0, this.maxBodyBytes) : buf;
    const text = this._redactText(slice.toString('utf8'), ct);
    return { type: 'text', text, size, truncated };
  }

  /** Build a redacted, size-capped record for one transaction. */
  record(tx, { full = false } = {}) {
    const cap = full ? Infinity : this.maxBodyBytes;
    const body = (buf, headers) => {
      if (!buf || !buf.length) return { type: 'empty', text: '', size: 0, truncated: false };
      const ct = headers && (headers['content-type'] || headers['Content-Type']);
      const size = buf.length;
      const truncated = size > cap;
      const slice = truncated ? buf.slice(0, cap) : buf;
      return { type: 'text', text: this._redactText(slice.toString('utf8'), ct), size, truncated };
    };
    return {
      id: tx.id,
      ts: new Date(tx.start || Date.now()).toISOString(),
      scheme: tx.scheme,
      method: tx.method,
      host: tx.host,
      port: tx.port,
      path: tx.path,
      status: tx.status,
      durationMs: tx.durationMs,
      sslProxied: !!tx.sslProxied,
      tunneled: !!tx.tunneled,
      error: tx.error || null,
      notes: tx.notes || [],
      request: { headers: this._redactHeaders(tx.requestHeaders), body: body(tx.requestBody, tx.requestHeaders) },
      response: { headers: this._redactHeaders(tx.responseHeaders), body: body(tx.responseBody, tx.responseHeaders) },
    };
  }

  // ---------- append ----------
  append(tx) {
    if (!this.enabled) return null;
    this._ensure(this.sessionDir);
    const rec = this.record(tx);
    rec.saved = false;
    const day = new Date(tx.start || Date.now()).toISOString().slice(0, 10);
    const file = path.join(this.sessionDir, `${day}.jsonl`);
    try { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch (_) { return null; }
    return file;
  }

  // ---------- save (pinned, read-only) ----------
  save(tx, { full = false } = {}) {
    this._ensure(this.savedDir);
    const rec = this.record(tx, { full });
    rec.saved = true;
    rec.savedAt = new Date().toISOString();
    const name = `${tx.id}-${Date.now()}.json`;
    const file = path.join(this.savedDir, name);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    try { fs.chmodSync(file, 0o444); } catch (_) {}
    return { name, path: file, truncated: rec.request.body.truncated || rec.response.body.truncated };
  }

  /** Body size that would require confirmation before saving the full body. */
  oversized(tx) {
    const size = Math.max(tx.requestBody ? tx.requestBody.length : 0, tx.responseBody ? tx.responseBody.length : 0);
    return size > this.maxBodyBytes ? size : 0;
  }

  listSaved() {
    try {
      return fs.readdirSync(this.savedDir).filter((f) => f.endsWith('.json')).map((f) => {
        const full = path.join(this.savedDir, f);
        let st = {};
        try { st = fs.statSync(full); } catch (_) {}
        return { name: f, size: st.size, mtime: st.mtime ? st.mtime.toISOString() : null };
      }).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
    } catch (_) { return []; }
  }

  getSaved(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
    const file = path.join(this.savedDir, name);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  // ---------- retention ----------
  prune(now = Date.now()) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const f of fs.readdirSync(this.sessionDir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        const t = Date.parse(m[1] + 'T00:00:00Z');
        if (Number.isFinite(t) && t < cutoff) {
          try { fs.unlinkSync(path.join(this.sessionDir, f)); removed++; } catch (_) {}
        }
      }
    } catch (_) {}
    return removed;
  }
}

module.exports = { SessionLog, DEFAULT_MAX_BODY, DEFAULT_RETENTION_DAYS };
