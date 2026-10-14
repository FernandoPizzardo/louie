'use strict';
/**
 * store.js — Session/Transaction model + event bus.
 * Mirrors com/xk72/charles/model/{Session,Transaction}. Charles keeps every
 * request/response pair as a Transaction in a Session tree; the GUI subscribes
 * to changes. We keep them in memory and push deltas to the web UI over SSE.
 */
const zlib = require('zlib');
const { EventEmitter } = require('events');

let NEXT_ID = 1;

class Transaction {
  constructor(meta) {
    this.id = NEXT_ID++;
    this.start = Date.now();
    this.scheme = meta.scheme;
    this.method = meta.method;
    this.host = meta.host;
    this.port = meta.port == null ? meta.port : Number(meta.port);
    this.path = meta.path || '';
    this.clientIp = meta.clientIp;
    this.sslProxied = !!meta.sslProxied;
    this.status = 0;
    this.durationMs = 0;
    this.requestHeaders = {};
    this.requestBody = Buffer.alloc(0);
    this.responseHeaders = {};
    this.responseBody = Buffer.alloc(0);
    this.error = null;
    this.complete = false;
    // tool annotations (which tools touched this tx) — shown as notes in the UI
    this.notes = [];
  }

  setRequest(method, headers, body, path) {
    this.method = method; this.requestHeaders = { ...headers };
    this.requestBody = body || Buffer.alloc(0); this.path = path || this.path;
  }

  setResponse(status, headers, body, durationMs) {
    this.status = status;
    this.responseHeaders = { ...headers };
    this.responseBody = decodeBody(body, headers);
    this.durationMs = durationMs || 0;
    this.complete = true;
  }

  setTunneled(durationMs) {
    this.tunneled = true; this.durationMs = durationMs || 0; this.complete = true;
  }

  setError(message, durationMs) {
    this.error = message; this.durationMs = durationMs || 0; this.complete = true;
  }

  note(tool, text) { this.notes.push({ tool, text }); }

  /** Summary row for the UI (no bodies). */
  summary() {
    return {
      id: this.id, scheme: this.scheme, method: this.method, host: this.host,
      port: this.port, path: this.path, status: this.status,
      durationMs: this.durationMs, sslProxied: this.sslProxied,
      tunneled: !!this.tunneled, error: this.error, complete: this.complete,
      reqSize: this.requestBody.length, resSize: this.responseBody.length,
      contentType: this.responseHeaders['content-type'] || '',
      notes: this.notes, start: this.start,
    };
  }

  /** Full detail for the inspector pane. */
  detail() {
    return {
      ...this.summary(),
      requestHeaders: this.requestHeaders,
      requestBody: bodyPreview(this.requestBody, this.requestHeaders['content-type']),
      responseHeaders: this.responseHeaders,
      responseBody: bodyPreview(this.responseBody, this.responseHeaders['content-type']),
    };
  }
}

function decodeBody(body, headers) {
  const enc = String((headers && (headers['content-encoding'] || headers['Content-Encoding'])) || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(body);
    if (enc.includes('deflate')) return zlib.inflateSync(body);
    if (enc.includes('br')) return zlib.brotliDecompressSync(body);
  } catch (_) { /* fall through to raw */ }
  return body;
}

function bodyPreview(buf, contentType) {
  if (!buf || !buf.length) return { type: 'empty', text: '' };
  const ct = String(contentType || '');
  const textLike = /json|xml|html|text|javascript|css|x-www-form-urlencoded|protobuf/i.test(ct) || !ct;
  const MAX = 512 * 1024;
  if (textLike) {
    const slice = buf.slice(0, MAX);
    // crude binary sniff: too many control chars => treat as binary
    let ctrl = 0;
    for (let i = 0; i < Math.min(slice.length, 1024); i++) {
      const b = slice[i];
      if (b < 9 || (b > 13 && b < 32)) ctrl++;
    }
    if (ctrl > 32) return { type: 'binary', text: `[binary ${buf.length} bytes]` };
    return { type: 'text', text: slice.toString('utf8'), truncated: buf.length > MAX };
  }
  return { type: 'binary', text: `[binary ${buf.length} bytes: ${ct || 'unknown'}]` };
}

class Store extends EventEmitter {
  constructor(max = 5000) {
    super();
    this.setMaxListeners(0);
    this.transactions = new Map(); // id -> Transaction
    this.order = [];               // id order
    this.max = max;
    this.recording = true;
  }

  create(meta) {
    const tx = new Transaction(meta);
    if (this.recording) {
      this.transactions.set(tx.id, tx);
      this.order.push(tx.id);
      this._trim();
      this.emit('tx:new', tx.summary());
    }
    return tx;
  }

  finalize(tx) {
    if (!this.transactions.has(tx.id)) return; // not recorded
    this.emit('tx:update', tx.summary());
  }

  get(id) { return this.transactions.get(Number(id)); }

  list() { return this.order.map((id) => this.transactions.get(id).summary()); }

  clear() {
    this.transactions.clear(); this.order = []; this.emit('clear');
  }

  setRecording(on) { this.recording = on; this.emit('recording', on); }

  _trim() {
    while (this.order.length > this.max) {
      const id = this.order.shift();
      this.transactions.delete(id);
    }
  }
}

module.exports = { Store, Transaction };
