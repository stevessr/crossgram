import type { Context } from 'cordis'
import type { tl } from '@mtcute/core'
import Long from 'long'
import {
  projectDetachedMessage,
  messagePartText,
  stableId,
  type BridgeSessionState,
  type IMMedia,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type MessageProjectionInput,
  type MessageProjectionResult,
} from '@mtproto-relay/bridge'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'

export const name = 'merged-forward-viewer'
export const inject = ['mtproto', 'mtprotoBridge']

interface BundleRecord {
  platformSessionId: string
  chatId: number
  bundle: IMMessageBundle
  /** Durable address encoded in `chatId`; absent for process-local transcripts. */
  address?: BundleAddress
  snapshots?: Promise<IMMessageSnapshot[]>
  /** Adapter-owned avatar of the chat the bundle was archived from. */
  avatar?: Promise<IMMedia<any> | undefined>
  projection?: Promise<ProjectedBundle>
}

/** One synthetic peer photo, addressable by Telegram file locations. */
interface AvatarEntry {
  media: IMMedia<any>
  peer: AvatarPeer
}

interface AvatarPeer { kind: 'user' | 'chat', id: number }

/**
 * Photos of one platform session.  Peer locations are keyed by peer and photo,
 * because unrelated transcripts can share one avatar; photo locations carry no
 * peer, so the first registration of an image answers them.
 */
interface SessionAvatars {
  peers: Map<string, AvatarEntry>
  photos: Map<string, AvatarEntry>
}

interface ProjectedBundle {
  messages: tl.TypeMessage[]
  chats: tl.TypeChat[]
  users: tl.TypeUser[]
}

/**
 * Where a bundle lives: the durable message row that carries it and the path
 * of bundle ordinals leading to it.  `path[0]` counts the bundle parts of the
 * stored message; every further step counts the bundle parts of the parent
 * transcript's archived messages, in the order the adapter returns them.
 */
export interface BundleAddress {
  storedMessageId: number
  path: number[]
}

/**
 * Transcript chat ids start above every id the bridge allocates for ordinary
 * peers and above the process-local fallback (`stableId` stays below 2^31), so
 * an encoded bundle can never be mistaken for any other peer.
 *
 * The base also carries the address scheme's version.  Transcript message ids
 * follow the transcript order now, and clients keep the messages they fetched
 * under the previous hash ids in their own storage, where they would show up
 * next to the new pages.  The previous scheme counted from `2^31` and its
 * largest id was `2^31` plus the largest message row at the time (a few
 * billion for production's ~1.4M rows); it never reaches this base, so every
 * id it handed out decodes to nothing and the client builds one fresh
 * transcript view instead of two interleaved ones.
 */
const BUNDLE_CHAT_ID_BASE = 2 ** 32
/** Low part of a transcript chat id that carries the encoded bundle path. */
const BUNDLE_PATH_CODES = 1024
/**
 * Largest basic-group id every client accepts.  TDLib-based clients reject
 * basic chat ids above 999999999999, the tightest bound among the clients
 * Crossgram serves; this still leaves room for ~970 million stored messages.
 */
const MAX_BUNDLE_CHAT_ID = 999_999_999_999

/**
 * Transcript chat id that encodes its bundle address, so a relay restart can
 * find the bundle again from nothing but the id a client already holds.
 * Returns `undefined` when the address does not fit; such bundles fall back to
 * the process-local id.
 */
export function encodeBundleChatId(address: BundleAddress): number | undefined {
  const { storedMessageId, path } = address
  if (!Number.isSafeInteger(storedMessageId) || storedMessageId <= 0) return
  const code = encodeBundlePath(path)
  if (code === undefined || code >= BUNDLE_PATH_CODES) return
  const id = BUNDLE_CHAT_ID_BASE + storedMessageId * BUNDLE_PATH_CODES + code
  return Number.isSafeInteger(id) && id <= MAX_BUNDLE_CHAT_ID ? id : undefined
}

/** Inverse of `encodeBundleChatId`; `undefined` for every other chat id. */
export function decodeBundleChatId(chatId: number): BundleAddress | undefined {
  if (!Number.isSafeInteger(chatId) || chatId > MAX_BUNDLE_CHAT_ID) return
  const relative = chatId - BUNDLE_CHAT_ID_BASE
  const storedMessageId = Math.floor(relative / BUNDLE_PATH_CODES)
  if (storedMessageId <= 0) return
  const path = decodeBundlePath(relative % BUNDLE_PATH_CODES)
  return path ? { storedMessageId, path } : undefined
}

/**
 * Packs a bundle path into a small integer: every ordinal is written as an
 * Elias-gamma code of `ordinal + 1` behind a leading sentinel bit, and the
 * result is shifted so the first bundle of a message, by far the common case,
 * encodes as 0.  Nested bundles several levels deep still fit in ten bits.
 */
function encodeBundlePath(path: readonly number[]): number | undefined {
  if (!path.length || path.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0)) return
  let bits = '1'
  for (const ordinal of path) {
    const binary = (ordinal + 1).toString(2)
    bits += '0'.repeat(binary.length - 1) + binary
    if (bits.length > 16) return
  }
  return parseInt(bits, 2) - 3
}

function decodeBundlePath(code: number): number[] | undefined {
  const bits = (code + 3).toString(2).slice(1)
  const path: number[] = []
  let cursor = 0
  while (cursor < bits.length) {
    let zeros = 0
    while (cursor + zeros < bits.length && bits[cursor + zeros] === '0') zeros++
    const end = cursor + zeros * 2 + 1
    if (end > bits.length) return
    path.push(parseInt(bits.slice(cursor + zeros, end), 2) - 1)
    cursor = end
  }
  return path.length && encodeBundlePath(path) === code ? path : undefined
}

