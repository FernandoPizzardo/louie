# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

**Louie** is an HTTP/HTTPS intercepting proxy for debugging traffic — a
reimplementation in the spirit of Charles Proxy. It has two parts:

- **Engine** (Node, `bin/` + `lib/`): the proxy, MITM, tool pipeline, control API,
  and the MCP server. No third-party dependencies.
- **App** (`native/`): a SwiftUI macOS app (SwiftPM) that drives the engine over a
  token-authenticated loopback control API. The app is the only UI; the static
  web GUI was retired.

## Layout

```
bin/charles-clone.js   engine entry point (CLI + headless for the app)
bin/louie-mcp.js       MCP server over session history (read-only + delete_transactions)
lib/proxy.js           HTTP forward proxy, CONNECT, MITM, HTTP/2
lib/tools.js           tool pipeline (Block List, Map, Rewrite, Throttle, ...)
lib/ca.js              root CA + per-host leaf certs (openssl)
lib/store.js           in-memory transactions + event bus
lib/web.js             control API (token-auth) + CA-serving listener
lib/session-log.js     durable, redacted session history for the MCP server
lib/import-charles.js  import settings from the real Charles app XML
docs/charles-behavior.md  BEHAVIOR SPEC derived from charles.jar (read this)
docs/control-api.md    HTTP contract for engine clients (app / web / Electron)
web/                   React + TypeScript + shadcn/ui client of the control API (Vite)
electron/              Desktop shell (Electron): starts the engine, serves web/dist, Linux packages
native/                SwiftUI app (SwiftPM); see native/README.md
test/                  Node tests (e2e, import, session-log, mcp, control-api)
```

## Commands

```sh
# Engine tests (all suites)
npm test

# App build / tests / package
cd native && swift build
cd native && swift test
native/scripts/make-app.sh          # -> native/dist/Louie.app (ad-hoc signed)

# Web UI (dev server proxies /api and /events to the engine)
cd web && npm install && LOUIE_ENGINE=http://127.0.0.1:8889 npm run dev
cd web && npm run build && npm run lint

# Run the engine by hand
node bin/charles-clone.js --proxy 8888
node bin/charles-clone.js --headless --proxy 8888 --control-file /tmp/c.json --token t
node bin/charles-clone.js --import-charles          # import from the Charles app
```

## Ground rules

1. **Behavior must match Charles.** `docs/charles-behavior.md` is the source of
   truth, derived by decompiling `charles.jar`. When you change tool behavior,
   update that doc and add/adjust a test in `test/e2e.js`.
2. **Keep the engine dependency-free.** `lib/` uses only Node built-ins. Do not
   add npm dependencies.
3. **Never break the redaction-before-write rule.** `lib/session-log.js` redacts
   `Authorization`/`Cookie`/`Set-Cookie` and token/password JSON fields *before*
   anything is written to disk. New fields must stay redacted by default.
4. **The CA private key is never served.** `lib/web.js` serves only the public
   certificate (`/ca.cer`, `/ca.mobileconfig`). Do not expose `ca.key`.
5. **LAN exposure is opt-in.** It defaults to off; the control API stays
   token-authenticated when it is on.
6. **Tests are the contract.** `npm test` and `swift test` must pass. Add tests
   with every behavior change; don't weaken existing assertions to make a change
   pass.
8. **Web dependencies stay in `web/`.** `lib/` and the root `package.json` must
   not gain runtime dependencies. The web client talks only to the control API
   and never imports engine code.
7. **The control API is an interface.** `lib/web.js` is consumed by the SwiftUI
   app and by future web/Electron clients. When a route or SSE event changes,
   update `docs/control-api.md` and `test/control-api.test.js` in the same
   change.

## Gotchas (learned the hard way)

- **Node resolution.** A GUI-launched app does NOT inherit the shell PATH; using
  bare `node` gives exit 127. `EngineController.resolveNodePath` resolves an
  absolute path and hands the engine an explicit PATH. Keep it that way.
- **SwiftUI `@Environment` assertions.** Every `Scene` that reads
  `@Environment(SomeType.self)` must have that object injected. The `Settings`
  scene is separate from the `WindowGroup`; forgetting this crashes on open.
  `ViewSmokeTests` guards against it.
- **macOS 26 required.** Liquid Glass (`glassEffect`, `GlassEffectContainer`) is
  used in `GlassTabs`. The deployment target is macOS 26.
- **Engine files are bundled.** `make-app.sh` copies `bin/` and `lib/` into
  `Louie.app/Contents/Resources/engine`; new engine files must be picked up there
  (it copies whole directories, so just don't hard-code paths).
- **`--exit-on-stdin-close`** is the orphan guard: the app holds the stdin pipe,
  and the engine exits when it closes. Keep it when changing startup.
- **Tool pipeline order** matters and is asserted: Map Remote (10) → Rewrite (12)
  → Block List (50) → Map Local (72) → No Cache → Throttle.
- **Auto-detected JS quirks.** The engine's own port can arrive as a string from
  `URL.port`; the app uses `FlexInt` to decode numbers-or-strings.

## Conventions

- Engine: CommonJS, `'use strict'`, small focused modules, comments that cite the
  corresponding Charles class (e.g. `com.charlesproxy.tools.MapLocalTool`).
- App: `@MainActor @Observable` stores; views in `Sources/Louie/`; keep UI logic
  thin and data handling in stores.
- Tests: self-contained (temp dirs, ephemeral ports), no network, no reliance on
  the developer's `~/.charles-clone`.

## MCP server

`bin/louie-mcp.js` is a stdio MCP server over the session history. It is
read-only except for `delete_transactions`, which prunes records from disk
(filters like `list_transactions`, plus `dryRun`; refuses an unfiltered wipe
unless `confirmAll:true`; pinned copies need `includeSaved:true`).
Tools: `list_transactions`, `get_transaction`, `search_bodies`,
`diff_transactions`, `list_saved`, `get_saved`, `summarize_session`,
`delete_transactions`.
Data dir: `--dir`, or `$LOUIE_DATA_DIR`, else the app default. Persistence is
opt-in (`persist.enabled`), 7-day retention, 512 KB body cap.
