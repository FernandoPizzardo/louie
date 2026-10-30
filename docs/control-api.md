# Control API contract

The engine (`bin/charles-clone.js`) exposes a small HTTP API from `lib/web.js`.
Every client depends on it: the SwiftUI macOS app (`native/`) and the planned
web/Electron clients. This document is the contract; `test/control-api.test.js`
guards it. Change one and you change the other.

Base URL is the loopback control port (`config.webPort`, or an ephemeral port in
headless mode). Bodies are JSON unless noted. All responses set
`Cache-Control: no-store`.

## Authentication

When a token is configured, every `/api/*` request **and** `/events` must present
it, via either:

- header `x-charles-token: <token>`, or
- query `?token=<token>`

A missing or wrong token returns `401 {"error":"unauthorized"}`. The CA-serving
listener (below) is **not** token-protected, because phones fetch it directly.

## Routes

### `GET /api/transactions`

Returns an array of transaction summaries, oldest first, no bodies. `paused` is
`true` while a breakpoint holds the call:

```json
[{ "id": 1, "scheme": "https", "method": "GET", "host": "api.example.com",
   "port": 443, "path": "/v1/x", "status": 200, "durationMs": 12,
   "sslProxied": true, "tunneled": false, "error": null, "complete": true,
   "paused": false,
   "reqSize": 0, "resSize": 32, "contentType": "application/json",
   "notes": [], "start": 1792015376000 }]
```

### `GET /api/transaction/:id`

Full detail for one call, or `404 {"error":"not found"}`. Adds to the summary:

```json
{ "requestHeaders": {...}, "requestBody": {"type":"text","text":"...","truncated":false},
  "responseHeaders": {...}, "responseBody": {"type":"text","text":"...","truncated":false} }
```

`requestBody`/`responseBody.type` is `empty`, `text`, or `binary`; `text` is
capped at 512 KB and flagged with `truncated`.

### `POST /api/transaction/:id/save`

Pins a read-only copy into `saved/` for the MCP server. Body `{"full": true}`
keeps a body that is over the size cap. Responses:

- `200 {"ok":true,"name":"<file>","path":"<abs>","truncated":false}`
- `200 {"ok":false,"needsConfirm":true,"size":N,"cap":N}` — body was oversized and
  `full` was omitted; retry with `{"full":true}`
- `404 {"ok":false,"error":"not found"}` — unknown id
- `500 {"ok":false,"error":"session log unavailable"}`

### `GET /api/saved`

Array of pinned copies: `[{"name":"<file>","size":N,"mtime":"<iso>"}]`.

### `GET /api/saved/:name`

The pinned record (full bodies), or `404 {"error":"not found"}`. `:name` is
URL-encoded; names matching `^[A-Za-z0-9._-]+$` only.

### `GET /api/persist`

```json
{ "enabled": false, "dir": "/path/to/sessions-data", "maxBodyBytes": 524288, "retentionDays": 7 }
```

### `POST /api/persist`

Merges any of `enabled`, `dir`, `maxBodyBytes`, `retentionDays` into the config,
reconfigures the session log live, persists, and returns `{"ok":true}`.

### `GET /api/config`

Returns the whole config object (see `lib/config.js#defaults`).

### `POST /api/config`

Shallow-merges the body into the config, refreshes the tool pipeline, persists,
and returns `{"ok":true}`.

### `POST /api/clear`

Empties the in-memory session and returns `{"ok":true}`. Also emits a `clear`
SSE event. `GET` is not supported (falls through to `404`).

### `POST /api/recording`

Body `{"on": true|false}`; pauses/resumes recording and returns `{"on": <bool>}`.
Also emits a `recording` SSE event.

### `GET /api/status`

```json
{ "proxyPort": 8888, "webPort": 8889, "recording": true, "count": 12,
  "leafCertsGenerated": 3, "sslLocations": [...], "enabled": {"blocklist":false, ...},
  "breakpointsEnabled": false, "pendingBreakpoints": 0 }
```

## Breakpoints (interception)

A breakpoint rule suspends a matching transaction until a client resumes it. The
engine's `lib/breakpoint.js` holds the suspended call, emits a `breakpoint` SSE
frame and waits for one of the routes below. If nothing answers within
`breakpoints.timeoutMs` (default 120000) the transaction is released unmodified,
so the proxy can never wedge.

