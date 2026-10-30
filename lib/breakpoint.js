'use strict';
/**
 * breakpoint.js — Request/response breakpoints ("interception"), mirroring
 * Charles' Breakpoints tool (com.charlesproxy.tools.BreakpointTool +
 * com.xk72.proxy.event breakpoint listeners).
 *
 * A breakpoint suspends a transaction between the client and the upstream so a
 * user can inspect it, edit the request/response, then continue or abort. What
 * Charles exposes as a modal editor is here a control-API handshake:
 *
 *   tools.onRequest(tx)  ─┐
 *                          ├─ maybeSuspend() -> Promise<EditingState>
 *   tools.onResponse(tx) ─┘        │
 *                                  │  emit 'breakpoint:hit' (SSE `breakpoint`)
 *                                  │  caller POSTs /api/breakpoint/:id/{continue,abort,edit}
 *                                  ▼
 *                            resolve({ action, request, response })
 *
 * Design notes:
 *  - The suspended transaction is NOT finalized while paused; it stays visible
 *    in the session table with `paused: true` so the UI can show it.
 *  - Every breakpoint has a deadline. If the client never answers (the app was
 *    quit, or this is a headless run with nobody watching), the transaction is
 *    released with the untouched state so the proxy never wedges.
 *  - Edits are applied structurally (method/url/headers/body/status) so the
 *    proxy can honour them without re-parsing raw HTTP bytes.
 */
const { locMatches } = require('./tools');

const DEFAULT_TIMEOUT_MS = 120000;

/** Text body or a truncated/binary placeholder — never blow up the UI. */
function bodyText(tx, phase) {
  const isReq = phase === 'request';
  const buf = isReq ? tx.requestBody : tx.responseBody;
  const headers = isReq ? tx.requestHeaders : tx.responseHeaders;
  if (!buf || !buf.length) return { type: 'empty', text: '' };
  const ct = String(headers['content-type'] || headers['Content-Type'] || '');
  const textual = !ct || /json|xml|html|text|javascript|css|x-www-form-urlencoded/i.test(ct);
  if (!textual) return { type: 'binary', text: `[binary ${buf.length} bytes]`, editable: false };
  return { type: 'text', text: buf.toString('utf8'), editable: true };
}

/**
 * Snapshot handed to the client when a breakpoint hits. Bodies are text only;
 * binary bodies are flagged non-editable so a client cannot corrupt them.
 */
function hitPayload(hit) {
  const tx = hit.tx;
  const req = {
    method: tx.method,
    url: `${tx.scheme}://${tx.host}${tx.port ? ':' + tx.port : ''}${tx.path || '/'}`,
    headers: { ...tx.requestHeaders },
    body: bodyText(tx, 'request'),
  };
  const res = {
    status: tx.status,
    headers: { ...tx.responseHeaders },
    body: bodyText(tx, 'response'),
  };
  return {
    id: hit.id,
    transactionId: tx.id,
    phase: hit.phase,
    rule: hit.rule,
    deadline: hit.deadline,
    summary: tx.summary(),
    request: req,
    response: res,
  };
}

class BreakpointManager {
  /**
   * @param {object} opts
   * @param {object} opts.config      engine config (reads `breakpoints`)
   * @param {import('events').EventEmitter} opts.store  transaction store/event bus
   */
  constructor({ config, store, log }) {
    this.config = config || {};
    this.store = store;
    this.log = log || (() => {});
    this.pending = new Map(); // hitId -> hit
    this._nextId = 1;
  }

  /** Rules currently in force: the global toggle plus per-rule `enabled`. */
  rules() {
    const b = this.config.breakpoints || {};
    if (b.enabled === false) return [];
    return (b.rules || []).filter((r) => r && r.enabled !== false);
  }

  setConfig(config) { this.config = config || {}; }

  /**
   * The first enabled rule matching this transaction in this phase, or null.
   * A rule's `scope` is 'request' | 'response' | 'both'.
   */
  matchRule(tx, phase) {
    for (const rule of this.rules()) {
      const scope = rule.scope || 'both';
      if (scope !== 'both' && scope !== phase) continue;
      if (rule.location && !locMatches(rule.location, tx)) continue;
      return rule;
    }
    return null;
  }

  /** True when this transaction would be paused in this phase (no side effects). */
  wouldPause(tx, phase) { return !!this.matchRule(tx, phase); }

