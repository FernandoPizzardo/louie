'use strict';
/**
 * profile.js — shareable tool profiles.
 *
 * A profile is a single JSON file a user can hand to a coworker so their tools
 * ("rewrite this header", "map that host to staging", "these breakpoints")
 * match. Charles calls this an *exported settings* file; we keep a versioned
 * envelope so the format can evolve.
 *
 * Envelope:
 *   { louieProfile: 1, kind: 'louie-profile', name, exportedAt, exportedBy,
 *     tools: { enabled, blockAction, blocklist, mapRemote, mapLocal, rewrite,
 *              throttle, breakpoints, sslLocations },
 *     captures: [ <redacted transaction records> ]   // optional
 *   }
 *
 * Hard rules, because a profile is *sent to other people*:
 *   - Secrets are redacted before they are ever serialized (we borrow the same
 *     redaction SessionLog uses for disk), so a shared file can never leak an
 *     Authorization header or a password field that local history would drop.
 *   - The CA private key, the control-API token and absolute local paths are
 *     never written. Map Local paths are kept (they are the point of a profile)
 *     but flagged on import so a recipient notices a path that cannot exist.
 *   - Importing merges only the sections the caller asks for, so a profile can
 *     never silently clobber unrelated local configuration.
 */
const { SessionLog } = require('./session-log');

const FORMAT_VERSION = 1;
const KIND = 'louie-profile';

/** Tool sections a profile carries. `enabled` is a map, the rest are arrays/values. */
const TOOL_SECTIONS = [
  'enabled', 'blockAction', 'blocklist', 'mapRemote', 'mapLocal',
  'rewrite', 'throttle', 'breakpoints', 'sslLocations',
];

/** Sections that can be selected independently on import. */
const IMPORTABLE = [
  'blocklist', 'mapRemote', 'mapLocal', 'rewrite', 'throttle',
  'breakpoints', 'sslLocations', 'enabled',
];

function nowIso() { return new Date().toISOString(); }

/** Pick just the tool configuration out of an engine config object. */
function toolsFromConfig(config) {
  const out = {};
  for (const key of TOOL_SECTIONS) {
    if (config[key] !== undefined) out[key] = clone(config[key]);
  }
  return out;
}

function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

/**
 * Redacted transaction records. Reuses SessionLog's record builder so a shared
 * capture is redacted exactly like one written to local session history.
 *
 * @param {Transaction[]} txs
 * @param {object} opts { redact, maxBodyBytes, full }
 */
function captureRecords(txs, opts = {}) {
  const log = new SessionLog({
    dir: opts.dir || undefined,
    enabled: true,
    maxBodyBytes: opts.maxBodyBytes,
    redact: opts.redact,
  });
  const out = [];
  for (const tx of txs) {
    // Skip anything still held by a breakpoint: its response is incomplete and
    // sharing it would be misleading.
    if (tx.paused) continue;
    const rec = log.record(tx, { full: !!opts.full });
    // Local-only bookkeeping never belongs in a shared file.
    delete rec.saved;
    delete rec.savedAt;
    out.push(rec);
  }
  return out;
}

/**
 * Build a profile envelope.
 *
 * @param {object} opts
 * @param {object} opts.config      engine config (source of the tool sections)
 * @param {Transaction[]} [opts.txs] transactions to embed as captures
 * @param {boolean} [opts.includeCaptures] default false
 * @param {boolean} [opts.full]     keep bodies over the configured cap
 */