Rules live in the config (`POST /api/config` accepts the whole section):

```json
{ "breakpoints": { "enabled": true, "timeoutMs": 120000,
    "rules": [{ "enabled": true, "scope": "both", "location": { "host": "api.example.com" } }] } }
```

`scope` is `request`, `response`, or `both`. A rule's `location` uses the same
canonical-URL matching as the other tools (see `docs/charles-behavior.md`).

### `GET /api/breakpoints/pending`

Every suspended transaction, oldest first:

```json
[{ "id": 1, "transactionId": 42, "phase": "request", "deadline": 1792015496000,
   "summary": { <transaction summary> },
   "request": { "method": "POST", "url": "https://api.example.com/v1/x",
                "headers": {...},
                "body": { "type": "text", "text": "...", "editable": true } },
   "response": { "status": 200, "headers": {...},
                 "body": { "type": "empty", "text": "" } } }]
```

`body.type` is `empty`, `text`, or `binary`; `editable` is `false` for binary
bodies, which a client must not modify.

### `POST /api/breakpoint/:id/continue`

Resumes with no changes. `200 {"ok":true,"transactionId":42,"action":"continue"}`,
or `404 {"ok":false,"error":"not found"}`.

### `POST /api/breakpoint/:id/abort`

Drops the connection (the client sees it die). Returns
`{"ok":true,"transactionId":42,"action":"abort"}` or `404`.

### `POST /api/breakpoint/:id/edit`

Applies the edits, then resumes. Only the side matching the hit's `phase` is
honoured:

```json
{ "request":  { "method": "PUT", "url": "https://...",
                 "headers": {"x-a": "1"},
                 "body": { "type": "text", "text": "..." } },
  "response": { "status": 418, "headers": {...},
                "body": { "type": "text", "text": "..." } } }
```

Returns `{"ok":true,"transactionId":42,"action":"continue","edited":true}`, or
`404 {"ok":false,"error":"not found"}`. Editing a URL re-targets the upstream
request (scheme/host/port/path/query). Editing a body recomputes `content-length`
and drops `content-encoding`.

### `GET /api/ca`

Root CA identity:

```json
{ "path": "/path/ca.crt", "subject": "CN=...", "fingerprint": "AA:BB:...",
  "fingerprintHex": "aabb...", "trusted": false }
```

`subject`/`fingerprint` are `null` if `openssl` is unavailable; `trusted` is
macOS-specific (`security verify-cert`).

### `POST /api/ca/trust`

User-initiated: adds the root CA to the login keychain as a trusted root.
`200 {"ok":true,"output":"..."}` or `500 {"ok":false,"error":"..."}`. macOS may
prompt for authorization.

### `GET /api/ca.pem`

The root certificate as PEM (`application/x-pem-file`).

### `GET /api/net`

Device-debugging endpoints and current LAN state:

```json
{ "lanEnabled": false, "ip": "127.0.0.1", "proxyPort": 8888, "caServePort": 8890,
  "serving": false, "cerUrl": "http://127.0.0.1:8890/ca.cer",
  "mobileconfigUrl": "http://127.0.0.1:8890/ca.mobileconfig",
  "proxyHost": "127.0.0.1:8888" }
```

`ip` is the first non-internal IPv4 when LAN is on, else `127.0.0.1`.

### `POST /api/lan`

Body `{"on": true|false}`; flips `lanEnabled` and `bindHost`
(`0.0.0.0` / `127.0.0.1`), rebinds the proxy if it is attached, and returns
`{"ok":true,"bindHost":"...","restarting":false}`.

### `POST /api/ca/serve`

Body `{"on": true|false}`; starts/stops the CA-serving listener and returns
`{"ok":true,"serving":<bool>,"cerUrl":"...","mobileconfigUrl":"..."}`.

### `POST /api/import/charles`

Body `{"path": "<optional XML path>"}`; imports settings from the real Charles
app and returns `{"ok":true,...report}`, or `500 {"ok":false,"error":"..."}`.

### `POST /api/profile/export`

Builds a **shareable profile**: the tool configuration, plus optionally redacted
captures, in one versioned JSON envelope.

Body (all optional):

