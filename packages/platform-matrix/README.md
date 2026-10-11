# @mtproto-relay/platform-matrix

Matrix Client-Server API adapter for CrossGram. It connects one Matrix account
to one named Cordis platform entry and exposes joined rooms to Telegram clients.

```yaml
- id: matrix
  name: '@mtproto-relay/platform-matrix'
  config:
    homeserver: https://matrix.example.com
    accessToken: replace-with-your-access-token
    # Optional; otherwise /account/whoami is used.
    userId: '@alice:example.com'
    # Optional HTTP(S) proxy for API and media requests.
    proxy: http://127.0.0.1:7890
    syncTimeoutMs: 30000
    requestTimeoutMs: 30000
```

The adapter supports account profiles, direct and group rooms, Matrix Spaces,
room history, room-scoped message search, incremental `/sync`, text/image/file/audio/video messages, replies,
media upload/download, read markers, text edits, redactions, members, power-level
permissions, user/room avatars, and Matrix room invitations in the shared request inbox
(with accept/reject actions). Mixed Telegram messages are represented by
multiple ordered Matrix events and retained as one logical bridge message.

## Message search

The adapter uses the Matrix Client-Server API `POST /_matrix/client/v3/search` for
non-empty text searches, with room and sender constraints applied by the homeserver.
Indexed attachment filenames are also searchable without being injected into the
visible Telegram message text. Result ordering is newest first and pagination uses the homeserver's opaque
`next_batch` token. Date ranges and image/file-type filters are evaluated after
retrieval, so counts may be unavailable and pages may be shorter if very few
messages match. Searches without keywords scan paginated room history, including
links and combined photo/video filters applied by the Telegram bridge.
Full-text results depend on the homeserver's search-index configuration; encrypted
messages cannot be searched by a server that does not have their plaintext.

## Current limitations

- End-to-end encryption is not implemented. Encrypted events and attachments are
  shown as explicit placeholders instead of exposing ciphertext or silently
  dropping messages. Use an unencrypted room for full functionality.
- Matrix reactions and stickers are not exposed yet.
- Edits currently accept a single text part. Matrix forwarding is not supported.
- Matrix Spaces are shown as channel-shaped dialogs; room hierarchy is not yet
  projected as Telegram subchannels.

## Tests

```bash
yarn workspace @mtproto-relay/platform-matrix test
yarn workspace @mtproto-relay/platform-matrix test:e2e
```

The e2e suite starts a real local HTTP server and a tunneling HTTP proxy, then
exercises the adapter through the same authenticated transport used for a
homeserver.
