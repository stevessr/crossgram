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

### Getting an access token

The WebUI's "Platform accounts" page can mint the token for you; the
"添加账号" dialog accepts account password or homeserver SSO login in addition
to a manually pasted token. Password and SSO flows run through the relay's
bounded `POST /api/matrix/login` proxy (browsers cannot call the homeserver
cross-origin); the credentials are forwarded once and never stored, and the
minted token is written into this plugin's configuration through the loader
management boundary. When a token is revoked the sync loop stops with a
"M_UNKNOWN_TOKEN" warning and the account card shows the error until the token
is replaced in the WebUI.

The adapter supports account profiles, direct and group rooms, Matrix Spaces
(projected as Telegram chat folders rather than forum topics),
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
  dropping messages. **Encrypted rooms are read-only for message contents**:
  CrossGram rejects plaintext text, media/sticker uploads, edits, reactions,
  and poll votes. Every attempted write verifies current room state; failed
  state lookups also block sending instead of treating the room as plaintext.
  Redactions and read markers are still supported. This safety guard is **not**
  a substitute for Matrix Megolm encryption or device/key verification. Use
  an unencrypted room for full functionality.
- Reactions use `m.annotation` events: the adapter can read counts/actors, set
  up to 20 emoji reactions, and emits reaction updates when annotations are
  added or redacted. Homeserver relation pagination is followed before results
  are returned.
- Uploaded static and animated (non-video) stickers are sent as `m.sticker`
  events and projected as media. Native sticker references and video stickers
  cannot be sent. Received sticker events are exposed as media.
- Telegram native poll RPCs, multiselect voting, creating polls from Telegram,
  and sending Telegram locations back to Matrix are not implemented.
- Poll counts may lag late federation/redaction events until the poll is
  reloaded; the adapter does not provide continuous authoritative tally sync.
- Edits accept one text part and preserve existing media metadata, reply context,
  and formatted entities when the original event is available. Matrix forwarding
  is not supported.
- Only joined Matrix rooms are exposed as Space children. Links to rooms not
  joined by this account are not yet shown (room previews/join flows are unavailable).
- Matrix rooms may belong to multiple Spaces. Each joined Space becomes a separate
  Telegram chat folder; overlapping membership is retained. Nested Spaces are
  flattened, with descendant joined rooms included in each ancestor folder.
  Cyclic links, invalid child links and unjoined rooms are ignored.
- A Space is not a chat, channel or forum topic in Telegram. Its member rooms
  remain ordinary independent Telegram chats. Empty Spaces have empty folder filters.
- Telegram folders are flat, so nested Spaces appear as separate folders rather
  than as nested UI directories. Folder IDs persist across server restarts.
  Spaces are managed from Matrix; attempting to edit a mirrored filter from
  Telegram is rejected. Folder changes become visible when the client fetches
  its dialog filters again.
- Full room-state snapshots are shared briefly between root-dialog and child-page
  requests to avoid refetching the complete `/sync` response for every page.
- Full-state snapshots retry when an incremental sync changed the hierarchy in
  flight; stale snapshots cannot overwrite newer parent/child links.
- Legacy Space channel conversations are no longer exposed by the adapter.
  Existing joined member rooms are reconciled into standalone chats at startup.

## Tests

```bash
yarn workspace @mtproto-relay/platform-matrix test
yarn workspace @mtproto-relay/platform-matrix test:e2e
```

The e2e suite starts a real local HTTP server and a tunneling HTTP proxy, then
exercises the adapter through the same authenticated transport used for a
homeserver.
