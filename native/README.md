# Louie (native macOS app)

A SwiftUI macOS app for the `charles-clone` engine. The Node engine does the
proxying and tool work; the app drives it over a token-authenticated loopback
control API. See `../docs/charles-behavior.md` for the tool behavior spec.

Louie wears a monkey icon. 🐒

## Requirements
- macOS 26+ (uses Liquid Glass: `glassEffect`, `GlassEffectContainer`)
- Xcode / Swift 6 toolchain (`swift build`)
- Node 18+ (the engine is Node)

> Launching from Finder/Dock does **not** inherit your shell PATH. The app
> resolves `node` to an absolute path (`~/.local/bin`, Homebrew, nvm, ...) and
> passes an explicit PATH to the engine, so it works regardless of how it is
> launched. Override the path in **Settings (⌘,)** if Node is elsewhere.

## Build & run (development)
```sh
cd native
swift build
swift run Louie
```
The app looks for the engine at, in order:
1. `$CHARLES_CLONE_ENGINE`
2. `Louie.app/Contents/Resources/engine/bin/charles-clone.js` (packaged)
3. `../bin/charles-clone.js` (repo default)

## Package a personal-use app
```sh
native/scripts/make-app.sh          # -> native/dist/Louie.app (ad-hoc signed, monkey icon)
open native/dist/Louie.app
```

## Tests
```sh
cd native && swift test
```
Covers the engine handshake decoding and an integration test that launches the
real Node engine and calls its control API.

## Engine control API
The app launches:
```
node bin/charles-clone.js --headless --proxy <port> --control-file <tmp> --token <t>
```
The engine prints `CHARLES_CLONE_READY {json}` and writes the same JSON to the
control file: `pid, proxyPort, bindHost, controlPort, token, caCertPath, configFile`.

Control endpoints (require `x-charles-token` when a token is set):
- `GET /api/config`, `POST /api/config`
- `GET /api/transactions`, `GET /api/transaction/<id>`
- `POST /api/clear`, `POST /api/recording`
- `GET /api/status`
- `GET /events` (SSE: `tx`, `clear`, `recording`)

In headless mode the engine prints a ready line and picks an ephemeral control
port; there is no static UI. The server is API-only (the native app is the UI).

## MCP server (history)

`bin/louie-mcp.js` exposes captured calls to an MCP client over stdio. It reads
the JSON session files directly, so it works whether or not the engine is running.
It is read-only apart from `delete_transactions`, which prunes records from disk.

Turn on **Settings (⌘,) › Session history › Store calls on disk** first (it is
opt-in). Records are redacted before they are written (`Authorization`, `Cookie`,
`Set-Cookie`, plus common token/password JSON fields).

Tools: `list_transactions`, `get_transaction`, `search_bodies`,
`diff_transactions`, `list_saved`, `get_saved`, `summarize_session`,
`delete_transactions`.

Register it (copy the snippet from **Settings › Copy MCP config**):
```json
{ "mcp": { "louie": { "type": "local", "command": ["node", "<repo>/bin/louie-mcp.js"], "enabled": true } } }
```

Data dir: `--dir <path>`, or `$LOUIE_DATA_DIR`, else the app's
`~/Library/Application Support/Louie/sessions-data`.

In the inspector, **Save for MCP** pins one call as a read-only full-body copy
(`saved/`). If the body is over the 512 KB cap, Louie asks whether to save the
full body or a truncated copy. Pinned copies are exempt from the 7-day retention.

## Breakpoints (live interception)

**Tools › Breakpoints** adds rules that pause a matching call so you can change it
before it is forwarded (request) or delivered (response). A rule is a location
(host / port / path, same matching as the other tools) plus a scope: Request,
Response, or Both.

When a call is paused a sheet opens with the request (method, URL, headers,
body) or response (status, headers, body). Buttons:

- **Continue** — send it through untouched.
- **Continue with edits** (⌘E) — send it through with your changes. Editing the
  URL re-targets the proxy; editing a body recomputes `content-length`.
- **Abort** — drop the connection.

Paused rows show ⏸ in the session table; **Paused only** filters to them, and the
"N paused" toolbar button reopens the editor. Hits queue up and the editor shows
the next one as you resolve each. Every breakpoint auto-continues after
`timeoutMs` (default 120 s) so an unattended engine can never wedge — set it in
**Tools › Breakpoints**.

