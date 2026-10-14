'use strict';
/**
 * tools.js — Tool pipeline, mirroring com/charlesproxy/tools/spi/* and the
 * concrete tools found in charles.jar:
 *
 *   SSL Proxying (sslLocations)   -> decides CONNECT tunnel vs MITM
 *   BlocklistTool                 -> 403/abort matching hosts
 *   MapRemoteTool / MapTool       -> rewrite destination host/port
 *   MapLocalTool                  -> serve a file instead of going upstream
 *   RewriteTool                   -> modify headers/body/status by regex rules
 *   ThrottleTool                  -> delay + bandwidth cap per location
 *   NoCachingTool                 -> strip cache headers
 *
 * Each tool implements onRequest(tx)/onResponse(tx) and returns a decision.
 * A location pattern is { protocol?, host, port?, path?, query? } and is matched
 * as a full regex against the canonical URL `protocol://host:port/path?query`,
 * exactly like Charles' <locationMatch> entries. See docs/charles-behavior.md.
 */

/**
 * Location matching, mirroring com.xk72.common.net.Location + LocationMatching.
 *
 * Charles does NOT glob the host directly. It builds a regex from the pattern and
 * matches it (full match) against the request's canonical URL
 * `protocol://host:port/path?query`. Scheme and port are significant; a missing
 * field becomes a wildcard. See docs/charles-behavior.md.
 */
function escapeLiteral(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Escape everything except '*', then turn '*' into '.*' (glob semantics).
function escapeWithWildcards(s) { return String(s).split('*').map(escapeLiteral).join('.*'); }

// host: '*' or empty -> any host; '.' matches any host char ([^:/]); '*' -> '.*'.
function hostPattern(host) {
  if (!host || host === '*') return '[^:/]*';
  let out = '';
  let lit = '';
  const flush = () => { if (lit) { out += escapeLiteral(lit); lit = ''; } };
  for (const ch of String(host)) {
    if (ch === '*') { flush(); out += '.*'; }
    else if (ch === '.') { flush(); out += '[^:/]'; }
    else lit += ch;
  }
  flush();
  return out;
}

function canonicalUrl(tx) {
  const scheme = tx.scheme || '';
  const host = tx.host || '';
  const port = tx.port != null && tx.port !== '' ? String(tx.port) : '';
  let path = tx.path || '/';
  const q = path.indexOf('?');
  let pathname = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? '' : path.slice(q + 1);
  if (!pathname) pathname = '/';
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  return `${scheme}://${host}:${port}${pathname}?${query}`;
}

function locationRegex(loc) {
  const protocol = loc.protocol ? escapeLiteral(loc.protocol) : '[a-z]*';
  const host = hostPattern(loc.host);
  const port = loc.port ? escapeLiteral(String(loc.port)) : '[0-9]*';
  const path = loc.path ? escapeWithWildcards(loc.path) : '/.*';
  const query = loc.query ? '\\?.*' + escapeWithWildcards(loc.query) + '.*' : '\\?.*';
  return new RegExp('^' + protocol + '://' + host + ':' + port + path + query + '$');
}

function locMatches(loc, tx) {
  if (!loc) return false;
  try { return locationRegex(loc).test(canonicalUrl(tx)); } catch { return false; }
}

// Kept for compatibility with callers that only need host globbing.
function hostMatches(pattern, host) {
  if (!pattern || pattern === '*') return true;
  host = String(host || '').toLowerCase();
  pattern = String(pattern).toLowerCase();
  if (pattern === host) return true;
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    return host === suffix.slice(1) || host.endsWith(suffix);
  }
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('*').map(escapeLiteral).join('.*') + '$');
    return re.test(host);
  }
  return false;
}

