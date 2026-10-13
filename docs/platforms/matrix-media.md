# Matrix avatars and stickers

- `photos.uploadProfilePhoto` uploads an image to Matrix media storage, then writes the authenticated user's `avatar_url`. `photos.deletePhotos` only removes a matching current photo; Matrix does not maintain Telegram-style profile photo history. `photos.updateProfilePhoto(inputPhotoEmpty)` removes the current avatar.
- `channels.editPhoto` writes `m.room.avatar`. Uploaded static images and removal are supported; bot/fallback/video/emoji-markup/reusing an unrelated Telegram photo are explicitly rejected. The homeserver enforces authorization. Failed writes do not change the relay projection.
- Space avatars are retained in the native folder model, and use the same Matrix state write as rooms. Telegram chat-list folders have no photo field or avatar-edit UI: this does not create a fake Space chat.
- Avatar removals use an explicit domain tombstone so partial user/conversation updates do not resurrect an old persisted photo.
- `m.sticker` events are sticker parts rather than ordinary image attachments. Native Matrix stickers reuse MXC media instead of downloading and reuploading it.
- Stable `m.room.image_pack`, `m.image_pack.rooms` and personal `m.image_pack` names and legacy `im.ponies.room_emotes`, `im.ponies.emote_rooms`, `im.ponies.user_emotes` names are accepted. Stable room state wins for the same state key.
- Local room packs stay attached to that room's Telegram `channelFull.stickerset`. Multiple packs are combined into one room set because Telegram exposes one attached set. Canonical Space packs are inherited with cycle/depth limits. User-selected global packs and personal packs are available in every room and automatically associated only with the owning Matrix account.
- Global room selections use exact state keys; an empty room object does not enable all packs. Explicitly enabled packs from non-joined rooms are fetched through Matrix's authorized state endpoint with a bounded 30-second cache. Removed/redacted/empty packs disappear from the catalog. Sync changes invalidate the bridge catalog cache.
- A separate image-pack state index prevents sticker lookup from walking every room member. No new background polling is introduced.

References: [Matrix image packs](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/2545-emotes.md), [Matrix Client-Server API](https://spec.matrix.org/v1.19/client-server-api/).

Validation uses local HTTP homeserver fixtures and actual bridge RPC/upload/SQLite paths, plus encrypted MTProto long-vector serialization. It does not modify a live user's Matrix avatar or demonstrate a real Telegram client UI.

## Automatic pack association and reactions

Received `m.sticker` MXC URIs are matched against visible image packs and emitted
with the same canonical sticker/set identity as the Telegram pack catalog.
Current-room packs take precedence over global duplicates; canonical Space
packs and enabled global/personal packs are included. Unmatched events remain
standalone stickers, not invented packs. Matching uses a bounded room index,
invalidated by pack, account-data and membership state changes. Global-only
catalogs also attach to rooms that have no local pack.

The reaction picker publishes the full bundled Unicode Emoji 18.0 keyboard list
and the room-visible sticker images (including global/personal and inherited
packs), not only eleven hard-coded defaults. The full Unicode list is added only
to picker requests, not copied into every stored message reaction context.
Known MXC reaction keys project as Telegram custom emoji with downloadable media;
sending them writes the original MXC key in `m.annotation`. This image-key
convention follows [MSC4027](https://github.com/matrix-org/matrix-spec-proposals/pull/4027),
which is a proposal, not a claim of a finalized Matrix image-reaction standard.

Per the [Matrix reaction rules](https://spec.matrix.org/v1.19/client-server-api/#event-annotations-and-reactions),
Unicode keycaps, flags, ZWJ sequences and non-emoji string keys are not dropped.
Duplicate annotations from the same sender/key count once and produce one actor.
Key strings are retained exactly, without emoji variation-selector rewriting.

Local HTTP/bridge E2E covers opening the received sticker's set, canonical asset
lookup, room-scoped picker contents, MXC reaction send/read, duplicate counts and
ranged custom-reaction downloads. Actual Telegram picker rendering remains
client-dependent and is not demonstrated by these API fixtures.

## Replies, confirmation and deletion

Rich replies map `m.in_reply_to.event_id` to Telegram's native reply header,
including when the parent needs fetching outside the current history page.
Legacy `> ` and `<mx-reply>` fallback quotations are removed before text/mention
projection, so the quote is not duplicated in the message body. Thread fallback
relations (`m.thread` with `is_falling_back: true`) do not invent explicit replies.
See [Matrix rich replies](https://spec.matrix.org/v1.19/client-server-api/#rich-replies).

After a successful self-send, confirmation reuses a sender snapshot or the cached
self profile rather than waiting for optional remote profile requests. The durable
message/update publication and `updateMessageID` correlation remain in place.
Local upstream deletions now publish through the durable update pipeline, so
other Telegram sessions receive deletion updates before the upstream echo is
ignored as a duplicate. PTS is reserved once, not again by the RPC response.
Redacted timeline tombstones also invalidate previously cached messages; redacted
encrypted messages must not render as unsupported-encryption placeholders.

Media downloads use authenticated `/_matrix/client/v1/media/download` first;
only `M_UNRECOGNIZED` falls back to the legacy media endpoint. Permission failures
and missing media do not trigger a downgrade.

Regression coverage: unit tests for normalization, thread fallbacks, tombstones,
media authorization/fallback and cached-profile confirmation; HTTP/SQLite/TL E2E
for out-of-page reply targets, outgoing reply relations, random-ID confirmation,
observer deletion updates, duplicate echoes/retries and failed upstream deletion.
These fixtures do not establish real Telegram GUI rendering or production latency.

### Retried sends

The bridge forwards the MTProto `random_id` (or ordered album ID vector) as an
opaque idempotency key. Matrix derives a stable transaction ID per account,
room and content-part index instead of generating a new UUID on every attempt.
A lost HTTP response or a failure while publishing the local confirmation can
therefore be retried after reconnect/restart without creating another Matrix
event. This uses the homeserver's [transaction identifier semantics](https://spec.matrix.org/v1.19/client-server-api/#transaction-identifiers),
not message-text matching. Intentional identical messages with different random
IDs are still distinct. Calls without an idempotency key keep fresh transaction
IDs. Native stickers, uploaded stickers, files and multipart messages use the
same per-part scheme. Uploads themselves can be repeated after failure; this
protects message events, not media-storage deduplication. It does not retroactively
remove messages sent twice before the fix, and depends on the homeserver retaining
its transaction records.

`send-dedup.e2e.test.ts` uses a real HTTP fixture which commits then drops a
response, reconstructs adapter/RPC instances, injects post-send publication
failure, and runs concurrent retries through SQLite and TL reply serialization.
It checks one upstream event, stable client message IDs, and separate intentional
sends. Unit tests additionally cover partial multipart failure and all media paths.
