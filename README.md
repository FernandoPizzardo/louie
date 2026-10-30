# Louie

An HTTP/HTTPS intercepting proxy debugger in the spirit of
[Charles Proxy](https://www.charlesproxy.com/): inspect, rewrite and replay the
traffic between your apps and the network.

Two parts, both in this repo:

- **Engine** (`bin/`, `lib/`) — a dependency-free Node proxy: HTTP forwarding,
  `CONNECT` tunnelling, on-the-fly TLS MITM, HTTP/2, the tool pipeline, a
  token-authenticated control API, and a read-only MCP server.
- **Clients** of that control API:
  - **Louie** (`native/`) — a native SwiftUI macOS app. The primary UI on macOS.
  - **Desktop** (`electron/`, `web/`) — an Electron shell around a React client,
    for Linux and Windows where the SwiftUI app cannot run.

The engine is API-only (it serves no UI of its own); each client ships its own.

```
bin/charles-clone.js   engine entry point (CLI + headless for the app)
bin/louie-mcp.js       MCP server over session history
lib/proxy.js           HTTP forward proxy, CONNECT, MITM, HTTP/2
lib/tools.js           tool pipeline
lib/breakpoint.js      request/response breakpoints (suspend, edit, resume)
lib/ca.js              root CA + per-host leaf certificates (openssl)
lib/store.js           in-memory transactions + event bus
lib/web.js             control API (token-auth) + CA-serving listener
lib/session-log.js     durable, redacted session history for the MCP server
lib/profile.js         shareable tool profiles (export/import for teammates)
native/                SwiftUI macOS app (SwiftPM)
web/, electron/        React client + Electron shell (Linux, Windows)
docs/control-api.md    the HTTP contract every client depends on
docs/charles-behavior.md  behaviour spec derived from charles.jar
```

## Features

**Intercept and inspect**

- HTTP/HTTPS forward proxy with `CONNECT` tunnelling
- TLS MITM with a local root CA — per-host leaf certificates minted on demand
- HTTP/2 both ways: ALPN negotiation with the client, upstream h2 when the origin
  supports it (cached probe), HTTP/1.1 otherwise
- Live session table over Server-Sent Events, with a request/response inspector
- JSON and HTML syntax highlighting, a JSON formatter, and a sandboxed HTML
  preview (JavaScript disabled)

**Tools** — applied in Charles' filter order

| Order | Tool | What it does |
| --- | --- | --- |
| 5 | **Breakpoints** | Pause a matching request or response, edit it, then continue or abort |
| 10 | **Map Remote** | Rewrite protocol, host, port, path, query and the `Host` header |
| 12 | **Rewrite** | Modify URLs, headers and bodies (honours the response charset) |
| 50 | **Block List** | Drop the connection (default) or return 403 |
| 72 | **Map Local** | Serve a local file or directory instead of the network |
| — | **No Cache** | Strip caching headers |
| — | **Throttle** | Add latency and pace by KB/s |

Location patterns are matched as a regex against the canonical URL
`scheme://host:port/path?query`, so scheme and port are significant — see
[docs/charles-behavior.md](docs/charles-behavior.md), which is derived from the
decompiled `charles.jar`.

**Debug on a device**

- Opt-in LAN binding (off by default; the control API stays token-authenticated)
- A listener that serves **only** the public root certificate (`/ca.cer`,
  `/ca.mobileconfig`) — `ca.key` is never served
- QR codes and step-by-step iPhone / Android setup

**Share with a coworker**

- **Export** your tools (and optionally captured calls) as one `.louie.json` profile
  and hand it over — no more screenshots of a Rewrite config
- Captures are **redacted before they are written** into the file, reusing the
  same rules as local session history, and calls held by a breakpoint are skipped
- The CA key, the control-API token and your local paths are never included
- **Import** previews the file first and merges only the sections you tick; a
  profile can switch tools on but never off, so it cannot disable your own setup
- Warns when Map Local paths point at files that do not exist on your machine

**History and the MCP server**

- Opt-in durable session history, redacted **before** anything is written
  (`Authorization`, `Cookie`, `Set-Cookie`, plus common token/password fields)
- 7-day retention and a 512 KB body cap; pinned copies are exempt
- `bin/louie-mcp.js` exposes captures to an MCP client over stdio
  (`list_transactions`, `get_transaction`, `search_bodies`, `diff_transactions`,
  `summarize_session`, `list_saved`, `get_saved`, `delete_transactions`)

## Requirements

- Node 18+
- macOS 26+ for the SwiftUI app (uses Liquid Glass); `openssl` for the CA
- Xcode / Swift 6 toolchain only if you build the macOS app from source

## Quick start

```sh
# The engine
node bin/charles-clone.js --proxy 8888
curl -x http://127.0.0.1:8888 http://example.com/

# Diagnostic mode (control API only, machine-readable handshake)
node bin/charles-clone.js --headless --proxy 8888 \
  --control-file /tmp/louie.json --token secret

# Import settings from the installed Charles app
node bin/charles-clone.js --import-charles
```

To inspect HTTPS, add the host to SSL Proxying and trust the root CA
(`~/.charles-clone/ca/ca.crt`). The macOS app does both from its UI.

## The macOS app

```sh
cd native && swift build && swift run Louie     # development
native/scripts/make-app.sh                      # -> native/dist/Louie.app
```

The app resolves `node` to an absolute path and hands the engine an explicit
`PATH`, because a GUI-launched app does not inherit your shell's `PATH`. Override
it in **Settings (⌘,)**.

## The Linux / Windows desktop app

```sh
cd web && npm install && npm run build
cd ../electron && npm install
npm run dist:linux    # or dist:win
```

Build on the OS you intend to run on. See [electron/README.md](electron/README.md).

## Tests

```sh
npm test                    # engine: e2e, import, session log, MCP, control API
cd native && swift test     # macOS app
cd web && npm run build && npm run lint
```

Tests are self-contained: temp dirs, ephemeral ports, no network, and nothing
reads your `~/.charles-clone`.

## Documentation

- [docs/charles-behavior.md](docs/charles-behavior.md) — per-tool behaviour spec
- [docs/control-api.md](docs/control-api.md) — the control API contract
- [native/README.md](native/README.md) — the macOS app
- [AGENTS.md](AGENTS.md) — conventions and gotchas for contributors

## License

MIT — see [LICENSE](LICENSE).
