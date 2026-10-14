'use strict';
/**
 * import-charles tests — parse a fixture shaped like the real
 * ~/Library/Preferences/com.xk72.charles.config and assert the mapping.
 */
const assert = require('assert');
const { parseCharlesConfig, parseXml } = require('../lib/import-charles');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const FIXTURE = `<?xml version='1.0' encoding='UTF-8' ?>
<?charles serialisation-version='2.0' ?>
<configuration>
  <proxyConfiguration>
    <sslLocations>
      <locationPatterns>
        <locationMatch><location><host>a.intra.example.com</host><port>80</port></location></locationMatch>
        <locationMatch><location><host>*</host><port>443</port></location></locationMatch>
        <locationMatch><location><host>b.intra.example.com</host></location></locationMatch>
      </locationPatterns>
    </sslLocations>
  </proxyConfiguration>
  <throttlingConfiguration>
    <bandwidthDown>16384.0</bandwidthDown>
    <bandwidthUp>8192.0</bandwidthUp>
    <utilisationDown>100</utilisationDown>
    <latency>200</latency>
    <hosts>
      <list>
        <throttleHost><location><protocol>https</protocol><host>wallet.example.com</host></location></throttleHost>
      </list>
    </hosts>
  </throttlingConfiguration>
  <toolConfiguration>
    <configs>
      <entry><string>Block List</string><blacklist><toolEnabled>true</toolEnabled><action>1</action></blacklist></entry>
      <entry><string>Map Remote</string><map>
        <toolEnabled>true</toolEnabled>
        <mappings>
          <mapMapping>
            <sourceLocation><protocol>https</protocol><host>hermes.example.com</host><port>443</port></sourceLocation>
            <destLocation><protocol>https</protocol><host>dsim.example.com</host><port>443</port></destLocation>
          </mapMapping>
        </mappings>
      </map></entry>
      <entry><string>Map Local</string><mapLocal /></entry>
      <entry><string>Rewrite</string><rewrite /></entry>
      <entry><string>No Caching</string><selectedHostsTool><toolEnabled>true</toolEnabled></selectedHostsTool></entry>
    </configs>
  </toolConfiguration>
</configuration>`;

test('parses a minimal XML tree with entities', () => {
  const root = parseXml('<a><b>x &amp; y</b><c/></a>');
  assert.strictEqual(root.name, 'a');
  assert.strictEqual(root.children[0].name, 'b');
  assert.strictEqual(root.children[0].text, 'x & y');
  assert.strictEqual(root.children[1].name, 'c');
});

test('maps SSL locations', () => {
  const { sections } = parseCharlesConfig(FIXTURE);
  assert.strictEqual(sections.sslLocations.length, 3);
  assert.deepStrictEqual(sections.sslLocations[0], { host: 'a.intra.example.com', port: 80 });
  assert.deepStrictEqual(sections.sslLocations[1], { host: '*', port: 443 });
  assert.deepStrictEqual(sections.sslLocations[2], { host: 'b.intra.example.com' });
});

test('maps Block List with the 403 action', () => {
  const { sections } = parseCharlesConfig(FIXTURE);
  assert.strictEqual(sections.enabled.blocklist, true);
  assert.strictEqual(sections.blockAction, '403');
});

test('maps Map Remote from/to', () => {
  const { sections } = parseCharlesConfig(FIXTURE);
  assert.strictEqual(sections.enabled.mapRemote, true);
  assert.strictEqual(sections.mapRemote.length, 1);
  assert.deepStrictEqual(sections.mapRemote[0].from, { protocol: 'https', host: 'hermes.example.com', port: 443 });
  assert.deepStrictEqual(sections.mapRemote[0].to, { protocol: 'https', host: 'dsim.example.com', port: 443 });
});

test('maps throttle (bytes/s -> KB/s) and hosts', () => {
  const { sections } = parseCharlesConfig(FIXTURE);
  assert.strictEqual(sections.enabled.throttle, true);
  assert.strictEqual(sections.throttle.latency, 200);
  assert.strictEqual(sections.throttle.bandwidthDown, 16);
  assert.strictEqual(sections.throttle.bandwidthUp, 8);
  assert.deepStrictEqual(sections.throttle.hosts[0], { protocol: 'https', host: 'wallet.example.com' });
});

test('maps No Caching and leaves empty tools off', () => {
  const { sections } = parseCharlesConfig(FIXTURE);
  assert.strictEqual(sections.enabled.noCache, true);
  assert.strictEqual(sections.enabled.mapLocal, false);
  assert.strictEqual(sections.enabled.rewrite, false);
});

test('reports warnings for unmapped Map Local / Rewrite content', () => {
  const xml = FIXTURE.replace('<rewrite />', '<rewrite><toolEnabled>true</toolEnabled><rewriteSets/></rewrite>');
  const { warnings } = parseCharlesConfig(xml);
  assert.ok(warnings.some((w) => /Rewrite/.test(w)), 'expected a Rewrite warning');
});

test('throws on missing file', () => {
  const { importCharles } = require('../lib/import-charles');
  assert.throws(() => importCharles('/nope/does-not-exist.xml', {}), /not found/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
