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