/** Bundle parts of one message, in content order. */
function bundleParts(parts: readonly { type: string }[]): IMMessageBundle[] {
  return parts.flatMap((part) => part.type === 'message-bundle'
    ? [(part as { type: 'message-bundle', bundle: IMMessageBundle }).bundle]
    : [])
}

/**
 * Nested bundles of a transcript: the bundle parts of every archived message,
 * in archive order.  Their positions are the ordinals of nested bundle paths.
 */
function nestedBundles(snapshots: readonly IMMessageSnapshot[]): IMMessageBundle[] {
  return snapshots.flatMap((snapshot) => bundleParts(snapshot.content.parts))
}

/** Session capabilities a transcript needs to rebuild itself after a restart. */
export type BundleSessionState = Pick<BridgeSessionState, 'platform' | 'session'> & {
  dialogs?: Partial<Pick<BridgeSessionState['dialogs'], 'readStoredMessage'>>
}

/** Addressed transcripts kept warm per session; any evicted one can be rebuilt. */
const MAX_CACHED_RECORDS = 256
/** Nested bundle addresses remembered per session while parents render. */
const MAX_NESTED_ADDRESSES = 4096

/**
 * Feature-owned view of the bundles clients may open.  A transcript of a
 * stored message is addressed by its row and bundle path, both encoded in the
 * transcript chat id, so this registry is only a cache: every link a client
 * holds can be rebuilt from MessageStore after a restart.  Bundles without a
 * durable address (unstored sources, paths too long to encode) keep a
 * process-local id and live only as long as the registry.
 *
 * Inside a transcript, message ids are allocated in the transcript's
 * chronological order (`transcriptMessageId`), because clients page history with
 * those ids as cursors and order same-timestamp messages by them.
 */
export class MergedForwardProjection {
  private readonly _records = new Map<string, Map<number, BundleRecord>>()
  /** Addresses of nested bundles, keyed by bundle id, learnt while their parent renders. */
  private readonly _nestedAddresses = new Map<string, Map<string, BundleAddress>>()
  private readonly _rebuilds = new Map<string, Promise<BundleRecord | undefined>>()
  /** Synthetic peer photos this feature registered, scoped per session. */
  private readonly _avatars = new Map<string, SessionAvatars>()
  /** Every photo id this feature handed out, checked before resolving a session. */
  private readonly _photoIds = new Set<string>()

  constructor(private readonly _dcId = 1) {}

  /**
   * One sender of a bundle rendered as a temporary Telegram user.  The avatar
   * comes from the archived record: a transcript can only show what QQ kept
   * for the forwarded message, and archives without sender identity stay on
   * the empty photo so clients draw their own initial placeholder.
   */
  makeBundleUser(state: BridgeSessionState, snapshot: IMMessageSnapshot): tl.RawUser {
    const id = bundleUserId(state, snapshot.senderId)
    const source = snapshot.sender
    return {
      _: 'user', id, accessHash: Long.fromNumber(id),
      firstName: source?.firstName || snapshot.senderId,
      lastName: source?.lastName,
      username: source?.username,
      photo: source?.avatar
        ? this.registerAvatar(
            state.session.platformSessionId, { kind: 'user', id }, source.avatar,
          ).photo
        : { _: 'userProfilePhotoEmpty' },
    }
  }

  remember(platformSessionId: string, bundle: IMMessageBundle, address?: BundleAddress): BundleRecord {
    const encoded = address ? encodeBundleChatId(address) : undefined
    const chatId = encoded ?? bundleChatId(bundle)
    const records = this._records.get(platformSessionId) ?? new Map<number, BundleRecord>()
    const existing = records.get(chatId)
    if (existing?.bundle.id === bundle.id) {
      existing.bundle = bundle
      // Recently used transcripts stay at the end of the eviction order.
      records.delete(chatId)
      records.set(chatId, existing)
      return existing
    }
    const record: BundleRecord = {
      platformSessionId, chatId, bundle,
      ...(encoded !== undefined ? { address: { storedMessageId: address!.storedMessageId, path: [...address!.path] } } : {}),
    }
    records.set(chatId, record)
    this._records.set(platformSessionId, records)
    this.evict(records)
    return record
  }

  /**
   * Keeps the registry bounded.  Only addressed transcripts are dropped: the
   * id a client holds rebuilds them from MessageStore, whereas a process-local
   * transcript would become unreachable.
   */
  private evict(records: Map<number, BundleRecord>): void {
    let addressed = 0
    for (const record of records.values()) if (record.address) addressed++
    for (const [chatId, record] of records) {
      if (addressed <= MAX_CACHED_RECORDS) break
      if (!record.address) continue
      records.delete(chatId)
      addressed--
    }
  }

  resolve(platformSessionId: string, chatId: number): BundleRecord | undefined {
    return this._records.get(platformSessionId)?.get(chatId)
  }

  /**
   * Transcript of one chat id: the cached record, or the bundle rebuilt from
   * the stored message the id encodes.  This is what keeps links working
   * across relay restarts.
   */
  async lookup(state: BundleSessionState, chatId: number): Promise<BundleRecord | undefined> {
    const platformSessionId = state.session.platformSessionId
    const cached = this.resolve(platformSessionId, chatId)
    if (cached) return cached
    const address = decodeBundleChatId(chatId)
    if (!address || !state.dialogs?.readStoredMessage) return
    const key = `${platformSessionId}\u0000${chatId}`
    const running = this._rebuilds.get(key)
    if (running) return running
    const pending = this.rebuild(state, address)
      .catch(() => undefined)
      .finally(() => {
        if (this._rebuilds.get(key) === pending) this._rebuilds.delete(key)
      })
    this._rebuilds.set(key, pending)
    return pending
  }