  /**
   * Suspend `tx` if a rule matches, resolving with the client's decision:
   *   { action: 'continue' | 'abort', request?, response? }
   * Resolves immediately (action 'continue', no edits) when no rule matches.
   * A timeout releases the transaction so the proxy can never wedge.
   */
  maybeSuspend(tx, phase) {
    const rule = this.matchRule(tx, phase);
    if (!rule) return Promise.resolve({ action: 'continue' });

    const timeoutMs = Number(this.config.breakpoints && this.config.breakpoints.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const id = this._nextId++;
    const hit = { id, tx, phase, rule: { scope: rule.scope || 'both' }, deadline: Date.now() + timeoutMs };

    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        tx.paused = false;
        this._apply(tx, phase, result);
        tx.note('Breakpoint', result.action === 'abort' ? `aborted (${phase})` : `resumed (${phase})`);
        this.store && this.store.emit('breakpoint:done', { id, transactionId: tx.id, action: result.action });
        resolve(result);
      };
      const timer = setTimeout(() => {
        tx.note('Breakpoint', `timed out after ${timeoutMs}ms — resumed unmodified`);
        finish({ action: 'continue' });
      }, timeoutMs);
      if (timer.unref) timer.unref();

      hit.finish = finish;
      tx.paused = true;
      tx.note('Breakpoint', `paused (${phase})`);
      this.pending.set(id, hit);
      if (this.store) this.store.emit('breakpoint:hit', hitPayload(hit));
    });
  }

  /** The client's answer to a pending breakpoint. */
  resolve(id, result) {
    const hit = this.pending.get(Number(id));
    if (!hit) return null;
    const action = result && result.action === 'abort' ? 'abort' : 'continue';
    hit.finish({ ...(result || {}), action });
    return hit.tx.id;
  }

  /** Everything currently suspended, in arrival order. */
  list() { return [...this.pending.values()].map(hitPayload); }

  /** Release everything (used on shutdown / session clear). */
  releaseAll() { for (const hit of [...this.pending.values()]) hit.finish({ action: 'continue' }); }

  // ---- edit application ----

  /** Apply request/response edits carried by the decision to the transaction. */
  _apply(tx, phase, result) {
    if (!result || result.action === 'abort') return;
    if (phase === 'request' && result.request) this._applyRequest(tx, result.request);
    if (phase === 'response' && result.response) this._applyResponse(tx, result.response);
  }

  _applyRequest(tx, edit) {
    if (typeof edit.method === 'string' && edit.method) tx.method = edit.method.toUpperCase();
    if (typeof edit.url === 'string' && edit.url) {
      // Only scheme/host/port/path change here: the proxy re-derives the
      // destination from these fields before forwarding.
      try {
        const u = new URL(edit.url);
        tx.scheme = u.protocol.replace(':', '') || tx.scheme;
        tx.host = u.hostname || tx.host;
        tx.port = u.port ? Number(u.port) : (tx.scheme === 'https' ? 443 : 80);
        tx.path = (u.pathname || '/') + (u.search || '');
        tx.redirect = true;
      } catch (_) { /* keep the original URL when it does not parse */ }
    }
    if (edit.headers && typeof edit.headers === 'object') {
      tx.requestHeaders = lowerKeys(edit.headers);
    }
    if (edit.body && edit.body.type === 'text' && typeof edit.body.text === 'string') {
      tx.requestBody = Buffer.from(edit.body.text, 'utf8');
      tx.requestHeaders['content-length'] = String(tx.requestBody.length);
      tx.note('Breakpoint', `request body edited (${tx.requestBody.length}B)`);
    }
  }

  _applyResponse(tx, edit) {
    const status = Number(edit.status);
    if (Number.isFinite(status) && status >= 100 && status <= 599) tx.status = status;
    if (edit.headers && typeof edit.headers === 'object') {
      tx.responseHeaders = lowerKeys(edit.headers);
    }
    if (edit.body && edit.body.type === 'text' && typeof edit.body.text === 'string') {
      tx.responseBody = Buffer.from(edit.body.text, 'utf8');
      tx.responseHeaders['content-length'] = String(tx.responseBody.length);
      delete tx.responseHeaders['content-encoding'];
      tx.note('Breakpoint', `response body edited (${tx.responseBody.length}B)`);
    }
  }
}

function lowerKeys(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

module.exports = { BreakpointManager, hitPayload, DEFAULT_TIMEOUT_MS };
