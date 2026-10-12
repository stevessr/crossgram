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