  /**
   * Walks a bundle address from its stored message down to the bundle it
   * names.  Nested steps load the parent transcript through the adapter, the
   * same way opening the parent would.
   */
  private async rebuild(state: BundleSessionState, address: BundleAddress): Promise<BundleRecord | undefined> {
    const source = await state.dialogs!.readStoredMessage!(address.storedMessageId)
    if (!source) return
    let bundle = bundleParts(source.content.parts)[address.path[0]!]
    for (let depth = 1; bundle && depth < address.path.length; depth++) {
      const parent = this.remember(state.session.platformSessionId, bundle, {
        storedMessageId: address.storedMessageId, path: address.path.slice(0, depth),
      })
      bundle = nestedBundles(await this.loadSnapshots(state, parent))[address.path[depth]!]
    }
    if (!bundle) return
    return this.remember(state.session.platformSessionId, bundle, address)
  }

  records(platformSessionId: string): Iterable<BundleRecord> {
    return this._records.get(platformSessionId)?.values() ?? []
  }

  async resolveUsername(state: BundleSessionState, username: string): Promise<BundleRecord | undefined> {
    const match = /^bridge(?:bundle|chat)_(\d+)$/i.exec(username)
    return match ? this.lookup(state, Number(match[1])) : undefined
  }

  /**
   * Durable address of a bundle part being projected.  Parts of a stored
   * message are addressed by that row; bundles nested in a transcript inherit
   * the address their parent registered while it rendered.
   */
  private addressOf(input: MessageProjectionInput, bundle: IMMessageBundle, ordinal: number): BundleAddress | undefined {
    if (input.mode !== 'bundle') {
      return input.storedMessageId ? { storedMessageId: input.storedMessageId, path: [ordinal] } : undefined
    }
    return this._nestedAddresses.get(input.session.platformSessionId)?.get(bundle.id)
  }

  /** Remembers where the bundles nested in a transcript live, before it renders them. */
  private registerNested(record: BundleRecord, snapshots: readonly IMMessageSnapshot[]): void {
    if (!record.address) return
    const nested = nestedBundles(snapshots)
    if (!nested.length) return
    let addresses = this._nestedAddresses.get(record.platformSessionId)
    if (!addresses) {
      addresses = new Map()
      this._nestedAddresses.set(record.platformSessionId, addresses)
    }
    for (const [index, bundle] of nested.entries()) {
      addresses.delete(bundle.id)
      addresses.set(bundle.id, {
        storedMessageId: record.address.storedMessageId, path: [...record.address.path, index],
      })
    }
    while (addresses.size > MAX_NESTED_ADDRESSES) addresses.delete(addresses.keys().next().value!)
  }

  async project(
    input: MessageProjectionInput,
    next: () => MessageProjectionResult | Promise<MessageProjectionResult>,
  ): Promise<MessageProjectionResult> {
    if (input.ordinal !== 0) return next()
    const bundles = input.draft.source.content.parts
      .filter((part): part is Extract<typeof part, { type: 'message-bundle' }> => part.type === 'message-bundle')
    if (!bundles.length) return next()

    const links = new Map<string, string>()
    const targets = new Map<string, number>()
    const records = new Map<string, BundleRecord>()
    for (const [ordinal, part] of bundles.entries()) {
      const record = this.remember(
        input.session.platformSessionId, part.bundle, this.addressOf(input, part.bundle, ordinal),
      )
      records.set(part.bundle.id, record)
      const snapshots = await this.loadSnapshots(input, record)
      if (!record.bundle.preview?.trim()) {
        const preview = snapshotPreview(snapshots)
        if (preview) record.bundle = { ...record.bundle, preview }
      }
      const first = firstSnapshot(snapshots)
      // The link anchors at the transcript's first message, so clients open the
      // archive at its beginning instead of its newest record.
      const target = first ? transcriptMessageId(0, 0) : undefined
      if (target) targets.set(part.bundle.id, target)
      links.set(part.bundle.id, this.makeLink(
        record,
        target,
      ))
      input.draft.chats.push(this.makeChat(record, snapshots, await this.loadAvatar(input, record)))
    }

    const source = input.draft.source
    input.draft.source = {
      ...source,
      content: {
        ...source.content,
        parts: source.content.parts.map((part) => {
          if (part.type !== 'message-bundle') return part
          const text = '查看聊天记录'
          return {
            type: 'text' as const,
            text,
            entities: [{
              type: 'text-link' as const,
              offset: 0,
              length: text.length,
              url: links.get(part.bundle.id)!,
            }],
          }
        }),
      },
    }
    if (!source.content.parts.some((part) =>
      part.type === 'media' || part.type === 'sticker' || part.type === 'card')) {
      const record = records.get(bundles[0].bundle.id)
      if (record) {
        input.draft.media = this.makePreview(record, targets.get(bundles[0].bundle.id))
      }
    }
    return next()
  }

  makeLink(record: BundleRecord, messageId?: number): string {
    return `https://t.me/bridgebundle_${record.chatId}${messageId ? `/${messageId}` : ''}`
  }

  makeChat(
    record: BundleRecord,
    snapshots: readonly IMMessageSnapshot[] = [],
    avatar?: IMMedia<any>,
  ): tl.RawChat {
    return {
      _: 'chat', left: true, id: record.chatId, title: record.bundle.title,
      photo: avatar
        ? this.registerAvatar(record.platformSessionId, { kind: 'chat', id: record.chatId }, avatar).photo
        : { _: 'chatPhotoEmpty' },
      participantsCount: Math.max(1, new Set(snapshots.map((item) => item.senderId)).size),
      date: 0, version: 1,
    }
  }

