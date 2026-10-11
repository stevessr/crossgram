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

## Matrix polls and locations

- Legacy `m.location` and MSC3488 extensible locations become Telegram native
  map media when they contain valid WGS84 `geo:` coordinates. Invalid locations
  retain a text fallback. This is Matrix-to-Telegram support only.
- Both stable and MSC3381 poll formats are understood. Poll starts preserve
  question, answer IDs and selection limits. Individual vote events are never
  displayed as standalone chat messages.
- Single-choice polls expose callback options in Telegram clients that support
  inline keyboards. Before a vote is sent, the adapter pages through Matrix
  reference relations to check whether the poll has closed; unverifiable status
  **fails closed** rather than risking a late vote. Multiple-choice polls remain
  read-only and should be answered in a Matrix client.
- Closed polls can display verified counts after all reference-relation pages are
  fetched. The adapter computes the latest non-redacted eligible vote per user
  and does not trust any summary supplied in `m.poll.results`. Counts are not
  shown before closure. On live poll-end events, the original poll is updated
  without its voting buttons. Recent closed polls may be backfilled from history.

## Current limitations

- End-to-end encryption is not implemented. Encrypted events and attachments are
  shown as explicit placeholders instead of exposing ciphertext or silently
  dropping messages. Use an unencrypted room for full functionality.
- Matrix reactions and stickers are not exposed yet.
- Telegram native poll RPCs, multiselect voting, creating polls from Telegram,
  and sending Telegram locations back to Matrix are not implemented.
- Poll counts may lag late federation/redaction events until the poll is
  reloaded; the adapter does not provide continuous authoritative tally sync.
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
