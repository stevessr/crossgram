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

The adapter supports account profiles, direct and group rooms, Matrix Spaces
(with joined-room nesting projected as Telegram forum topics), room history,
incremental `/sync`, text/image/file/audio/video messages, replies,
media upload/download, read markers, text edits, redactions, members, power-level
permissions, and user/room avatars. Mixed Telegram messages are represented by
multiple ordered Matrix events and retained as one logical bridge message.

## Current limitations

- End-to-end encryption is not implemented. Encrypted events and attachments are
  shown as explicit placeholders instead of exposing ciphertext or silently
  dropping messages. Use an unencrypted room for full functionality.
- Matrix reactions and stickers are not exposed yet.
- Edits currently accept a single text part. Matrix forwarding is not supported.
- Only joined Matrix rooms are exposed as Space children. Links to rooms not
  joined by this account are not yet shown (room previews/join flows are unavailable).
- Matrix permits rooms to have several parents, while the bridge has a single
  `parentId`. The adapter chooses one stable parent, orders children using
  `m.space.child.order`, and prevents cycles; other parent links are not rendered.
- Space containers and nested child rooms are mapped to channel-shaped dialogs
  with Telegram forum topics. Empty children display a topic placeholder rather
  than failing to open.
- Telegram forum topics are flat: although the adapter retains nested parent IDs
  and exposes `getSubdialogs` recursively, Telegram clients cannot navigate
  multiple nested topic levels as a true tree. A dedicated hierarchy UI would
  be needed for full multi-level navigation.
- Full room-state snapshots are shared briefly between root-dialog and child-page
  requests to avoid refetching the complete `/sync` response for every page.
- Full-state snapshots retry when an incremental sync changed the hierarchy in
  flight; stale snapshots cannot overwrite newer parent/child links.
- Forum topic IDs remain stable within a running bridge session when an empty
  Matrix child receives its first message.

## Tests

```bash
yarn workspace @mtproto-relay/platform-matrix test
yarn workspace @mtproto-relay/platform-matrix test:e2e
```

The e2e suite starts a real local HTTP server and a tunneling HTTP proxy, then
exercises the adapter through the same authenticated transport used for a
homeserver.