  /**
   * Card of the merged forward.  It deliberately carries no photo: Telegram
   * Android renders the photo of a `telegram_message` web page as a full-width
   * banner above the title, so the archived chat avatar used to turn the card
   * into a group portrait that occupied most of the bubble and that Telegram
   * Desktop never showed at that size.  The transcript still carries that
   * avatar on its own chat entity, where clients draw it as a peer photo.
   */
  makePreview(
    record: BundleRecord,
    messageId?: number,
  ): tl.RawMessageMediaWebPage {
    const url = this.makeLink(record, messageId)
    return {
      _: 'messageMediaWebPage', manual: true, safe: true,
      webpage: {
        _: 'webPage',
        id: Long.fromNumber(stableId(`merged-forward-preview:${record.bundle.id}`)),
        url, displayUrl: record.bundle.title, hash: 0,
        type: 'telegram_message', title: record.bundle.title,
        // Without archived content the card shows only its title: never a
        // placeholder sentence that pretends to be a preview.
        description: record.bundle.preview?.trim() || undefined,
      },
    }
  }

  makeFullChat(
    record: BundleRecord,
    snapshots: readonly IMMessageSnapshot[],
    avatar?: IMMedia<any>,
  ): tl.messages.RawChatFull {
    const chat = this.makeChat(record, snapshots, avatar)
    return {
      _: 'messages.chatFull',
      fullChat: {
        _: 'chatFull', id: record.chatId, about: '',
        participants: { _: 'chatParticipantsForbidden', chatId: record.chatId },
        // Clients read the profile photo of a basic chat from the full chat
        // as well, so the transcript header must not fall back to an empty
        // photo that the chat entity already knows better.
        chatPhoto: avatar
          ? this.makeBundlePhoto(record.platformSessionId, record.chatId, avatar)
          : { _: 'photoEmpty', id: Long.ZERO },
        notifySettings: { _: 'peerNotifySettings' }, botInfo: [],
      },
      chats: [chat], users: [],
    }
  }

  /**
   * Resolves the peer photo of the chat a bundle was archived from.  The
   * platform supplies it through the optional bundle-avatar hook; archives
   * without one keep the empty photo.
   */
  loadAvatar(input: Pick<MessageProjectionInput, 'platform' | 'session'>, record: BundleRecord) {
    if (record.avatar) return record.avatar
    const pending: Promise<IMMedia<any> | undefined> = readBundleAvatar(input, record)
    record.avatar = pending
    pending.catch(() => {
      // An unavailable adapter must not turn into a cached "no avatar": keep
      // the transcript renderable and retry with the next request.
      if (record.avatar === pending) record.avatar = undefined
    })
    return pending.catch(() => undefined)
  }

  /**
   * Telegram photo that addresses the same bytes as a registered peer photo.
   * Webpage thumbnails and full-chat profiles are fetched through
   * `inputPhotoFileLocation`, so both views share this identity.
   */
  private makeBundlePhoto(
    platformSessionId: string,
    chatId: number,
    media: IMMedia<any>,
  ): tl.RawPhoto {
    const { photoId } = this.registerAvatar(platformSessionId, { kind: 'chat', id: chatId }, media)
    const width = media.width ?? BUNDLE_PHOTO_SIZE
    const height = media.height ?? BUNDLE_PHOTO_SIZE
    return {
      _: 'photo',
      id: photoId,
      accessHash: Long.fromNumber(stableId(`merged-forward-photo:${media.id}`)),
      fileReference: BUNDLE_PHOTO_FILE_REFERENCE,
      date: 0,
      sizes: [
        { _: 'photoSize', type: 'm', w: width, h: height, size: 0 },
        { _: 'photoSize', type: 'x', w: width, h: height, size: media.size ?? 0 },
      ],
      dcId: this._dcId,
    }
  }

  private registerAvatar(
    platformSessionId: string,
    peer: { kind: 'user', id: number },
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawUserProfilePhoto }
  private registerAvatar(
    platformSessionId: string,
    peer: { kind: 'chat', id: number },
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawChatPhoto }
  private registerAvatar(
    platformSessionId: string,
    peer: AvatarPeer,
    media: IMMedia<any>,
  ): { photoId: Long, photo: tl.RawUserProfilePhoto | tl.RawChatPhoto } {
    const photoId = Long.fromNumber(stableId(`avatar:${media.id}`))
    const session = this.avatarSession(platformSessionId)
    const entry: AvatarEntry = { media, peer }
    this._photoIds.add(photoId.toString())
    session.peers.set(peerKey(peer, photoId), entry)
    // Several transcripts may render the same archived image, so the first
    // registration keeps the photo location stable.
    const photoKey = photoId.toString()
    if (!session.photos.has(photoKey)) session.photos.set(photoKey, entry)
    return {
      photoId,
      photo: peer.kind === 'user'
        ? { _: 'userProfilePhoto', photoId, dcId: this._dcId }
        : { _: 'chatPhoto', photoId, dcId: this._dcId },
    }
  }

  private avatarSession(platformSessionId: string): SessionAvatars {
    let session = this._avatars.get(platformSessionId)
    if (!session) {
      session = { peers: new Map(), photos: new Map() }
      this._avatars.set(platformSessionId, session)
    }
    return session
  }