function buildProfile({ config, txs = [], includeCaptures = false, full = false, name } = {}) {
  const profile = {
    louieProfile: FORMAT_VERSION,
    kind: KIND,
    name: (name && String(name).trim()) || defaultName(),
    exportedAt: nowIso(),
    louieVersion: version(),
    tools: toolsFromConfig(config || {}),
  };
  if (includeCaptures) {
    profile.captures = captureRecords(txs, {
      redact: config && config.redact,
      maxBodyBytes: config && config.persist && config.persist.maxBodyBytes,
      full,
    });
  }
  return profile;
}

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `louie-profile-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function version() {
  try { return require('../package.json').version; } catch (_) { return null; }
}

/** A filename safe for every platform, derived from the profile name. */
function fileNameFor(profile) {
  const base = String((profile && profile.name) || defaultName())
    .replace(/[^A-Za-z0-9._-]+/g, '-')  // collapse spaces/slashes to '-'
    .replace(/\.{2,}/g, '.')            // no '..' traversal
    .replace(/^[-.]+|[-.]+$/g, '')        // no leading/trailing separators
    .slice(0, 80) || defaultName();
  return base.endsWith('.json') ? base : `${base}.louie.json`;
}

/**
 * Validate a parsed profile. Returns { ok, error?, profile? }.
 * Unknown top-level keys are tolerated (forward compatibility); a missing or
 * mismatched envelope is not.
 */
function validateProfile(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'not a JSON object' };
  }
  if (obj.kind !== KIND) {
    return { ok: false, error: `not a Louie profile (kind=${JSON.stringify(obj.kind)})` };
  }
  const v = Number(obj.louieProfile);
  if (!Number.isInteger(v) || v < 1) {
    return { ok: false, error: `unsupported profile version ${JSON.stringify(obj.louieProfile)}` };
  }
  if (v > FORMAT_VERSION) {
    return { ok: false, error: `profile version ${v} is newer than this build supports (${FORMAT_VERSION})` };
  }
  if (!obj.tools || typeof obj.tools !== 'object') {
    return { ok: false, error: 'profile has no tools section' };
  }
  return { ok: true, profile: obj };
}

/** Which tool sections does this profile actually carry? */
function describeProfile(profile) {
  const tools = (profile && profile.tools) || {};
  const sections = {};
  for (const key of IMPORTABLE) {
    const val = tools[key];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) sections[key] = val.length;
    else if (typeof val === 'object') sections[key] = Object.keys(val).length;
    else sections[key] = 1;
  }
  const captures = Array.isArray(profile && profile.captures) ? profile.captures.length : 0;
  return {
    name: profile && profile.name,
    exportedAt: profile && profile.exportedAt,
    louieVersion: profile && profile.louieVersion,
    sections,
    captures,
  };
}

/**
 * Merge a profile into a live config.
 *
 * `sections` limits the merge (default: every section the profile carries);
 * `enabled` is merged key-by-key so importing one profile cannot switch off a
 * tool the recipient configured themselves.
 *
 * @returns {{ applied: string[], warnings: string[], skipped: string[] }}
 */
function applyProfile(config, profile, { sections = null, includeCaptures = false } = {}) {
  const check = validateProfile(profile);
  if (!check.ok) throw new Error(check.error);

  const tools = profile.tools || {};
  const wanted = Array.isArray(sections) && sections.length ? sections : IMPORTABLE;
  const applied = [];
  const skipped = [];
  const warnings = [];

  for (const key of wanted) {
    if (!IMPORTABLE.includes(key)) { skipped.push(key); continue; }
    const val = tools[key];
    if (val === undefined) { skipped.push(key); continue; }

    if (key === 'enabled') {
      if (typeof val !== 'object' || Array.isArray(val)) { skipped.push(key); continue; }
      config.enabled = { ...(config.enabled || {}) };
      // Only switch ON the flags the profile switched on. A profile must never
      // turn a tool off that the recipient deliberately enabled, or importing
      // someone's setup would silently disable their own.
      for (const [k, v] of Object.entries(val)) {
        if (v === true) config.enabled[k] = true;
      }
      applied.push(key);
      continue;
    }

    if (key === 'blockAction') {
      if (val === 'drop' || val === '403') { config.blockAction = val; applied.push(key); }
      else skipped.push(key);
      continue;
    }

    config[key] = clone(val);
    applied.push(key);
  }

  // A Map Local path from someone else's machine almost certainly does not exist
  // here; say so rather than letting requests fall through silently.
  if (applied.includes('mapLocal')) {
    const fs = require('fs');
    const missing = (config.mapLocal || [])
      .map((m) => m && m.localPath)
      .filter((p) => typeof p === 'string' && p && !p.startsWith('~/'))
      .filter((p) => { try { return !fs.existsSync(p); } catch (_) { return true; } });
    if (missing.length) {
      warnings.push(`${missing.length} Map Local path(s) do not exist on this machine: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`);
    }
  }

  if (applied.includes('breakpoints') && config.breakpoints && config.breakpoints.rules && config.breakpoints.rules.length) {
    warnings.push('Breakpoints are imported switched off until you enable them in Tools — they will pause matching traffic.');
  }

  return { applied, warnings, skipped };
}

/** Summarise embedded captures without loading bodies. */
function describeCaptures(profile) {
  const caps = Array.isArray(profile && profile.captures) ? profile.captures : [];
  return caps.map((c) => ({
    ts: c.ts,
    method: c.method,
    host: c.host,
    port: c.port,
    path: c.path,
    status: c.status,
    error: c.error || null,
    notes: (c.notes || []).map((n) => n && n.tool).filter(Boolean),
  }));
}

module.exports = {
  FORMAT_VERSION,
  KIND,
  IMPORTABLE,
  TOOL_SECTIONS,
  buildProfile,
  fileNameFor,
  validateProfile,
  describeProfile,
  describeCaptures,
  applyProfile,
  captureRecords,
};
