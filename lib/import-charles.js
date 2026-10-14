'use strict';
/**
 * import-charles.js — import settings from the real Charles Proxy app.
 *
 * Charles stores its configuration as XML at
 *   ~/Library/Preferences/com.xk72.charles.config
 * (and exports profiles to ~/Library/Application Support/Charles/profiles/*.cfg.xml).
 *
 * This module parses that XML into charles-clone's config sections. It uses a
 * tiny built-in XML reader (no dependencies). Verified mappings: SSL proxying
 * locations, Block List (+ drop/403 action), Map Remote, Throttle. Map Local and
 * Rewrite schemas are not present in the reference profile; those are collected
 * best-effort and reported as warnings when entries exist but cannot be mapped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG = path.join(os.homedir(), 'Library', 'Preferences', 'com.xk72.charles.config');

// ---------- tiny XML reader ----------
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function parseXml(str) {
  let i = 0;
  const n = str.length;
  function skipMisc() {
    while (i < n) {
      if (str.startsWith('<?', i)) { const e = str.indexOf('?>', i); i = e === -1 ? n : e + 2; }
      else if (str.startsWith('<!--', i)) { const e = str.indexOf('-->', i); i = e === -1 ? n : e + 3; }
      else if (str.startsWith('<!', i)) { const e = str.indexOf('>', i); i = e === -1 ? n : e + 1; }
      else if (/\s/.test(str[i])) i++;
      else break;
    }
  }
  function parseElement() {
    i++; // consume '<'
    let name = '';
    while (i < n && !/[\s/>]/.test(str[i])) name += str[i++];
    while (i < n && str[i] !== '>' && !(str[i] === '/' && str[i + 1] === '>')) i++;
    const node = { name, children: [], text: '' };
    if (str.startsWith('/>', i)) { i += 2; return node; }
    i++; // consume '>'
    let text = '';
    while (i < n) {
      if (str.startsWith('</', i)) { const e = str.indexOf('>', i); i = e === -1 ? n : e + 1; break; }
      if (str[i] === '<') { skipMisc(); if (str[i] === '<') node.children.push(parseElement()); }
      else text += str[i++];
    }
    node.text = decodeEntities(text.trim());
    return node;
  }
  skipMisc();
  while (i < n && str[i] !== '<') i++;
  return i < n ? parseElement() : null;
}

// ---------- tree helpers ----------
const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const kid = (node, name) => kids(node, name)[0] || null;
const txt = (node, name) => { const k = kid(node, name); return k ? k.text : null; };
function descendants(node, name) {
  const out = [];
  (function walk(n) { for (const c of n.children) { if (c.name === name) out.push(c); walk(c); } })(node || { children: [] });
  return out;
}

function locationFrom(node) {
  if (!node) return null;
  const out = {};
  for (const f of ['protocol', 'host', 'port', 'path', 'query']) {
    const v = txt(node, f);
    if (v === null || v === '') continue;
    out[f] = (f === 'port' && /^\d+$/.test(v)) ? Number(v) : v;
  }
  return out;
}

// ---------- mapping ----------
function emptySections() {
  return {
    enabled: { blocklist: false, mapRemote: false, mapLocal: false, rewrite: false, throttle: false, noCache: false },
    blockAction: 'drop',
    blocklist: [],
    mapRemote: [],
    mapLocal: [],
    rewrite: [],
    throttle: { latency: 0, bandwidthDown: 0, bandwidthUp: 0, hosts: [] },
    sslLocations: [],
  };
}

function parseCharlesConfig(xml) {
  const root = parseXml(xml);
  if (!root) throw new Error('could not parse XML');
  const sections = emptySections();
  const warnings = [];

  // SSL proxying locations
  const ssl = kid(kid(kid(root, 'proxyConfiguration'), 'sslLocations'), 'locationPatterns');
  for (const lm of descendants(ssl, 'locationMatch')) {
    const loc = locationFrom(kid(lm, 'location'));
    if (loc) sections.sslLocations.push(loc);
  }

  // Tool configs keyed by display name
  const entries = {};
  for (const entry of kids(kid(kid(root, 'toolConfiguration'), 'configs'), 'entry')) {
    const name = kid(entry, 'string');
    const child = entry.children.find((c) => c.name !== 'string');
    if (name && child) entries[name.text] = child;
  }

  // Block List (action: 0 = drop, 1 = 403)
  const bl = entries['Block List'];
  if (bl) {
    sections.enabled.blocklist = txt(bl, 'toolEnabled') === 'true';
    const action = txt(bl, 'action');
    if (action === '1') sections.blockAction = '403';
    else if (action === '0') sections.blockAction = 'drop';
    for (const lm of descendants(bl, 'locationMatch')) {
      const loc = locationFrom(kid(lm, 'location'));
      if (loc) sections.blocklist.push(loc);
    }
  }

  // Map Remote
  const map = entries['Map Remote'];
  if (map) {
    sections.enabled.mapRemote = txt(map, 'toolEnabled') === 'true';
    for (const m of descendants(map, 'mapMapping')) {
      const from = locationFrom(kid(m, 'sourceLocation'));
      const to = locationFrom(kid(m, 'destLocation'));
      if (from && to) sections.mapRemote.push({ from, to });
    }
  }

  // Map Local — schema not present in the reference profile; report if populated.
  const ml = entries['Map Local'];
  if (ml) {
    sections.enabled.mapLocal = txt(ml, 'toolEnabled') === 'true';
    const found = ml.children.filter((c) => c.name !== 'toolEnabled').length;
    if (found) warnings.push('Map Local config found but its schema is not mapped; entries were skipped.');
  }

  // Rewrite — same caveat.
  const rw = entries['Rewrite'];
  if (rw) {
    sections.enabled.rewrite = txt(rw, 'toolEnabled') === 'true';
    const found = rw.children.filter((c) => c.name !== 'toolEnabled').length;
    if (found) warnings.push('Rewrite config found but its schema is not mapped; entries were skipped.');
  }

  // No Caching (selectedHostsTool)
  const nc = entries['No Caching'];
  if (nc) sections.enabled.noCache = txt(nc, 'toolEnabled') === 'true';

  // Throttle. Charles stores bandwidth in bytes/sec; charles-clone uses KB/s.
  const th = kid(root, 'throttlingConfiguration');
  if (th) {
    sections.throttle.latency = Math.round(Number(txt(th, 'latency') || 0));
    sections.throttle.bandwidthDown = Math.round(Number(txt(th, 'bandwidthDown') || 0) / 1024);
    sections.throttle.bandwidthUp = Math.round(Number(txt(th, 'bandwidthUp') || 0) / 1024);
    for (const h of descendants(kid(th, 'hosts'), 'throttleHost')) {
      const loc = locationFrom(kid(h, 'location'));
      if (loc) sections.throttle.hosts.push(loc);
    }
    const t = sections.throttle;
    sections.enabled.throttle = t.latency > 0 || t.bandwidthDown > 0 || t.bandwidthUp > 0 || t.hosts.length > 0;
  }

  return { sections, warnings };
}

/** Parse `file` and merge the mapped sections into `config`. */
function importCharles(file, config) {
  const xmlPath = file || DEFAULT_CONFIG;
  if (!fs.existsSync(xmlPath)) throw new Error(`Charles config not found: ${xmlPath}`);
  const { sections, warnings } = parseCharlesConfig(fs.readFileSync(xmlPath, 'utf8'));
  Object.assign(config, sections);
  return {
    source: xmlPath,
    warnings,
    summary: {
      sslLocations: sections.sslLocations.length,
      blocklist: sections.blocklist.length,
      mapRemote: sections.mapRemote.length,
      throttleHosts: sections.throttle.hosts.length,
      enabled: Object.entries(sections.enabled).filter(([, v]) => v).map(([k]) => k),
    },
  };
}

module.exports = { parseCharlesConfig, importCharles, parseXml, DEFAULT_CONFIG };