  /**
   * Cheap test for a file location this feature could own.  It runs before the
   * RPC resolves a platform session, so ordinary media downloads never pay for
   * the merged-forward lookup.
   */
  mightServeLocation(location: tl.TypeInputFileLocation): boolean {
    // A durable transcript can serve its photo even before it was rebuilt.
    if (transcriptPhotoChatId(location) !== undefined) return true
    if (!this._photoIds.size) return false
    if (location._ === 'inputPeerPhotoFileLocation') {
      return this._photoIds.has(location.photoId.toString())
    }
    if (location._ === 'inputPhotoFileLocation') {
      return sameBytes(location.fileReference, BUNDLE_PHOTO_FILE_REFERENCE)
        && this._photoIds.has(location.id.toString())
    }
    return false
  }

  /**
   * Resolves one Telegram file location against the photos this feature
   * handed out.  Requests that do not belong to a synthetic bundle peer stay
   * unanswered so the ordinary bridge file routes keep serving them.
   */
  resolveAvatarLocation(platformSessionId: string, location: tl.TypeInputFileLocation): AvatarEntry | undefined {
    const session = this._avatars.get(platformSessionId)
    if (!session) return
    if (location._ === 'inputPeerPhotoFileLocation') {
      const peer = inputPeerKey(location.peer)
      return peer ? session.peers.get(`${peer}:${location.photoId}`) : undefined
    }
    if (location._ === 'inputPhotoFileLocation') {
      if (!sameBytes(location.fileReference, BUNDLE_PHOTO_FILE_REFERENCE)) return
      return session.photos.get(location.id.toString())
    }
  }

  loadSnapshots(input: Pick<MessageProjectionInput, 'platform' | 'session'>, record: BundleRecord) {
    if (record.snapshots) return record.snapshots
    const provider = input.platform.messageBundles
    record.snapshots = provider
      ? provider.load(input.session, record.bundle.locator)
      : Promise.resolve([])
    record.snapshots.catch(() => {
      record.snapshots = undefined
    })
    return record.snapshots
  }

  materialize(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    if (record.projection) return record.projection
    record.projection = this.buildProjection(state, record)
    record.projection.catch(() => {
      record.projection = undefined
    })
    return record.projection
  }

  clear(): void {
    this._records.clear()
    this._nestedAddresses.clear()
    this._rebuilds.clear()
    this._avatars.clear()
    this._photoIds.clear()
  }

  private async buildProjection(state: BridgeSessionState, record: BundleRecord): Promise<ProjectedBundle> {
    const snapshots = await this.loadSnapshots(state, record)
    // Nested bundles render through the projection waterfall below; they can
    // only link to durable transcripts once their address is known.
    this.registerNested(record, snapshots)
    const peer = { _: 'peerChat' as const, chatId: record.chatId }
    const ranks = transcriptRanks(snapshots)
    const replyIds = new Map(snapshots.map((snapshot) => [
      snapshot.id,
      transcriptMessageId(ranks.get(snapshot.id) ?? 0, 0),
    ]))
    const messages: tl.TypeMessage[] = []
    const chats: tl.TypeChat[] = [this.makeChat(record, snapshots, await this.loadAvatar(state, record))]
    const users = new Map<number, tl.TypeUser>()

    for (const snapshot of snapshots) {
      users.set(bundleUserId(state, snapshot.senderId), this.makeBundleUser(state, snapshot))
      const rendered = await projectDetachedMessage({
        pipeline: state.projection,
        platform: state.platform,
        session: state.session,
        stickers: state.stickers,
        source: snapshot,
        target: { peer, title: record.bundle.title },
        messageId: (ordinal) => transcriptMessageId(ranks.get(snapshot.id) ?? 0, ordinal),
        mediaId: (partIndex) => stableId(
          `merged-forward-media:${record.bundle.id}:${snapshot.id}:${partIndex}`,
        ),
        userId: (id) => bundleUserId(state, id),
        replyToMessageId: snapshot.replyToId ? replyIds.get(snapshot.replyToId) : undefined,
        groupedId: String(stableId(
          `merged-forward-group:${record.bundle.id}:${snapshot.groupId ?? snapshot.id}`,
        )),
      })
      messages.push(...rendered.messages)
      chats.push(...rendered.chats)
    }
    // Transcripts read newest first.  Messages that share one timestamp — QQ
    // only records whole seconds — fall back to the id, which is allocated in
    // archive order, so the tiebreak shows the later message above the earlier
    // one, exactly like the archive itself.
    messages.sort((left, right) => messageDate(right) - messageDate(left) || right.id - left.id)
    return {
      messages,
      chats: uniqueById(chats),
      users: [...users.values()],
    }
  }
}

export function makeMergedForwardProvider(dcId = 1): MergedForwardProjection {
  return new MergedForwardProjection(dcId)
}

export function apply(ctx: Context): void {
  const projection = new MergedForwardProjection(ctx.mtprotoBridge.dcId)
  ctx.on('bridge/message/project', (input, next) => projection.project(input, next))
  ctx.on('mtproto/rpc', async function (
    this: ServerRpcContext,
    request: tl.RpcMethod,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const result = await routeMergedForwardRpc(ctx, projection, this, request)
    if (result === undefined) return next()
    return result
  } as never, { prepend: true })
  ctx.effect(() => () => projection.clear(), 'mergedForward.clear')
}

