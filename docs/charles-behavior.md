# Charles Proxy 5.2.1 — Tool Behavior Spec

Derived by decompiling `/Applications/Charles.app/Contents/Java/charles.jar` with
jadx (headless). Class names are obfuscated where noted; the mapping below is
verified from the decompiled bodies, not guessed.

Source classes (all under `com.charlesproxy.tools` unless noted):

| Feature | Tool class | Filter class (the real logic) |
| --- | --- | --- |
| Block List | `BlacklistTool` | `UOLV` |
| Map Local | `MapLocalTool` | `fwEL` |
| Map Remote | `MapTool` | `yDHk` |
| Rewrite | `rewrite.RewriteTool` | `rewrite.npZC` |
| Throttle | `com.xk72.throttle.*` | `com.xk72.throttle.sdfE.edfX` |
| Location matching | `com.xk72.common.net.Location` | `com.xk72.common.net.WtvV` |

Note: `BlockCookiesTool` is a separate feature (blocks `Cookie`/`Set-Cookie`
headers), not the Block List. Do not map it to the clone's block-list.

## Location matching (`Location` + `WtvV`)

Charles does **not** do simple host globbing. It builds a regex from the pattern
and matches it against the request's canonical URL `protocol://host:port/path?query`.

Pattern construction (`WtvV.awCZ(Location)`):

| Field | Empty/null pattern | Non-empty pattern |
| --- | --- | --- |
| protocol | `[a-z]*` | literal, dots escaped |
| host | `[^:/]*` | dots replaced with `[^:/]` |
| port | `[0-9]*` | literal |
| path | `/.*` | literal, dots escaped |
| query | `\?.*` | `\?.*<query>.*` |

Other rules:

- Matching is a **full match** on the canonical string, not a substring test.
- A path segment containing `*` after the last `/` collapses the pattern to the
  last `/` (so `/foo/*` matches everything under `/foo/`).
- Schemes and ports are part of the match. A pattern with `https` will not match
  an `http` request.

## Block List (`BlacklistTool` + `UOLV`)

- Config: a list of locations plus a **blocking action**.
- Action selector has two entries, in order:
  - index `0` = **"Drop connection"** (this is the default, `IUux = 0`)
  - index `1` = **"Return 403 response"**
- Filter order: `50`. Runs on `receivedRequestHeader`.
- Behavior when a request matches:
  - tag the transaction with the tool name;
  - if action != 1, throw `ProxyAbortException` ("connection dropped");
  - if action == 1, throw `ProxyDenyException` ("returned error response"), which
    produces an error response.

## Map Local (`MapLocalTool` + `fwEL`)

- Config: rows of `location -> local path`, each with a `caseSensitive` flag.
- Filter order: `72`.
- On `receivedRequestURL`, iterate matching rows in list order:
  - expand a leading `~/` to the user home directory;
  - if the target **does not exist**: log a warning, add a note, and **continue** —
    the request falls through to the real upstream. It does **not** return a 404;
  - if the target is a **directory**: resolve the remainder of the request path
    under it and serve that file (with an optional case-sensitivity check);
  - if a file is found: serve it locally (remote address set to loopback) and tag.
- If no row yields a file, the request proceeds normally.

## Map Remote (`MapTool` + `yDHk`)

- Config: rows of `from location -> to location`, where the destination may set
  protocol, host, port, path, and query.
- Filter order: `10`.
- Runs on both `receivedRequestAddress` and `receivedRequestURL`.
- On match it rewrites:
  - protocol (and switches HTTP/2 headers to HTTP/1.1 when downgrading to http);
  - host (and clears the resolved remote address);
  - port (or resets it to the protocol default);
  - path: replaced by the destination path, preserving the unmatched suffix;
  - query: replaced when the source has no query, appended when the destination
    has no query, otherwise regex-replaced from the matched portion. A literal
    `-` deletes the query.
  - the `Host` header is updated to `host[:port]` when it differs.
- Push promises are disabled for matching locations.

## Rewrite (`rewrite.RewriteTool` + `rewrite.npZC`)

- Config: rewrite **sets**, each with a location and rules; only enabled sets and
  enabled rules apply.
- Filter order: `12`.
- URL rules run on `receivedRequestURL`; header rules on request/response header;
  body rules on the buffered body.
- Body rewriting detects the charset from the header and decodes/re-encodes with
  it (falls back to ISO-8859-1, then platform default).
- Body rules only trigger when the response content type is textual/eligible.

## Throttle (`com.xk72.throttle`)

- A byte-pacing engine (`sdfE.edfX`) that sleeps to enforce an effective rate; it
  also drops a percentage of packets to simulate loss.
