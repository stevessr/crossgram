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