async function routeMergedForwardRpc(
  ctx: Context,
  projection: MergedForwardProjection,
  rpc: ServerRpcContext,
  request: tl.RpcMethod,
): Promise<unknown | undefined> {
  const resolveState = () => ctx.mtprotoBridge.resolveSession(rpc)
  if (request._ === 'upload.getFile') {
    const req = request as tl.upload.RawGetFileRequest
    if (!projection.mightServeLocation(req.location)) return
    const offset = Number(req.offset)
    if (!Number.isFinite(offset) || offset < 0 || req.limit <= 0) return
    const state = await resolveState()
    let entry = projection.resolveAvatarLocation(state.session.platformSessionId, req.location)
    if (!entry) {
      // A client may fetch the photo of a transcript it cached before a
      // restart; rebuild that transcript so its avatar is registered again.
      const chatId = transcriptPhotoChatId(req.location)
      const record = chatId === undefined ? undefined : await projection.lookup(state, chatId)
      if (record) {
        projection.makeChat(record, [], await projection.loadAvatar(state, record))
        entry = projection.resolveAvatarLocation(state.session.platformSessionId, req.location)
      }
    }
    if (!entry || !state.platform.downloadMedia) return
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of state.platform.downloadMedia(state.session, entry.media, {
      offset, limit: req.limit,
    })) {
      const remaining = req.limit - size
      if (remaining <= 0) break
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(accepted)
      size += accepted.length
    }
    const bytes = new Uint8Array(size)
    let cursor = 0
    for (const chunk of chunks) {
      bytes.set(chunk, cursor)
      cursor += chunk.length
    }
    return {
      _: 'upload.file',
      type: offset === 0 ? avatarStorageFileType(bytes) : { _: 'storage.fileUnknown' as const },
      mtime: Math.floor(Date.now() / 1000),
      bytes,
    }
  }
  if (request._ === 'contacts.resolveUsername') {
    const req = request as tl.contacts.RawResolveUsernameRequest
    if (!/^bridge(?:bundle|chat)_\d+$/i.test(req.username)) return
    const state = await resolveState()
    const record = await projection.resolveUsername(state, req.username)
    if (!record) return
    const snapshots = await projection.loadSnapshots(state, record)
    return {
      _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: record.chatId },
      chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
      users: [],
    }
  }
  if (request._ === 'messages.getFullChat') {
    const req = request as tl.messages.RawGetFullChatRequest
    const state = await resolveState()
    const record = await projection.lookup(state, req.chatId)
    if (!record) return
    return projection.makeFullChat(
      record,
      await projection.loadSnapshots(state, record),
      await projection.loadAvatar(state, record),
    )
  }
  if (
    request._ === 'messages.getHistory'
    || request._ === 'messages.readHistory'
    || request._ === 'messages.getScheduledHistory'
    || request._ === 'messages.getPeerSettings'
  ) {
    const req = request as tl.messages.RawGetHistoryRequest
      | tl.messages.RawReadHistoryRequest
      | tl.messages.RawGetScheduledHistoryRequest
      | tl.messages.RawGetPeerSettingsRequest
    if (req.peer._ !== 'inputPeerChat') return
    const state = await resolveState()
    const record = await projection.lookup(state, req.peer.chatId)
    if (!record) return
    if (request._ === 'messages.readHistory') {
      return { _: 'messages.affectedMessages', pts: 0, ptsCount: 0 }
    }
    if (request._ === 'messages.getScheduledHistory') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.messages', messages: [], topics: [],
        chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
        users: [],
      }
    }
    if (request._ === 'messages.getPeerSettings') {
      const snapshots = await projection.loadSnapshots(state, record)
      return {
        _: 'messages.peerSettings', settings: { _: 'peerSettings' },
        chats: [projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))],
        users: [],
      }
    }
    const bundle = await projection.materialize(state, record)
    const history = request as tl.messages.RawGetHistoryRequest
    // A client that still carries a deep link generated before the relay
    // anchored links at the first message has no way to learn the transcript
    // order from the link, so it asks for the beginning explicitly.  Transcript
    // message ids start at `TRANSCRIPT_MESSAGE_ID_BASE`, so the sentinel cannot
    // collide with a real message of the bundle.
    const page = history.offsetId === kFirstMessageOffsetId
      ? firstPage(selectWithinBounds(bundle.messages, history), history.limit)
      : selectHistory(bundle.messages, history)
    return {
      _: 'messages.messagesSlice', count: bundle.messages.length,
      messages: page, topics: [], chats: bundle.chats, users: bundle.users,
    }
  }
  if (request._ === 'messages.getPeerDialogs') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetPeerDialogsRequest
    const records = (await Promise.all(req.peers.map(async (item, index) => {
      if (item._ !== 'inputDialogPeer' || item.peer._ !== 'inputPeerChat') return undefined
      const record = await projection.lookup(state, item.peer.chatId)
      return record ? { index, record } : undefined
    }))).filter((entry): entry is { index: number, record: BundleRecord } => entry !== undefined)
    if (!records.length) return
    const virtualIndexes = new Set(records.map((entry) => entry.index))
    const ordinaryPeers = req.peers.filter((_item, index) => !virtualIndexes.has(index))
    const projectedChats = await Promise.all(records.map(async ({ record }) => {
      const snapshots = await projection.loadSnapshots(state, record)
      return projection.makeChat(record, snapshots, await projection.loadAvatar(state, record))
    }))
    const ordinary = ordinaryPeers.length
      ? await state.dialogs.getPeerDialogs({ ...req, peers: ordinaryPeers })
      : undefined
    const virtualByIndex = new Map(records.map((entry) => [entry.index, entry.record]))
    // A transcript is a history-only view that must not turn into a chat-list
    // entry, so its dialog is published with `topMessage = 0`: clients apply
    // the entry, load history from the message they were asked to open, and
    // skip persisting a dialog whose top message is empty.  Android otherwise
    // takes the dialog prefetch at the start of every anchored history load,
    // finds no dialog for the peer and stops without ever asking for history,
    // which left the transcript on skeleton placeholders.
    let ordinaryCursor = 0
    const dialogs: tl.TypeDialog[] = []
    for (let index = 0; index < req.peers.length; index++) {
      const record = virtualByIndex.get(index)
      if (record) {
        dialogs.push(transcriptDialog(record.chatId))
        continue
      }
      if (req.peers[index]?._ !== 'inputDialogPeer') continue
      const next = ordinary?.dialogs[ordinaryCursor++]
      if (next) dialogs.push(next)
    }
    return {
      _: 'messages.peerDialogs',
      dialogs,
      messages: ordinary?.messages ?? [],
      chats: uniqueById([...(ordinary?.chats ?? []), ...projectedChats]),
      users: ordinary?.users ?? [],
      state: ordinary?.state ?? { _: 'updates.state', pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 },
    }
  }
  if (request._ === 'messages.getMessages') {
    const state = await resolveState()
    const req = request as tl.messages.RawGetMessagesRequest
    const bundles = await Promise.all(
      [...projection.records(state.session.platformSessionId)]
        .map((record) => projection.materialize(state, record)),
    )
    const virtualById = new Map(bundles.flatMap((bundle) => bundle.messages.map((message) => [message.id, message])))
    const requestedIds = req.id.map(inputMessageId)
    const ordinaryInputs = req.id.filter((input) => !virtualById.has(inputMessageId(input)))
    if (ordinaryInputs.length === req.id.length) return
    const ordinary = ordinaryInputs.length
      ? await state.dialogs.getMessages({ ...req, id: ordinaryInputs })
      : undefined
    const ordinaryMessages = ordinary && ordinary._ !== 'messages.messagesNotModified'
      ? ordinary.messages
      : []
    const byId = new Map([...ordinaryMessages, ...virtualById.values()].map((message) => [message.id, message]))
    return {
      _: 'messages.messages',
      messages: requestedIds.map((id) => byId.get(id) ?? { _: 'messageEmpty', id }),
      topics: [],
      chats: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.chats : []),
        ...bundles.flatMap((bundle) => bundle.chats),
      ]),
      users: uniqueById([
        ...(ordinary && ordinary._ !== 'messages.messagesNotModified' ? ordinary.users : []),
        ...bundles.flatMap((bundle) => bundle.users),
      ]),
    }
  }
}

