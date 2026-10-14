#!/usr/bin/env node
'use strict';
/**
 * charles-clone — a small HTTP/HTTPS intercepting proxy in the spirit of
 * Charles Proxy. Wires together:
 *   CertificateAuthority (ca.js)   — root CA + on-the-fly leaf certs (MITM)
 *   Store (store.js)               — Session/Transaction model + event bus
 *   ToolPipeline (tools.js)        — SSL list, blocklist, map, rewrite, throttle
 *   ProxyEngine (proxy.js)         — HTTP forward proxy + CONNECT + MITM
 *   WebServer (web.js)             — live browser GUI over SSE
 *
 * Usage:
 *   node bin/charles-clone.js [--proxy 8888] [--web 8889] [--ssl-host example.com]
 */
const path = require('path');
const { load } = require('../lib/config');
const { CertificateAuthority } = require('../lib/ca');
const { Store } = require('../lib/store');
const { ToolPipeline } = require('../lib/tools');
const { ProxyEngine } = require('../lib/proxy');
const { WebServer } = require('../lib/web');

function parseArgs(argv) {
  const out = { sslHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--proxy') out.proxyPort = Number(argv[++i]);
    else if (a === '--web') out.webPort = Number(argv[++i]);
    else if (a === '--host') out.bindHost = argv[++i];
    else if (a === '--ssl-host') out.sslHosts.push(argv[++i]);
    else if (a === '--ssl-all') out.sslAll = true;
    else if (a === '--config') out.configFile = argv[++i];
    else if (a === '--headless') out.headless = true;
    else if (a === '--control-file') out.controlFile = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--exit-on-stdin-close') out.exitOnStdinClose = true;
    else if (a === '--import-charles') {
      out.importCharles = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function help() {
  console.log(`charles-clone — HTTP/HTTPS intercepting proxy (Charles Proxy style)

Options:
  --proxy <port>      Proxy listen port            (default 8888)
  --web <port>        Control API port             (default 8889)
  --host <addr>       Bind address                 (default 127.0.0.1)
  --ssl-host <host>   Enable SSL proxying (MITM) for a host; repeatable
  --ssl-all           Enable SSL proxying for ALL https hosts (adds *:443)
  --config <file>     Config file path             (default ~/.charles-clone/config.json)
  --import-charles [f] Import settings from the Charles app XML, then exit
                      (default ~/Library/Preferences/com.xk72.charles.config)
  --headless          Control-API only, no GUI or banner (for the native app)
  --control-file <f>  Write the ready handshake JSON to this path
  --token <t>         Require this token on the control API
  --exit-on-stdin-close  Exit when stdin closes (orphan guard for the app)
  -h, --help          This help

The UI is the native Louie app (native/); this process is the engine. It also
serves a token-authenticated control API for the app.

Then point a client at the proxy, e.g.:
  curl -x http://127.0.0.1:8888 http://example.com/
  curl -x http://127.0.0.1:8888 --cacert ~/.charles-clone/ca/ca.crt https://example.com/`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();

  const config = load(args.configFile);
  if (args.importCharles) {
    try {
      const { importCharles } = require('../lib/import-charles');
      const r = importCharles(args.importCharles === true ? undefined : args.importCharles, config);
      config._persist && config._persist();
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    } catch (e) {
      console.error('import failed: ' + e.message);
      process.exit(1);
    }
  }
  if (args.proxyPort) config.proxyPort = args.proxyPort;
  if (args.webPort) config.webPort = args.webPort;
  if (args.bindHost) config.bindHost = args.bindHost;
  if (args.sslAll) config.sslLocations = [{ host: '*', port: 443 }];
  for (const h of args.sslHosts) config.sslLocations.push({ host: h });
  // de-dup ssl locations
  const seen = new Set();
  config.sslLocations = config.sslLocations.filter((l) => {
    const k = `${l.host}:${l.port || ''}`; if (seen.has(k)) return false; seen.add(k); return true;
  });

  const ca = new CertificateAuthority(config.caDir);
  const created = ca.ensureRoot();
  const store = new Store();
  const tools = new ToolPipeline(config);

  const proxy = new ProxyEngine({ ca, store, tools });
  const web = new WebServer({ store, tools, ca, config, token: args.token });

  // Headless mode: pick an ephemeral control port and machine-readable output.
  if (args.headless) {
    config.webPort = 0;
    config.logLevel = 'quiet';
  }

  proxy.listen(config.proxyPort, config.bindHost, () => {
    web.listen(config.webPort, config.bindHost, () => {
      const controlPort = web.server.address().port;
      if (args.headless) {
        const info = {
          pid: process.pid,
          proxyPort: config.proxyPort,
          bindHost: config.bindHost,
          controlPort,
          token: args.token || null,
          caCertPath: ca.crtPath,
          configFile: config._file,
        };
        if (args.controlFile) {
          try { require('fs').writeFileSync(args.controlFile, JSON.stringify(info)); } catch (e) {
            console.error(`control file write failed: ${e.message}`);
          }
        }
        // Machine-readable line for the parent process to parse.
        console.log('CHARLES_CLONE_READY ' + JSON.stringify(info));
        return;
      }
      const sslList = config.sslLocations.map((l) => `${l.host}${l.port ? ':' + l.port : ''}`).join(', ') || '(none — HTTPS tunnels blindly)';
      console.log(`\n  charles-clone proxy`);
      console.log(`  ────────────────────────────────────────────────`);
      console.log(`  Proxy:        http://${config.bindHost}:${config.proxyPort}`);
      console.log(`  Web GUI:      http://${config.bindHost}:${config.webPort}`);
      console.log(`  Root CA:      ${ca.crtPath} ${created ? '(newly generated)' : ''}`);
      console.log(`  SSL proxying: ${sslList}`);
      console.log(`  Recording:    ${store.recording ? 'on' : 'off'}`);
      console.log(`  ────────────────────────────────────────────────`);
      console.log(`  Use:  curl -x http://${config.bindHost}:${config.proxyPort} http://example.com/`);
      console.log(`  TLS:  curl -x http://${config.bindHost}:${config.proxyPort} --cacert ${ca.crtPath} https://example.com/\n`);
    });
  });

  proxy.server.on('error', (e) => {
    console.error(`proxy listen error: ${e.message}`);
    if (e.code === 'EADDRINUSE') console.error(`  port ${config.proxyPort} busy — try --proxy <other>`);
    process.exit(1);
  });

  const shutdown = () => { console.log('\nshutting down…'); proxy.close(); web.server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Orphan guard: when the parent (the native app) exits, our stdin closes.
  if (args.exitOnStdinClose) {
    process.stdin.resume();
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}

main();