Binary bodies are shown read-only. Breakpoints are off by default; turn on the
**Breakpoints** toggle in **Tools** to arm them. The engine side lives in
`../lib/breakpoint.js` and the contract in `../docs/control-api.md`.

## Sharing a setup with a coworker

**Share…** exports your tool configuration as a single `.louie.json` profile the
other person can import:

- **Export** — pick a name, optionally embed captured calls, then save. Captures
  are redacted *before* they are written into the file (using the same rules as
  local session history), and calls held by a breakpoint are skipped. The CA key,
  the control-API token and your local paths are never included.
- **Import** — choose a profile and Louie shows what it carries: which sections
  and how many entries, plus a list of any embedded captures. Tick only what you
  want, then import.

An import **merges**: it switches tools on and replaces the sections you selected,
but it never turns a tool *off* that you enabled yourself. Map Local paths from
another machine are flagged, because they almost certainly do not exist here.
Review an exported file before sending it — sharing is your call.

## Device debugging (your own builds)

**Tools › Device setup…** turns on LAN exposure and starts a listener that serves
only the public root certificate. It shows a proxy address and QR codes.

- iPhone: scan the `.mobileconfig` QR, install the profile, then enable full trust
  for "Louie Root CA" under Certificate Trust Settings.
- Android: scan the `.cer` QR and install the CA, or download it to the device.
  For your own debug builds, trust user CAs via a debug-only network security
  config.

LAN binding is **off by default** and the CA listener runs only while the sheet is
open. `ca.key` is never served.

## Status
- **Phase 1 (done):** app shell, engine lifecycle, headless control API + token,
  packaging script.
- **Phase 2 (done):** native session table (status/method/host/path/duration/size/
  tools), filter + SSL-only, recording pause + clear, live SSE updates, and the
  Request/Response/Notes inspector.
- **Phase 3 (done):** HTTP/2 — MITM negotiates ALPN and serves h2 or h1.1 to the
  client; upstream uses h2 when the origin supports it, else h1.1. Tools apply to
  h2 transactions.
- **Phase 4 (done):** native tool editors — Block List (with drop/403 action),
  Map Remote (protocol/host/port/path/query), Map Local (path picker,
  case-sensitive), Rewrite (sets + rules), Throttle (latency + bandwidth), SSL
  locations, and No Cache. Saving posts the config subset to the engine.
- **Phase 5 (done):** CA panel — root CA path, subject, SHA-256 fingerprint, trust
  state, and a user-initiated "Trust in Keychain" action (engine shells out to
  `security add-trusted-cert`; macOS may prompt for authorization).
- **Phase 5b (done):** "Import from Charles…" in the Tools editor. The engine
  parses the real app's XML (`~/Library/Preferences/com.xk72.charles.config`) and
  imports SSL proxying locations, Block List (+ action), Map Remote, and Throttle.
  Also available from the CLI: `node bin/charles-clone.js --import-charles`.
- **UI pass (done):** renamed the app to **Louie** with a generated monkey icon;
  Liquid Glass tabs (`GlassTabs`); JSON beautifier + highlighter (order-preserving);
  HTML formatter + highlighter with a rendered WKWebView preview (JS disabled);
  **Dracula** color scheme on a dark code surface (keeps contrast on dark backgrounds).
- **Phase 6 (done):** retired the static web GUI. `public/` is deleted and the
  server is API-only; the native Louie app is the single UI.
- **Phase 7 (done):** durable, redacted session history (opt-in, 7-day retention,
  512 KB body cap) and a read-only MCP server (`bin/louie-mcp.js`); "Save for MCP"
  in the inspector with a large-body confirm prompt.
- **Phase 8 (done):** device debugging — LAN binding (off by default), a
  cert-only CA listener, QR codes, and iPhone/Android setup steps.
- **Phase 9 (done):** breakpoints (live interception) — rules that pause a
  matching request or response, a native editor sheet (edit method/URL/headers/
  body or status/headers/body, then Continue / Continue with edits / Abort), a
  queued-hit model over SSE, and a mandatory auto-resume timeout.
- **Phase 10 (done):** shareable profiles — export/import a `.louie.json` of the
  tool configuration (optionally with redacted captures) so a team can exchange
  setups instead of retyping them.