/**
 * Dialog entry a transcript chat may publish.
 *
 * It carries no top message on purpose: clients need the entry to reach the
 * anchored history request, and their own code skips persisting a dialog
 * whose top message is empty, so the transcript never becomes a chat-list
 * entry.  Notification settings are the neutral defaults for a peer the
 * viewer does not own.
 */
function transcriptDialog(chatId: number): tl.RawDialog {
  return {
    _: 'dialog',
    peer: { _: 'peerChat', chatId },
    topMessage: 0,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    unreadCount: 0,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    notifySettings: { _: 'peerNotifySettings' },
  }
}

/**
 * Picks the message a merged-forward deep link anchors to.
 *
 * Native Telegram forwards link to the first message of the transcript, so
 * opening the link shows the bundle from its beginning.
 */
function firstSnapshot(
  snapshots: readonly IMMessageSnapshot[],
): IMMessageSnapshot | undefined {
  return chronologicalSnapshots(snapshots)[0]
}

/**
 * Content preview of a bundle, one line per archived message, for platforms
 * that supply none.  Mirrors the layout native merged forwards show on their
 * card: the first few messages as `sender: text`.
 */
export function snapshotPreview(snapshots: readonly IMMessageSnapshot[]): string | undefined {
  const lines = [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(0, 4)
    .map((snapshot) => {
      const sender = [snapshot.sender?.firstName, snapshot.sender?.lastName]
        .filter(Boolean).join(' ').trim() || snapshot.senderId
      const content = snapshot.content.parts.map((part) => {
        if (part.type === 'text') return part.text.trim()
        if (part.type === 'media') {
          return part.media.kind === 'image' ? '[图片]' : part.media.name?.trim() || '[文件]'
        }
        if (part.type === 'sticker') return '[表情]'
        if (part.type === 'card') return part.card.title?.trim() || '[卡片消息]'
        if (part.type === 'poll') return messagePartText(part)
        return `[${part.bundle.title || '聊天记录'}]`
      }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      return content ? `${sender}: ${content}` : ''
    })
    .filter(Boolean)
  return lines.join('\n') || undefined
}

/** Reads the optional avatar of the chat a bundle was archived from. */
async function readBundleAvatar(
  input: Pick<MessageProjectionInput, 'platform' | 'session'>,
  record: BundleRecord,
): Promise<IMMedia<any> | undefined> {
  return await input.platform.messageBundles?.avatar?.(input.session, record.bundle.locator)
}

function bundleChatId(bundle: IMMessageBundle): number {
  return stableId(`merged-forward-chat:${bundle.id}`)
}

/**
 * First id a transcript hands to a message.  Telegram clients use offset id 1
 * as the "beginning of the history" sentinel, so transcript ids start above
 * it and can never be mistaken for it.
 */
const TRANSCRIPT_MESSAGE_ID_BASE = 1000

/** Ids reserved per archived message, one for each part it renders. */
const TRANSCRIPT_MESSAGE_ID_STRIDE = 1000

/**
 * Telegram message id of one rendered part of a transcript.
 *
 * Clients page history by message *id*: `offset_id`, `max_id` and `min_id`
 * are cursors, and a page has to be exactly the slice of the transcript those
 * cursors select.  Ids therefore grow with the transcript's chronological
 * order.  A hash cannot do that: every cursor would land on an arbitrary
 * subset of the transcript, and the client's own tiebreaker for messages that
 * share a timestamp — QQ timestamps only have second resolution — would order
 * them randomly instead of the way the archive stores them.
 *
 * `rank * stride` leaves every rendered part of one archived message its own
 * id.  A QQ message renders at most a handful of parts, far below the stride.
 */
export function transcriptMessageId(rank: number, ordinal: number): number {
  return TRANSCRIPT_MESSAGE_ID_BASE + rank * TRANSCRIPT_MESSAGE_ID_STRIDE + ordinal
}

/**
 * Chronological order of a transcript's archived messages.
 *
 * QQ returns a merged forward in the order it stored the records, which is the
 * order the sender produced them; the timestamp is second-resolution, so it
 * only breaks ties between records that arrived out of order.
 */
function chronologicalSnapshots(snapshots: readonly IMMessageSnapshot[]): IMMessageSnapshot[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((left, right) =>
      left.snapshot.timestamp - right.snapshot.timestamp || left.index - right.index)
    .map((entry) => entry.snapshot)
}

/** Chronological rank of every archived message of one transcript. */
function transcriptRanks(snapshots: readonly IMMessageSnapshot[]): Map<string, number> {
  return new Map(chronologicalSnapshots(snapshots).map((snapshot, rank) => [snapshot.id, rank]))
}

function bundleUserId(state: BridgeSessionState, platformUserId: string): number {
  return stableId(`merged-forward-user:${state.session.platformSessionId}:${platformUserId}`)
}

/**
 * Telegram `photo` size declared for bundle avatars when the adapter does not
 * report the real dimensions.  QQ avatars are square, so one value covers both
 * axes and clients only use it as a scaling hint.
 */
const BUNDLE_PHOTO_SIZE = 640

/**
 * File reference of the photos this feature serves through
 * `inputPhotoFileLocation`.  It keeps bundle photos addressable without
 * reading or persisting anything: the bytes are still fetched from the adapter
 * on every request.
 */
const BUNDLE_PHOTO_FILE_REFERENCE = new TextEncoder().encode('crossgram-merged-forward-avatar:v1')

/** Registry key of one synthetic peer photo. */
function peerKey(peer: AvatarPeer, photoId: Long): string {
  return `${peer.kind}:${peer.id}:${photoId.toString()}`
}

/** Durable transcript whose peer photo a file location asks for, if any. */
function transcriptPhotoChatId(location: tl.TypeInputFileLocation): number | undefined {
  if (location._ !== 'inputPeerPhotoFileLocation' || location.peer._ !== 'inputPeerChat') return
  return decodeBundleChatId(location.peer.chatId) ? location.peer.chatId : undefined
}

/** Registry peer of a Telegram file location, when it addresses a chat peer. */
function inputPeerKey(location: tl.TypeInputPeer): string | undefined {
  if (location._ === 'inputPeerUser') return `user:${location.userId}`
  if (location._ === 'inputPeerChat') return `chat:${location.chatId}`
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

/** Storage type of one avatar payload, sniffed from the bytes themselves. */
function avatarStorageFileType(bytes: Uint8Array): tl.storage.TypeFileType {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { _: 'storage.filePng' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { _: 'storage.fileJpeg' }
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { _: 'storage.fileWebp' }
  }
  return { _: 'storage.fileUnknown' }
}

/** Offset id a patched client sends to ask for the beginning of a transcript. */
const kFirstMessageOffsetId = 1

/** Oldest `limit` messages of a newest-first slice, keeping that order. */
function firstPage(
  messages: readonly tl.TypeMessage[],
  limit: number,
): tl.TypeMessage[] {
  const count = Math.max(0, limit)
  return messages.slice(Math.max(0, messages.length - count))
}

function selectHistory(
  messages: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): tl.TypeMessage[] {
  const filtered = selectWithinBounds(messages, request)
  const start = pageStart(filtered, request)
  return filtered.slice(start, start + Math.max(0, request.limit))
}

/**
 * Messages a history request admits: `maxId` and `minId` bound the transcript
 * by id, exactly as they bound an ordinary chat.
 */
function selectWithinBounds(
  messages: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): tl.TypeMessage[] {
  let filtered = [...messages]
  if (request.maxId > 0) filtered = filtered.filter((message) => message.id < request.maxId)
  if (request.minId > 0) filtered = filtered.filter((message) => message.id > request.minId)
  return filtered
}

/**
 * Where a history page starts inside a newest-first transcript.
 *
 * Telegram treats `offsetId` as an exclusive cursor and `addOffset` as a shift
 * of the window: zero loads the messages directly below the cursor, a negative
 * offset moves the window toward newer messages — which is how clients load
 * the newest page (`offsetId = newest + 1`, `addOffset = -limit`), open a deep
 * link (`addOffset = -limit / 2`, so the anchor itself is in the page) or walk
 * forward from a gap in their local history.  A cursor below every message
 * starts past the oldest one, so a negative offset there returns the oldest
 * page; a window shifted above the newest message is clamped to it.
 */
function pageStart(
  filtered: readonly tl.TypeMessage[],
  request: tl.messages.RawGetHistoryRequest,
): number {
  let start = 0
  if (request.offsetId > 0) {
    // The cursor is exclusive: the page begins at the first message below it,
    // which for an id between two messages is their boundary — never a page
    // that silently restarts at the newest message.
    const below = filtered.findIndex((message) => message.id < request.offsetId)
    start = below < 0 ? filtered.length : below
  }
  return Math.max(0, start + request.addOffset)
}

function inputMessageId(input: tl.TypeInputMessage): number {
  return input._ === 'inputMessageID' || input._ === 'inputMessageReplyTo' ? input.id : 0
}

function messageDate(message: tl.TypeMessage): number {
  return message._ === 'messageEmpty' ? 0 : message.date
}

function uniqueById<T extends { _: string, id: number }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [`${item._}:${item.id}`, item])).values()]
}
