# WebUI control-plane connectivity

The Solid console uses a single WebSocket at `apiPath` (default `/api`). Ensure
the reverse proxy routes **both** the UI path (for example `/console`) and
`/api` to the same Cordis HTTP server, with WebSocket Upgrade enabled.

The server sends native WebSocket ping control frames every 25 seconds. Browsers
automatically respond with pong frames even when a background tab throttles
JavaScript timers. A peer that fails to answer for 90 seconds is closed to
release resources. The browser additionally probes active foreground connections,
and skips its JS-based heartbeat while hidden to avoid false timeouts.

A connection that never receives its initial `entry:init` within 20 seconds is
recreated. Browser `online` and visibility recovery events can expedite a
scheduled reconnect without creating concurrent sockets. Reconnection does
**not** replay RPC mutations, whose result might already be committed. Active
subscriptions are restored from fresh snapshots.

Example reverse proxy (adjust the origin port and paths to your deployment):

```nginx
location /api {
    proxy_pass http://127.0.0.1:3140;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

For recurring failures, inspect the browser Network > WS tab for the close code
and handshake status, and compare server-side WebSocket close events with proxy
logs. An absent 101 Switching Protocols response is a proxy or routing problem,
not a reconnect-timer problem.


## Optional Protocol Buffers transport

The browser and server begin in JSON mode for compatibility. New servers
advertise `transport: "protobuf-gzip-v1"` in the initial `entry:init` body.
A capable browser responds with `transport:upgrade` (JSON), then waits for
`transport:ready` (JSON) before sending binary messages. Legacy peers that do
not negotiate continue using JSON unchanged. Neither side requires a hard
reload during mixed-version rollout.

Binary frames follow [webui.proto](../../packages/cordis-webui-solidjs/src/webui.proto):
a small protobuf enum message kind, a JSON-encoded Muon/RPC body in `bytes`,
and an optional gzip flag. This is *protobuf framing with gzip*, not a
complete schema conversion of every extension-specific data object. Such
objects remain JSON to retain plugin compatibility.

Large payloads (at least 2 KiB) are gzip-compressed at level 1 only when
compressed size is below 87.5% of raw payload size. A broadcast is encoded
only once for all upgraded clients, and old-format JSON envelopes are not
generated when all subscribers use protobuf. The browser limits expanded
payloads to 32 MiB; server request frames retain the stricter 1 MiB bound.
Compressed client frames are accepted but the browser currently sends raw
protobuf for small interactive requests to keep latency predictable.

If the compressed transport fails to negotiate, inspect WS frames and verify
that the reverse proxy preserves both text and binary WebSocket frames. A
proxy must never rewrite the WebSocket frame payload, and TLS/CDN termination
must allow WebSocket upgrades.


## HTTP content encoding (origin server)

The Solid WebUI service now installs HTTP content encoding for the shared Cordis
HTTP listener. This is independent of the WebSocket `protobuf-gzip-v1` format.

- Buffered textual responses (HTML, JS, CSS, JSON, SVG, XML) larger than 1 KiB
  negotiate `gzip`, `br`, or `zstd` from `Accept-Encoding`, respecting
  quality weights, explicit exclusions, and a server-side availability check.
  Zstandard is enabled only if Node's zlib binding exposes both encoder and
  decoder. The server does not double-compress pre-encoded responses.
- JSON, form, and text request bodies with `Content-Encoding` are decoded
  before routing. Encoded request bodies are capped at 4 MiB; decompressed bodies
  at 8 MiB. Unsupported codings return HTTP 415, malformed bodies HTTP 400, and
  limit violations HTTP 413.
- Streaming payloads, SSE, file/media types, ranges, tiny payloads, and
  responses marked `Cache-Control: no-transform` retain their original bytes.
  Response compression is disabled by setting `enableHttpEncoding: false` on
  the Solid WebUI plugin. All compressed response variants emit
  `Vary: Accept-Encoding`.

Reverse proxies may apply their own content coding; do not force gzip on an
already compressed response. WebSocket binary frames are *not* HTTP response
bodies and continue to use their existing frame-layer compression negotiation.

## Incremental SSE alternative

`GET /api/events` (or `<apiPath>/events`) provides a read-only Server-Sent
Events view of WebUI entry metadata and Muon deltas:

```http
GET /api/events?entry=<entry-id>&entry=<another-id>
Accept: text/event-stream
Last-Event-ID: 123
```

The endpoint emits `entry:init` followed by initial `entry:snapshot`
frames for the requested entries, then `entry:delta` whenever the underlying
entry state changes. Events carry monotonically increasing numeric IDs.
Clients can resume from `Last-Event-ID` within a bounded 512-event ring; a
missing/stale cursor instead triggers fresh snapshots. A comment heartbeat
is sent every 15 seconds and slow readers are closed rather than buffered
indefinitely. `no-transform` and `X-Accel-Buffering: no` prevent proxy
batching. Cross-origin requests are rejected and existing HTTP authentication
middleware remains in force.

SSE intentionally cannot mutate state or invoke RPC; those capabilities
remain on the authenticated WebSocket control plane. Disable this transport
with `enableSse: false` if the endpoint is not needed.


## Incremental WebSocket RPC

New WebUI servers advertise `features.rpcStream = true` in the initial
`entry:init` handshake. Existing `rpc:request` / `rpc:response` Promise
calls remain unchanged. Opt-in requests supply `stream: true`, causing
`rpc:start`, repeated `rpc:delta`, then `rpc:complete` (or `rpc:error`).
These message kinds also have protobuf enum values 11–15 and are supported in
JSON mode before an upgrade.

Browser callers can consume an exposed async-generator method with:

```ts
for await (const chunk of connection.rpcStream('entry-id', 'method', [arg])) {
  // Each chunk is an individual server-generated value.
}
```

Breaking out of the iteration sends `rpc:cancel`; the server invokes
`AsyncIterator.return()` if provided. Stream cancellation is cooperative,
not transactional: a mutation may already have completed. The browser also
limits unread chunks to 16, enforces a per-chunk idle timeout, and fails active
streams on WS disconnect rather than replaying side effects.

A method that returns a non-iterable value with `stream: true` yields one
`rpc:delta` and then completes. Streaming is **opt-in**, preserving compatibility
with all existing WebUI plugins and non-streaming clients.