// Content-type inference for Map Local (Charles infers from the file extension).
const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.xml': 'application/xml', '.pdf': 'application/pdf',
};
function contentTypeFor(file) {
  return MIME_TYPES[require('path').extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

class ToolPipeline {
  constructor(config) {
    this.config = config || {};
    this.enabled = this.config.enabled || {};
  }
  isEnabled(name) { return !!this.enabled[name]; }

  // ---- SSL Proxying location list (the MITM allowlist) ----
  sslEnabled(host, port) {
    const list = this.config.sslLocations || [];
    // Charles only MITMs hosts explicitly added. Empty => tunnel everything.
    return list.some((loc) => locMatches(loc, { scheme: 'https', host, port, path: '/' }));
  }

  async onRequest(tx) {
    const decision = { blocked: false, rewriteUrl: null };

    // Filter order mirrors Charles' OrderedProxyListener values:
    //   Map Remote (10) -> Rewrite (12) -> Block List (50) -> Map Local (72)
    // Note: in this clone the later filters match the ORIGINAL location, whereas
    // Charles mutates the event so they see the mapped location. Documented gap.

    // Map Remote (change destination). Mirrors com.charlesproxy.tools.MapTool:
    // protocol, host, port, path and query are each rewritten independently, and
    // the Host header is updated by the caller (stripHop).
    if (this.isEnabled('mapRemote')) {
      for (const m of (this.config.mapRemote || [])) {
        if (!locMatches(m.from, tx)) continue;
        const to = m.to || {};
        const from = m.from || {};
        const proto = to.protocol || tx.scheme;
        const host = to.host || tx.host;
        const port = to.port != null && to.port !== '' ? to.port : (proto === 'https' ? 443 : 80);

        const reqPath = tx.path || '/';
        const qi = reqPath.indexOf('?');
        const reqPathname = qi === -1 ? reqPath : reqPath.slice(0, qi);
        const reqQuery = qi === -1 ? '' : reqPath.slice(qi + 1);

        // Path: the matched prefix is removed and the destination path is
        // prepended. Charles truncates the pattern at the last '/' when the
        // pattern has a '*' after it (so "/old/*" removes "/old/").
        let newPathname = reqPathname;
        if (to.path) {
          const fromPath = String(from.path || '');
          const lastSlash = fromPath.lastIndexOf('/');
          const fromPrefix = (fromPath.indexOf('*', lastSlash + 1) !== -1)
            ? fromPath.slice(0, lastSlash + 1) : fromPath;
          const suffix = (fromPrefix && reqPathname.startsWith(fromPrefix)) ? reqPathname.slice(fromPrefix.length) : '';
          newPathname = String(to.path) + suffix;
        }

        // Query: '-' deletes it; otherwise set/append.
        let newQuery = reqQuery;
        if (to.query != null) newQuery = to.query === '-' ? '' : String(to.query);

        const url = `${proto}://${host}:${port}${newPathname}${newQuery ? '?' + newQuery : ''}`;
        tx.note('Map Remote', `${tx.host} -> ${host}`);
        decision.rewriteUrl = url;
        break;
      }
    }

    // Rewrite (request phase) — Charles order 12.
    if (this.isEnabled('rewrite')) {
      this._applyRewrite(tx, 'request');
    }

    // Blocklist. Charles' default action is to DROP the connection; returning a
    // 403 is the opt-in `blockAction: '403'`. See docs/charles-behavior.md.
    if (this.isEnabled('blocklist')) {
      for (const loc of (this.config.blocklist || [])) {
        if (locMatches(loc, tx)) {
          const action = this.config.blockAction === '403' ? '403' : 'drop';
          tx.note('Blocklist', `blocked ${tx.host}${tx.path} (${action})`);
          if (action === '403') {
            return { blocked: true, action: '403', status: 403,
              headers: { 'content-type': 'text/plain' },
              body: Buffer.from('403 Forbidden — blocked by Charles Clone Blocklist tool') };
          }
          return { blocked: true, action: 'drop' };
        }
      }
    }

    // Map Local (serve from disk). Mirrors com.charlesproxy.tools.MapLocalTool.
    // Charles does NOT return 404 when the file is missing: it logs a note and
    // falls through to the real upstream. It also supports a directory target
    // (the unmatched request path is resolved beneath it) and `~/` expansion.
    if (this.isEnabled('mapLocal')) {
      const fs = require('fs');
      const path = require('path');
      for (const m of (this.config.mapLocal || [])) {
        if (!locMatches(m.location, tx)) continue;
        let target = String(m.localPath || '');
        if (target.startsWith('~/')) target = path.join(require('os').homedir(), target.slice(2));
        let file = target;
        try {
          const st = fs.statSync(target);
          if (st.isDirectory()) {
            // Remainder of the request path after the matched location prefix.
            const reqPath = (tx.path || '/').split('?')[0];
            const prefix = (m.location && m.location.path) || '';
            let rest = reqPath;
            if (prefix && prefix !== '*') {
              const p = prefix.replace(/\*/g, '');
              if (reqPath.startsWith(p)) rest = reqPath.slice(p.length);
            }
            file = path.join(target, rest);
          }
        } catch (_) {
          tx.note('Map Local', `destination doesn't exist: ${target} (falling through)`);
          continue; // fall through to upstream, like Charles
        }
        let body;
        // Optional case-sensitive check: the on-disk name must match exactly.
        if (m.caseSensitive) {
          try {
            const entries = fs.readdirSync(path.dirname(file));
            if (!entries.includes(path.basename(file))) {
              tx.note('Map Local', `requested file doesn't exist case-sensitive: ${file} (falling through)`);
              continue;
            }
          } catch (_) {
            continue;
          }
        }
        try { body = fs.readFileSync(file); } catch (_) {
          tx.note('Map Local', `requested file doesn't exist: ${file} (falling through)`);
          continue; // fall through to upstream
        }
        tx.note('Map Local', file);
        return { blocked: true, status: 200,
          headers: { 'content-type': m.contentType || contentTypeFor(file) }, body };
      }
    }

    // No caching
    if (this.isEnabled('noCache')) {
      if (tx.requestHeaders) {
        delete tx.requestHeaders['if-none-match'];
        delete tx.requestHeaders['if-modified-since'];
      }
      tx.requestHeaders = tx.requestHeaders || {};
      tx.requestHeaders['cache-control'] = 'no-cache';
      tx.requestHeaders['pragma'] = 'no-cache';
      tx.note('No Cache', 'request cache headers stripped');
    }

    // Throttle (request delay)
    if (this.isEnabled('throttle')) {
      const t = this.config.throttle || {};
      const applies = !t.hosts || !t.hosts.length || t.hosts.some((loc) => locMatches(loc, tx));
      if (applies && t.latency) {
        tx.note('Throttle', `+${t.latency}ms latency`);
        await sleep(t.latency);
      }
    }

    return decision;
  }

  async onResponse(tx) {
    if (this.isEnabled('rewrite')) this._applyRewrite(tx, 'response');
    if (this.isEnabled('noCache')) {
      const h = tx.responseHeaders;
      delete h['cache-control']; delete h['expires']; delete h['etag']; delete h['last-modified'];
      h['pragma'] = 'no-cache';
      tx.note('No Cache', 'response cache headers stripped');
    }
    // Throttle: byte-rate pacing (bandwidthDown in KB/s), like com.xk72.throttle.
    if (this.isEnabled('throttle')) {
      const t = this.config.throttle || {};
      const applies = !t.hosts || !t.hosts.length || t.hosts.some((loc) => locMatches(loc, tx));
      if (applies && t.bandwidthDown > 0) {
        const body = tx.responseBody;
        const bytes = Buffer.isBuffer(body) ? body.length
          : (body && body.text ? Buffer.byteLength(body.text, 'utf8') : 0);
        const ms = (bytes / (t.bandwidthDown * 1024)) * 1000;
        if (ms > 0) {
          tx.note('Throttle', `paced ${bytes}B at ${t.bandwidthDown}KB/s (~${Math.round(ms)}ms)`);
          await sleep(ms);
        }
      }
    }
  }

  _applyRewrite(tx, phase) {
    for (const set of (this.config.rewrite || [])) {
      if (!set.enabled) continue;
      if (set.location && !locMatches(set.location, tx)) continue;
      for (const rule of (set.rules || [])) {
        if (rule.type !== phase && rule.type !== 'both') continue;
        try {
          if (rule.target === 'header') this._rewriteHeader(tx, phase, rule);
          else if (rule.target === 'body') this._rewriteBody(tx, phase, rule);
          else if (rule.target === 'status' && phase === 'response') {
            tx.status = Number(rule.replace) || tx.status;
            tx.note('Rewrite', `status -> ${tx.status}`);
          } else if (rule.target === 'path' && phase === 'request') {
            tx.path = tx.path.replace(new RegExp(rule.match, rule.flags || 'g'), rule.replace);
            tx.note('Rewrite', `path -> ${tx.path}`);
          }
        } catch (_) {}
      }
    }
  }

  _rewriteHeader(tx, phase, rule) {
    const headers = phase === 'request' ? tx.requestHeaders : tx.responseHeaders;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === String(rule.name).toLowerCase());
    if (rule.action === 'remove') { if (key) delete headers[key]; tx.note('Rewrite', `remove header ${rule.name}`); return; }
    if (rule.action === 'add') { headers[String(rule.name).toLowerCase()] = rule.replace; tx.note('Rewrite', `add header ${rule.name}`); return; }
    // modify existing (or add if absent and matchAll)
    if (key) {
      const before = String(headers[key]);
      headers[key] = before.replace(new RegExp(rule.match || '.*', rule.flags || 'g'), rule.replace);
      tx.note('Rewrite', `${rule.name}: ${before} -> ${headers[key]}`);
    }
  }

  _rewriteBody(tx, phase, rule) {
    const isReq = phase === 'request';
    const body = isReq ? tx.requestBody : tx.responseBody;
    if (!body || !body.length) return;
    const headers = isReq ? tx.requestHeaders : tx.responseHeaders;
    const ctype = (headers && (headers['content-type'] || headers['Content-Type'])) || '';
    // Charles only runs body rules when the content type is textual.
    if (ctype && !isTextual(ctype)) {
      tx.note('Rewrite', `${phase} body not textual (${ctype}); skipped`);
      return;
    }
    const charset = charsetFrom(ctype);
    const enc = nodeEncoding(charset);
    let text;
    try { text = body.toString(enc); } catch (_) { text = body.toString('latin1'); }
    const out = text.replace(new RegExp(rule.match || '', rule.flags || 'g'), rule.replace);
    if (out !== text) {
      const buf = Buffer.from(out, enc);
      if (isReq) { tx.requestBody = buf; tx.requestHeaders['content-length'] = String(buf.length); }
      else { tx.responseBody = buf; tx.responseHeaders['content-length'] = String(buf.length);
             delete tx.responseHeaders['content-encoding']; }
      tx.note('Rewrite', `${phase} body rewritten (${charset || 'utf-8'})`);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Rewrite body helpers (charset / content-type) ----
function charsetFrom(contentType) {
  const m = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType || '');
  return m ? m[1].trim().toLowerCase() : null;
}
function nodeEncoding(cs) {
  if (!cs) return 'utf8';
  if (/^utf-?8$/.test(cs)) return 'utf8';
  if (/^(iso-?8859-?1|latin-?1|us-ascii|ascii|cp1252|windows-1252)$/.test(cs)) return 'latin1';
  if (/^(utf-?16le|ucs-?2)$/.test(cs)) return 'utf16le';
  return 'utf8';
}
function isTextual(ctype) {
  const c = String(ctype || '').toLowerCase();
  return c.startsWith('text/') || c.includes('json') || c.includes('xml')
    || c.includes('javascript') || c.includes('x-www-form-urlencoded');
}

module.exports = { ToolPipeline, hostMatches, locMatches };
