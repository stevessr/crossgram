# CrossGram OneBot V11 adapter

This Cordis IM adapter connects a QQ-compatible **OneBot V11 forward WebSocket** implementation (such as NapCat with OneBot 11 enabled) to CrossGram's MTProto bridge. One OneBot plugin instance represents one logged-in QQ account.

## Configuration

Enable `@mtproto-relay/platform-onebot` in `app.yml`, then set:

```yaml
- id: onebot
  name: '@mtproto-relay/platform-onebot'
  config:
    endpoint: ws://127.0.0.1:3001
    accessToken: ${ONEBOT_ACCESS_TOKEN}
    requestTimeoutMs: 15000
    reconnectDelayMs: 1000
```

Configure the upstream OneBot process to serve forward WebSocket at that address. If the upstream has no access token, omit the `accessToken` key. Do not expose unauthenticated WebSocket on the public Internet. For remote connections use WSS with TLS. The token is placed in the OneBot standard `access_token` URL query parameter and might appear in upstream proxy logs.

## Implemented

- OneBot V11 action/echo correlation over WebSocket; reconnect with capped exponential backoff; request deadlines.
- Get current account, contacts, group list, group info, user info, group member list (paged locally).
- Private and group messages; CQ-string and array segment payloads; mentions, replies, images, audio/file references and unknown-segment fallback.
- Send text, mentions, replies, and inline image bytes; native `delete_msg` for recalls; receive recall notices.
- Map friend and group-join requests, with OneBot request approval/denial API calls.
- HTTP(S) media streaming and bounded inline image upload.

## Protocol boundaries

Standard OneBot V11 has no portable history-list/search API, so `history` is intentionally disabled. It also has no standard message editing or general file-send endpoint; those features remain unavailable rather than being emulated incorrectly. Request events are buffered in memory until restart. Media carried only as an upstream-local file path needs an accessible HTTP URL or the standard `get_image` endpoint to download through CrossGram. Reverse WebSocket is not implemented by this transport.
