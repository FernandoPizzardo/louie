# Louie — Review & Improvement Plan

**Date:** 2026-01-21
**Scope:** Engine (`lib/` / `bin/`), macOS App (`native/`), Web/Electron Client (`web/` / `electron/`)

---

## Executive Summary

Louie is an unusually well-architected Charles Proxy reimplementation. The zero-dependency Node engine, behavior-driven spec (`docs/charles-behavior.md` derived from `charles.jar`), token-authenticated control API, and first-class MCP server integration put it ahead of most open-source proxies. The security posture (redaction-before-write, CA key isolation, explicit LAN opt-in) is production-grade.

The app is currently **solid for HTTP/HTTPS traffic inspection and basic tool usage**, but it lacks modern protocol support (WebSocket, gRPC), advanced analysis features, and several power-user productivity tools that Charles power users expect. There is also a **feature-parity gap** between the native macOS app and the web/Electron client.

---

## What's Working Well

| Area | Assessment |
|------|------------|
| **Architecture** | Clean engine/client split. Zero-dep engine is a genuine achievement. MCP server is forward-thinking. |
| **Behavior Fidelity** | Location matching, tool ordering, and Map Local/Remote semantics closely track Charles. Decomp-driven spec is maintainable. |
| **Security** | Redaction runs before any disk write. CA key never served. Token auth on all control routes. Profile sharing strips secrets. |
| **Breakpoints** | Timeout-guarded suspension prevents proxy wedge. Multiple queued hits > Charles' modal single-editor model. |
| **SSL/MitM** | ALPN negotiation, HTTP/2 client→proxy and proxy→origin, per-host leaf certs, SNI callback. |
| **Testing** | Self-contained suites (e2e, control API, profile, session log, MCP). Temp dirs, ephemeral ports, no network dependency. |
| **Profile Sharing** | Versioned JSON envelope, selective merge, path-existence warnings, can-only-turn-on semantics. |
| **Session Log** | Redacted JSONL with retention, size caps, and pinned exemptions. MCP tools over stdio work even when engine is off. |

---

## Critical Engine Gaps

These are behavioral or protocol gaps that block real-world usage for modern stacks.

### 1. No WebSocket Proxying
Charles proxies WebSocket `Upgrade` connections and shows the framed messages. Louie currently treats them as plain HTTP `Upgrade` requests and drops the persistent connection. **This breaks inspection of modern SPAs, real-time APIs, and gaming traffic.**

*Effort: High. Needs framing parser, message buffering, and UI wire format.*

### 2. No gRPC / Protobuf Support
HTTP/2 is negotiated, but gRPC bodies are opaque binary (+protobuf). Charles decodes protobuf when `.proto` files are loaded. **This blocks inspection of most microservice traffic.**

*Effort: Medium–High. Needs protobuf loader + message decoder; engine stays dep-free if we ship a minimal protobuf parser.*

### 3. Filter Location Mutation Gap
> Documented in `docs/charles-behavior.md`: *"Filters after Map Remote match the ORIGINAL location, whereas Charles mutates the event so later filters see the mapped location."*

This means a Rewrite rule that targets the *new* host won't fire after a Map Remote. **This is a silent behavioral divergence that breaks complex tool chains.**

*Effort: Medium. Restructure `ToolPipeline` to mutate `tx` canonical URL between filter stages.*

### 4. Throttle Incomplete
- `bandwidthUp` (request pacing) is **not applied**.
- Packet-loss simulation is **not implemented**.
- These exist in the decompiled throttle engine (`com.xk72.throttle.sdfE.edfX`).

*Effort: Low–Medium.*

### 5. Missing `Content-Encoding` Handling
`store.js` has `decodeBody` for gzip/deflate/brotli on the response side, but the engine does not transparently compress/decompress during rewrite, nor does it re-apply encoding after body edits. Rewrite currently drops `content-encoding` on edit.

*Effort: Medium.*

---

## UI / UX Gaps

### macOS Native App (`native/`)

