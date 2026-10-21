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

Returns an array of transaction summaries, oldest first, no bodies:

```json
[{ "id": 1, "scheme": "https", "method": "GET", "host": "api.example.com",
   "port": 443, "path": "/v1/x", "status": 200, "durationMs": 12,
   "sslProxied": true, "tunneled": false, "error": null, "complete": true,
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
  "leafCertsGenerated": 3, "sslLocations": [...], "enabled": {"blocklist":false, ...} }
```

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
```

`tx` is emitted on both `tx:new` and `tx:update`. Comment pings (`: ping`) are
sent every 25 s to keep the connection alive.