- Rate is enforced by comparing elapsed time against `bytes / rate`, then sleeping
  the difference. It is not a fixed one-off delay.

## Divergences from the clone (`lib/tools.js`)

| # | Area | Charles behavior | Clone behavior |
| --- | --- | --- | --- |
| 1 | Block action | Default is **drop connection**; 403 is opt-in (action = 1) | Always returns `403` |
| 2 | Location matching | Full regex on `scheme://host:port/path?query`; scheme/port significant | Host glob (and port/path), scheme optional |
| 3 | Map Local, missing file | Falls through to upstream (no error body) | Returns `404` with an error body |
| 4 | Map Local, directory | Resolves request path under a directory; optional case check | Single file path only |
| 5 | Map Remote | Rewrites protocol/host/port/path/query and `Host` header | Rewrites host/port only |
| 6 | Rewrite body encoding | Uses response charset | Always decodes/encodes UTF-8 |
| 7 | Throttle | Rate pacing (bytes/sec) plus loss | Fixed `latency` sleep only |
| 8 | Ordering | Filters have explicit order (Map Remote 10, Rewrite 12, Block 50, Map Local 72) | Fixed sequence inside one pipeline |

## e2e failures — root cause

The 7 failing tool tests were **not** caused by the tool logic. `test/e2e.js`
invoked curl with `--noproxy '*'`, and in curl `*` means "do not use a proxy for
any host" — so every request bypassed the clone proxy and hit the origin directly.
That made block/rewrite/throttle no-ops and the Map Remote test a false pass
(both origins return the same JSON shape).

Verified empirically: `curl --noproxy '*' -x <proxy> <url>` returns the origin
body; `curl -x <proxy> <url>` (or `--noproxy ''`) returns the proxy body.

Fix applied: `test/e2e.js` now uses `--noproxy ''`. Result: 8/10 pass. Driving the
pipeline directly also confirms block → 403, rewrite → body changed, throttle → +time.

Remaining 2 failures are environmental: the MITM tests use `origin.test`, which
must resolve to `127.0.0.1`. Without an `/etc/hosts` entry the proxy returns
`502 getaddrinfo ENOTFOUND origin.test`. Add `127.0.0.1 origin.test` to `/etc/hosts`
(or point the test at a resolvable host) to make them pass.

## Behavioral gaps to address (to match Charles)

These do not break the current tests, but diverge from the real app:

- Block List: clone always returns 403; Charles defaults to dropping the connection
  and offers 403 as an option.
- Map Local: clone returns 404 when the file is missing; Charles falls through to
  upstream. Charles also supports directory mapping and case-sensitive matching.
- Map Remote: clone rewrites host/port only; Charles also rewrites protocol, path,
  and query, and updates the `Host` header.
- Rewrite: clone assumes UTF-8; Charles uses the response charset.
- Throttle: clone adds a fixed latency; Charles paces by bytes/sec and can drop
  packets.
- Location matching: clone uses host globs; Charles matches a full regex against
  `scheme://host:port/path?query`, so scheme/port are significant.

## Implementation status

All of the above are implemented in `lib/tools.js`, with e2e coverage in
`test/e2e.js` (18 tests, all passing):

- Location matching now builds the canonical-URL regex (`locationRegex`).
- Block List has `blockAction: 'drop' | '403'`; **default is `drop`** (Charles).
  The proxy destroys the client socket for `drop`.
- Map Local falls through to upstream when the file is missing, supports
  directory targets, `~/` expansion, extension-based content types, and an
  optional `caseSensitive` check.
- Map Remote rewrites protocol/host/port/path/query and the `Host` header.
- Rewrite decodes/re-encodes bodies with the response charset and skips
  non-textual content types.
- Throttle adds a fixed `latency` and paces by `bandwidthDown` (KB/s).
- Pipeline order is Map Remote (10) -> Rewrite (12) -> Block List (50) ->
  Map Local (72) -> No Cache -> Throttle.
- MITM negotiates ALPN and serves HTTP/2 (or HTTP/1.1) to the client; upstream
  uses HTTP/2 when the origin supports it (cached ALPN probe), else HTTP/1.1.
  Push promises are never used.

Known remaining gaps:

- Filters after Map Remote match the original location, whereas Charles mutates
  the event so later filters see the mapped location.
- Throttle does not implement packet-loss simulation.
- `bandwidthUp` (request pacing) is not applied.

The UI is the native macOS app (Louie, `native/`); the static web GUI was
retired and the server is now API-only. `blockAction` and the Map Remote
path/query fields are exposed in the native Tools editor.