| Gap | Impact | Effort |
|-----|--------|--------|
| **No "Errors only" filter** | Web client has it; native doesn't. | Low |
| **No method/status/path search in filter** | Native filter is a simple text search over host+path. Web client filters by method/host/path. | Low |
| **No hex / image preview for binary bodies** | Inspector shows `[binary N bytes]`. No raw hex or image rendering. | Medium |
| **No timing breakdown** | Only `durationMs`. No DNS/Connect/SSL/TTFB split. | Medium |
| **No cURL / fetch export** | Can't copy a request as a reproducible command. | Low |
| **No "Repeat" or "Compose"** | Can't replay a request or build one manually. | Medium |
| **No HAR import/export** | Can't exchange sessions with Chrome DevTools or Charles. | Medium |
| **Table lacks row limit / virtualization** | Could choke on long captures (web has `ROW_LIMIT = 1000`). | Medium |
| **No "Save Session" / "Open Session"** | Sessions are ephemeral or auto-logged. No named project files. | Medium |

### Web / Electron Client (`web/` / `electron/`)

| Gap | Impact | Effort |
|-----|--------|--------|
| **No breakpoint editor UI** | Web client cannot view, edit, continue, or abort paused breakpoints. This is a **major parity issue**—the native app is the only place to use breakpoints. | High |
| **No Map Local local-path validation** | Native warns when paths don't exist; web silently accepts. | Low |
| **No device setup / QR codes** | Native has `DeviceSetupView` with QR codes and mobileconfig; web lacks this entirely. | Medium |
| **No CA trust action** | macOS app can one-click trust the CA; web/Electron cannot. | Medium |
| **Inspector lacks HTML preview toggle** | Native has a sandboxed preview; web only shows raw HTML. | Medium |
| **"AI-generated" badge is prominent** | Understandable disclaimer, but it erodes trust on every launch. Move to About or a one-time first-run screen. | Low |

---

## Productivity & Power-User Features

These are features Charles has that Louie lacks, ordered by user impact.

### High Impact
1. **Repeat / Replay Request** — Re-send a captured request with or without edits. Essential for API debugging.
2. **Manual Request Composer** — Build and send arbitrary HTTP requests from within the proxy.
3. **cURL / fetch / Python Export** — Copy any captured request as a runnable snippet.
4. **HAR Import / Export** — Load Chrome DevTools or Charles sessions; export for sharing.
5. **WebSocket Frame Inspector** — Show individual text/binary frames with direction arrows.

### Medium Impact
6. **Session Folders / Naming** — Organize captures into named sessions (e.g., "Login flow debug", "API v2 migration").
7. **Advanced Search** — Search across bodies, headers, and response codes across the entire session (not just current table filter).
8. **Diff Transactions** — Compare two requests or responses side-by-side (MCP has `diff_transactions`; UI lacks it).
9. **Bandwidth / Traffic Graph** — Simple real-time graph of bytes/sec and request rate.
10. **JSON Pretty-Print Toggle** — Native app has `SyntaxJSON`; web inspector lacks a format toggle.

### Lower Impact
11. **Request/Response Size Limits** — Cap body sizes in memory to prevent OOM on large downloads.
12. **Auto-save Sessions** — Option to persist the in-memory session to disk on interval.
13. **Custom Tool Scripting** — A JavaScript hook API (like Charles' ` Rewrite Script` or Fiddler's `FiddlerScript`).
14. **Dark/Light Theme Toggle in Native** — macOS follows system; explicit toggle is nice-to-have.

---

## Code Quality & Maintainability Notes

| Issue | Suggestion |
|-------|------------|
| `lib/proxy.js` >450 lines | Could be split into `_forwardH1`, `_forwardH2`, `_onConnect` modules. |
| `native/Sources/Louie/ContentView.swift` mixes table + toolbar + header | Extract `SessionTable`, `StatusBar`, and `FilterBar` into subviews. |
| Web client uses `localStorage` for token | Fine for Electron, but for a hosted web build this is a XSS risk if the token is long-lived. Consider `sessionStorage` or http-only cookie if the architecture ever changes. |
| `e2e.js` relies on `curl` binary | Makes tests fragile on Windows. A pure Node test client would be more portable. |
| No type definitions for control API | Both clients re-declare types. A shared OpenAPI or JSON Schema would reduce drift. |

---

## Improvement Roadmap

### Phase 1: Parity & Polish (Weeks 1–3)
*Goal: Make both clients feel complete for current feature set.*

