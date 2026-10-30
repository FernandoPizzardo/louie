'use strict';
/**
 * profile tests — shareable export/import of tool configuration.
 *
 * The security-critical property, asserted hardest here: a profile is a file you
 * hand to someone else, so it must be redacted exactly like local session
 * history, and must never carry the CA key or the control-API token.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildProfile, validateProfile, describeProfile, applyProfile,
  captureRecords, fileNameFor, KIND, FORMAT_VERSION, IMPORTABLE,
} = require('../lib/profile');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

function makeTx(over = {}) {
  return {
    id: 1, start: Date.now(), scheme: 'https', method: 'POST', host: 'api.example.com', port: 443,
    path: '/login', status: 200, durationMs: 12, sslProxied: true, tunneled: false, error: null,
    paused: false,
    notes: [{ tool: 'Rewrite', text: 'changed a header' }],
    requestHeaders: { authorization: 'Bearer SUPER-SECRET', 'content-type': 'application/json' },
    requestBody: Buffer.from(JSON.stringify({ user: 'a', password: 'hunter2', token: 'abc' })),
    responseHeaders: { 'set-cookie': 'sid=xyz', 'content-type': 'application/json' },
    responseBody: Buffer.from(JSON.stringify({ ok: true, access_token: 'zzz' })),
    ...over,
  };
}

function baseConfig() {
  return {
    enabled: { blocklist: true, mapRemote: false, mapLocal: false, rewrite: true, throttle: false, noCache: false, breakpoints: false },
    blockAction: 'drop',
    blocklist: [{ host: 'ads.example.com' }],
    mapRemote: [{ from: { host: 'api.prod' }, to: { host: 'api.staging' } }],
    mapLocal: [],
    rewrite: [{ enabled: true, location: { host: 'api.example.com' }, rules: [{ type: 'response', target: 'body', match: 'a', replace: 'b' }] }],
    throttle: { latency: 0, bandwidthDown: 0, bandwidthUp: 0, hosts: [] },
    breakpoints: { enabled: false, timeoutMs: 120000, rules: [] },
    sslLocations: [{ host: 'localhost', port: 443 }],
    // Things that must NEVER reach a shared file:
    redact: { enabled: true },
    token: 'CONTROL-API-TOKEN',
    caDir: '/Users/someone/.charles-clone/ca',
    persist: { enabled: true, dir: '/Users/someone/Library/Louie', maxBodyBytes: 524288 },
  };
}

console.log('\nlouie — profile export/import test\n');

// ---------- envelope ----------

test('profile has a versioned envelope with the tool sections', () => {
  const p = buildProfile({ config: baseConfig(), name: 'Team staging' });
  assert.strictEqual(p.kind, KIND);
  assert.strictEqual(p.louieProfile, FORMAT_VERSION);
  assert.strictEqual(p.name, 'Team staging');
  assert.ok(p.exportedAt && !Number.isNaN(Date.parse(p.exportedAt)));
  for (const key of ['enabled', 'blockAction', 'blocklist', 'mapRemote', 'mapLocal', 'rewrite', 'throttle', 'breakpoints', 'sslLocations']) {
    assert.ok(key in p.tools, `tools missing ${key}`);
  }
  assert.strictEqual(p.captures, undefined, 'captures must be opt-in');
});

test('export never carries the token, the CA dir or the persist path', () => {
  const json = JSON.stringify(buildProfile({ config: baseConfig() }));
  assert.ok(!json.includes('CONTROL-API-TOKEN'), 'token leaked into the profile');
  assert.ok(!json.includes('caDir'), 'caDir leaked into the profile');
  assert.ok(!json.includes('.charles-clone/ca'), 'CA path leaked into the profile');
  assert.ok(!json.includes('Library/Louie'), 'persist dir leaked into the profile');
});

test('export is a deep copy: mutating the profile does not touch the config', () => {
  const cfg = baseConfig();
  const p = buildProfile({ config: cfg });
  p.tools.blocklist.push({ host: 'evil.example' });
  assert.strictEqual(cfg.blocklist.length, 1, 'config was mutated through the profile');
});

// ---------- redaction (the important one) ----------

test('captured bodies are redacted before they are serialized', () => {
  const p = buildProfile({ config: baseConfig(), txs: [makeTx()], includeCaptures: true });
  assert.strictEqual(p.captures.length, 1);
  const json = JSON.stringify(p);
  assert.ok(!json.includes('SUPER-SECRET'), 'Authorization leaked into a shared profile');
  assert.ok(!json.includes('hunter2'), 'password leaked into a shared profile');
  assert.ok(!json.includes('sid=xyz'), 'Set-Cookie leaked into a shared profile');
  assert.ok(!json.includes('"zzz"'), 'access_token leaked into a shared profile');
  assert.ok(json.includes('[redacted]'), 'expected redaction markers');
});

test('captures can be redacted by the transaction array too', () => {
  const recs = captureRecords([makeTx()], { redact: { enabled: true } });
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].request.headers.authorization, '[redacted]');
  assert.ok(!JSON.stringify(recs).includes('hunter2'));
});

test('a paused transaction is never captured', () => {
  const recs = captureRecords([makeTx({ paused: true }), makeTx({ id: 2, path: '/ok' })]);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].path, '/ok');
});

test('captures drop local-only bookkeeping fields', () => {
  const recs = captureRecords([makeTx()]);
  assert.strictEqual(recs[0].saved, undefined);
  assert.strictEqual(recs[0].savedAt, undefined);
});

// ---------- validation ----------

test('validate rejects non-profiles and wrong versions', () => {
  assert.strictEqual(validateProfile(null).ok, false);
  assert.strictEqual(validateProfile([]).ok, false);
  assert.strictEqual(validateProfile({ kind: 'something-else' }).ok, false);
  assert.strictEqual(validateProfile({ kind: KIND, louieProfile: 0, tools: {} }).ok, false);
  assert.strictEqual(validateProfile({ kind: KIND, louieProfile: 1 }).ok, false, 'tools is required');
  assert.strictEqual(validateProfile({ kind: KIND, louieProfile: 99, tools: {} }).ok, false, 'future version must be rejected');
  assert.strictEqual(validateProfile(buildProfile({ config: baseConfig() })).ok, true);
});

test('describe reports which sections and captures a profile carries', () => {
  const p = buildProfile({ config: baseConfig(), txs: [makeTx()], includeCaptures: true });
  const d = describeProfile(p);
  assert.strictEqual(d.sections.blocklist, 1);
  assert.strictEqual(d.sections.mapRemote, 1);
  assert.strictEqual(d.sections.mapLocal, 0);
  assert.strictEqual(d.captures, 1);
});

// ---------- import / merge ----------

test('import applies every section the profile carries', () => {
  const p = buildProfile({ config: baseConfig() });
  const target = baseConfig();
  target.blocklist = []; target.sslLocations = []; target.enabled.blocklist = false;
  const r = applyProfile(target, p);
  assert.deepStrictEqual(target.blocklist, [{ host: 'ads.example.com' }]);
  assert.deepStrictEqual(target.sslLocations, [{ host: 'localhost', port: 443 }]);
  assert.strictEqual(target.enabled.blocklist, true);
  assert.ok(r.applied.includes('blocklist'));
});

test('import honours a section subset', () => {
  const p = buildProfile({ config: baseConfig() });
  const target = baseConfig();
  target.blocklist = [{ host: 'keep.example' }];
  target.rewrite = [];
  applyProfile(target, p, { sections: ['blocklist'] });
  assert.deepStrictEqual(target.blocklist, [{ host: 'ads.example.com' }]);
  assert.deepStrictEqual(target.rewrite, [], 'unselected sections must be untouched');
});

test('import merges `enabled` key-by-key instead of replacing it', () => {
  const p = buildProfile({ config: baseConfig() });
  const target = baseConfig();
  target.enabled = { throttle: true, noCache: true };
  applyProfile(target, p, { sections: ['enabled'] });
  assert.strictEqual(target.enabled.throttle, true, 'an unrelated enabled flag was clobbered');
  assert.strictEqual(target.enabled.noCache, true);
  assert.strictEqual(target.enabled.blocklist, true, 'the imported flag did not apply');
});

test('import clones, so later edits do not write back into the profile', () => {
  const p = buildProfile({ config: baseConfig() });
  const target = baseConfig();
  applyProfile(target, p);
  target.blocklist.push({ host: 'later.example' });
  assert.strictEqual(p.tools.blocklist.length, 1, 'profile was mutated through the imported config');
});

test('import warns about Map Local paths that do not exist here', () => {
  const cfg = baseConfig();
  cfg.mapLocal = [{ location: { host: 'x' }, localPath: '/definitely/not/here/fixture.json' }];
  const p = buildProfile({ config: cfg });
  const target = baseConfig();
  const r = applyProfile(target, p);
  assert.ok(r.warnings.some((w) => /Map Local path/.test(w)), `expected a Map Local warning, got ${JSON.stringify(r.warnings)}`);
});

test('import warns that breakpoints arrive switched off', () => {
  const cfg = baseConfig();
  cfg.breakpoints = { enabled: false, timeoutMs: 120000, rules: [{ enabled: true, scope: 'both', location: { host: 'api.example.com' } }] };
  const r = applyProfile(baseConfig(), buildProfile({ config: cfg }));
  assert.ok(r.warnings.some((w) => /Breakpoints are imported switched off/.test(w)), JSON.stringify(r.warnings));
});

test('importing a profile cannot smuggle a token or CA dir into the config', () => {
  const p = buildProfile({ config: baseConfig() });
  // Even if a hand-edited file tries, only known sections are applied.
  p.tools.token = 'INJECTED';
  p.tools.caDir = '/tmp/evil';
  const target = baseConfig();
  applyProfile(target, p);
  assert.notStrictEqual(target.token, 'INJECTED');
  assert.notStrictEqual(target.caDir, '/tmp/evil');
});

test('a round-trip through JSON preserves the tool configuration', () => {
  const cfg = baseConfig();
  const p = buildProfile({ config: cfg, name: 'round trip' });
  const wire = JSON.parse(JSON.stringify(p));
  const target = baseConfig();
  target.blocklist = []; target.mapRemote = []; target.rewrite = [];
  applyProfile(target, wire);
  assert.deepStrictEqual(target.blocklist, cfg.blocklist);
  assert.deepStrictEqual(target.mapRemote, cfg.mapRemote);
  assert.deepStrictEqual(target.rewrite, cfg.rewrite);
});

// ---------- file naming ----------

test('fileNameFor produces a safe name ending in .louie.json', () => {
  assert.strictEqual(fileNameFor({ name: 'Team staging' }), 'Team-staging.louie.json');
  assert.strictEqual(fileNameFor({ name: '../../etc/passwd' }), 'etc-passwd.louie.json');
  assert.match(fileNameFor({ name: '' }), /^louie-profile-\d{8}-\d{4}\.louie\.json$/);
});

// ---------- writing to disk ----------

test('a written profile is valid JSON with no secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'louie-profile-'));
  const p = buildProfile({ config: baseConfig(), txs: [makeTx()], includeCaptures: true, name: 'on disk' });
  const file = path.join(dir, fileNameFor(p));
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(validateProfile(reread).ok, true);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SUPER-SECRET'));
  assert.ok(!raw.includes('CONTROL-API-TOKEN'));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