```json
{ "name": "Team staging", "includeCaptures": false, "full": false,
  "ids": [1, 2, 3], "path": "/optional/also/write/here.json" }
```

- `includeCaptures` defaults to `false`.
- `ids` limits captures to those transaction ids; omitted means the whole session.
- `full` keeps bodies over the persist cap.

```json
{ "ok": true, "name": "Team staging", "fileName": "Team-staging.louie.json",
  "captures": 3, "profile": { "louieProfile": 1, "kind": "louie-profile", ... } }
```

The `profile` envelope:

```json
{ "louieProfile": 1, "kind": "louie-profile", "name": "Team staging",
  "exportedAt": "2026-10-30T15:00:00.000Z", "louieVersion": "1.0.0",
  "tools": { "enabled": {...}, "blockAction": "drop", "blocklist": [...],
             "mapRemote": [...], "mapLocal": [...], "rewrite": [...],
             "throttle": {...}, "breakpoints": {...}, "sslLocations": [...] },
  "captures": [ <redacted transaction records> ] }
```

Guarantees — a profile is a file you send to other people:

- Captures are **redacted before serialization**, using the same rules as local
  session history (`Authorization`, `Cookie`, `Set-Cookie` and common
  token/password fields).
- The control-API token, the CA key/private material and the persist directory are
  **never** written.
- Transactions still held by a breakpoint are skipped (their response is incomplete).

### `POST /api/profile/inspect`

Validates a profile and summarises it **without applying anything** (the import
preview). Body `{"profile": <envelope>}`.

```json
{ "ok": true,
  "info": { "name": "Team staging", "exportedAt": "...", "louieVersion": "1.0.0",
            "sections": { "blocklist": 1, "mapRemote": 2, "mapLocal": 0 } },
  "captures": [{ "ts": "...", "method": "GET", "host": "api.example.com",
                 "path": "/v1/x", "status": 200, "notes": ["Rewrite"] }] }
```

A non-profile or an unsupported version returns `400 {"ok":false,"error":"..."}`.

### `POST /api/profile/import`

Merges a profile. Body `{"profile": <envelope>, "sections": ["blocklist", ...]}`.
`"sections"` is optional; omitted means every section the file carries.

```json
{ "ok": true, "applied": ["blocklist", "enabled"],
  "warnings": ["Breakpoints are imported switched off until you enable them in Tools — they will pause matching traffic."],
  "skipped": ["mapLocal"] }
```

Merge semantics:

- Selectable sections: `enabled`, `blocklist`, `mapRemote`, `mapLocal`, `rewrite`,
  `throttle`, `breakpoints`, `sslLocations`.
- `enabled` merges **key-by-key and only turns tools on** — a profile can never
  disable a tool the recipient enabled themselves.
- Unknown/hand-injected keys (a `token`, a `caDir`) are ignored.
- Map Local paths that do not exist on this machine produce a warning.
- A malformed profile returns `400 {"ok":false,"error":"..."}` and changes nothing.

### Anything else

`404 {"error":"not found"}`.

## CA-serving listener

Started by `POST /api/ca/serve`, bound to `0.0.0.0` when LAN is on else
`127.0.0.1`, on `config.caServePort`. Serves **only** the public certificate:

- `GET /ca.cer` → DER root cert, `application/x-x509-ca-cert`
- `GET /ca.mobileconfig` → Apple configuration profile, `application/x-apple-aspen-config`
- anything else → `404 text/plain "not found"`. **`ca.key` is never served.**

## Server-Sent Events: `GET /events`

`Content-Type: text/event-stream`. On connect the server sends one
`hello` frame, then pushes as the store changes:

```
event: hello
data: {"count":12}

event: tx
data: {<transaction summary>}

event: clear
data: {}

event: recording
data: {"on":false}

event: breakpoint
data: {<pending hit, as in GET /api/breakpoints/pending>, "pending":true}

event: breakpoint
data: {"id":1,"transactionId":42,"action":"continue","pending":false}
```

A `breakpoint` frame with `pending:true` also carries the paused transaction's
`summary`, which is pushed as a `tx` frame first so the table can show it as
paused. Resolving a hit emits a `pending:false` frame.

`tx` is emitted on both `tx:new` and `tx:update`. Comment pings (`: ping`) are
sent every 25 s to keep the connection alive.