- [ ] **Web breakpoint editor** — Build `BreakpointDialog` in web with the same edit/continue/abort flow as native.
- [ ] **Web filter enhancements** — Add "Errors only", method filter, status filter to match native.
- [ ] **Native filter enhancements** — Add "Errors only", method search, status search to match web.
- [ ] **Web Map Local path validation** — Check file existence client-side or add an API route for validation.
- [ ] **Web device setup view** — Port QR codes and cert-download URLs from native.
- [ ] **Inspector JSON pretty-print toggle** — Add to both clients.
- [ ] **Move "AI-generated" badge** from persistent header to About dialog / first-run.
- [ ] **Fix Map Remote location mutation** — Ensure subsequent filters see the rewritten canonical URL.
- [ ] **Apply `bandwidthUp` in throttle** — Mirror downstream pacing for uploads.

### Phase 2: Power-User Tools (Weeks 4–6)
*Goal: Close the gap with Charles for daily debugging workflows.*

- [ ] **Repeat request** — Control API: `POST /api/transaction/:id/repeat`; UI button in inspector.
- [ ] **Manual request composer** — Simple method/URL/headers/body builder; send through the proxy so it appears in the session table.
- [ ] **cURL / fetch export** — Inspector action in both clients.
- [ ] **HAR export** — Serialize the in-memory session (or selected transactions) to HAR 1.2.
- [ ] **HAR import** — Load HAR into the session table for offline analysis.
- [ ] **Session folders / named sessions** — Allow saving the current table to a named `.louie-session.json` and loading it later.
- [ ] **Transaction diff UI** — Select two rows, open diff pane (request vs request, response vs response).
- [ ] **Timing breakdown** — Instrument DNS, connect, SSL handshake, TTFB in proxy; expose in inspector.

### Phase 3: Modern Protocols & Scale (Weeks 7–10)
*Goal: Support the traffic that real modern apps generate.*

- [ ] **WebSocket proxying** — Upgrade interception, frame capture, new SSE event type `ws-frame`.
- [ ] **WebSocket inspector** — Frame list with direction, opcode, payload.
- [ ] **gRPC / protobuf** — Allow loading `.proto` files, decode protobuf payloads in both directions.
- [ ] **Binary body viewer** — Hex dump mode + image rendering (native + web).
- [ ] **Row virtualization / row limit** — Native table should virtualize or paginate past 5k rows.
- [ ] **Advanced search** — Full-text across headers and bodies; API + UI.
- [ ] **Auto-save + retention** — Option to continuously flush in-memory session to the durable log.

### Phase 4: Extensibility (Weeks 11+)
*Goal: Turn Louie into a platform, not just a proxy.*

- [ ] **Custom tool scripting** — A lightweight JS hook API (e.g., `onRequest(req, res)`) with a sandboxed `vm` module.
- [ ] **Plugin / extension system** — Load user extensions in the engine (careful: engine is zero-dep, so plugins must be opt-in).
- [ ] **Bandwidth graph** — Real-time traffic chart in the header/toolbar area.
- [ ] **Team sync** — Publish profiles to a shared URL or git-backed config repo.
- [ ] **Remote engine connect** — Allow the macOS app to connect to a remote engine instance (useful for server-side debugging).

---

## Recommended Next Steps (Immediate)

If you can only do three things:

1. **Add breakpoint editing to the web client.** This is the biggest parity gap and blocks Linux/Windows users from using the most powerful debugging tool.
2. **Implement Repeat + cURL export.** These are the two features that power users reach for dozens of times per day.
3. **Fix the Map Remote → subsequent filter mutation bug.** It's a silent behavioral divergence that makes complex tool chains frustrating to debug.

---

## Architecture Health Score

| Dimension | Score | Note |
|-----------|-------|------|
| Engine correctness | 8/10 | Minor Charles divergences documented and mostly fixed. |
| Security | 9/10 | Excellent. Final point for formal audit / fuzzing. |
| Test coverage | 7/10 | Good breadth; needs WebSocket / breakpoint / HAR tests. |
| UI parity (native vs web) | 5/10 | Native is richer; web is missing breakpoints and setup. |
| Documentation | 8/10 | `control-api.md` and `charles-behavior.md` are gold standards. |
| Performance at scale | 6/10 | No row virtualization; all bodies in memory; no streaming for large downloads. |
| Modern protocol support | 3/10 | HTTP/2 ✅; WebSocket ❌; gRPC ❌; SSE ❌ (inspection only). |
| Overall | **6.5/10** | Strong foundation. Needs protocol breadth and UI parity to compete. |
