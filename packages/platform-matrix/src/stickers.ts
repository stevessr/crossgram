import { createHash } from 'node:crypto'
import type { IMSticker, IMStickerPack, IMStickerProvider, StickerProviderContext } from '@mtproto-relay/bridge'
import type { MatrixClient } from './client.js'
import type { MatrixEvent } from './types.js'

export const PACK_TYPES = ['im.ponies.room_emotes', 'm.room.image_pack']
export const USER_PACK_TYPES = ['im.ponies.user_emotes', 'm.image_pack']
export const GLOBAL_PACK_TYPES = ['im.ponies.emote_rooms', 'm.image_pack.rooms']
export type MatrixPackSource = { roomId?: string, id: string, title: string, content: Record<string, unknown>, global: boolean }
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
export type StickerFormat = 'static' | 'animated' | 'video'

/** Sticker animation format from a MIME type; mirrors the pack-catalog rules. */
export function stickerFormat(mimeType: string | undefined): StickerFormat {
  if (/gif|apng/.test(mimeType ?? '')) return 'animated'
  if (mimeType?.startsWith('video/')) return 'video'
  return 'static'
}
export const packId = (room: string, key: string) => Buffer.from(JSON.stringify([room, key])).toString('base64url')
export function roomPacks(roomId: string, state: Iterable<MatrixEvent>, globals: Record<string, unknown>): MatrixPackSource[] {
  const events = [...state]
  const title = object(events.find(e => e.type === 'm.room.name')?.content).name || roomId
  const selected = object(globals[roomId])
  const result = new Map<string, MatrixPackSource>()
  for (const type of PACK_TYPES) for (const event of events) {
    if (event.type !== type || event.state_key === undefined) continue
    const global = Object.hasOwn(globals, roomId) && Object.hasOwn(selected, event.state_key)
    result.set(event.state_key, { roomId, id: packId(roomId, event.state_key), title, content: event.content, global })
  }
  return [...result.values()]
}
export function mapPack(providerId: string, source: MatrixPackSource): IMStickerPack {
  const content = object(source.content), info = object(content.pack)
  const stickers: IMSticker[] = []
  for (const [key, raw] of Object.entries(object(content.images))) {
    const image = object(raw), usage = Array.isArray(image.usage) ? image.usage : info.usage
    if (Array.isArray(usage) && usage.length && !usage.includes('sticker')) continue
    if (typeof image.url !== 'string' || !/^mxc:\/\/[^/]+\/.+/.test(image.url)) continue
    const metadata = object(image.info), mimeType = typeof metadata.mimetype === 'string' ? metadata.mimetype : 'image/webp'
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) continue
    stickers.push({ providerId, packId: source.id,
      stickerId: packId(source.id, key), title: typeof image.body === 'string' ? image.body : key,
      keywords: [key], format: stickerFormat(mimeType), mimeType, width: metadata.w, height: metadata.h, size: metadata.size,
      version: createHash('sha256').update(JSON.stringify([image.url, mimeType, metadata.w, metadata.h, metadata.size])).digest().readUInt32LE(0),
      locator: { mxc: image.url },
    })
  }
  return { providerId, packId: source.id, title: typeof info.display_name === 'string' ? info.display_name : source.title,
    stickers, count: stickers.length, cover: stickers[0],
    version: createHash('sha256').update(JSON.stringify(stickers.map(s => [s.stickerId, s.version]))).digest().readUInt32LE(0),
    ...(source.global ? { automaticAssociation: 'provider-account' as const } : {}),
  }
}

export class MatrixStickerProvider implements IMStickerProvider {
  readonly capabilities
  constructor(readonly client: MatrixClient, readonly providerId: string, ownerPlatformId: string,
    readonly sources: (roomId?: string) => Promise<MatrixPackSource[]>,
    readonly observed: (id: string) => IMSticker | undefined = () => undefined) {
    this.capabilities = { platformKinds: ['matrix'], ownerPlatformId, sessionScoped: true, conversationScoped: true, canonicalLookup: true }
  }
  async listPacks(context: StickerProviderContext, query: { cursor?: string, limit?: number } = {}) {
    const packs = (await this.sources(context.conversation?.id)).map(s => mapPack(this.providerId, s)).filter(p => p.count)
    const start = Number(query.cursor ?? 0), limit = Math.max(1, Math.min(query.limit ?? 100, 200))
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid Matrix sticker cursor')
    return { packs: packs.slice(start, start + limit), nextCursor: start + limit < packs.length ? String(start + limit) : undefined }
  }
  async getPack(context: StickerProviderContext, id: string) {
    if (id.startsWith('room:')) {
      const room = Buffer.from(id.slice(5), 'base64url').toString()
      const sources = await this.sources(room)
      const stickers = [...new Map(sources.flatMap(s => mapPack(this.providerId, s).stickers).map(s => [s.stickerId, s])).values()]
      return stickers.length ? { providerId: this.providerId, packId: id, title: 'Room stickers', stickers, count: stickers.length } : null
    }
    let room: string | undefined
    try { const parsed = JSON.parse(Buffer.from(id, 'base64url').toString()); if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0] !== '@account') room = parsed[0] } catch { return null }
    const sources = await this.sources(room ?? context.conversation?.id)
    const source = sources.find(s => s.id === id)
    const pack = source ? mapPack(this.providerId, source) : null
    return pack?.count ? pack : null
  }
  async getSticker(context: StickerProviderContext, id: string): Promise<IMSticker | null> {
    // Received standalone stickers already carry authoritative MIME/dimensions.
    // Never scan room catalogs or overwrite animated metadata on media reads.
    if (id.startsWith('mxc://')) return this.observed(id) ?? { providerId: this.providerId, stickerId: id, format: 'static' as const, mimeType: 'image/webp', locator: { mxc: id } }
    let room = context.conversation?.id
    try { const [pack] = JSON.parse(Buffer.from(id, 'base64url').toString()); const [origin] = JSON.parse(Buffer.from(pack, 'base64url').toString()); if (typeof origin === 'string' && origin !== '@account') room = origin } catch { /* standalone event */ }
    for (const source of await this.sources(room)) {
      const found = mapPack(this.providerId, source).stickers.find(s => s.stickerId === id)
      if (found) return found
    }
    // Historical received stickers remain downloadable after their pack is removed.
    return this.observed(id) ?? null
  }
  async openAsset(_context: StickerProviderContext, sticker: IMSticker) {
    const mxc = object(sticker.locator).mxc
    if (typeof mxc !== 'string' || !mxc.startsWith('mxc://')) throw new Error('Invalid Matrix sticker URI')
    const client = this.client
    return { mimeType: sticker.mimeType, size: sticker.size, width: sticker.width, height: sticker.height,
      source: { size: sticker.size, stream: async function* (options?: { signal?: AbortSignal }) {
        const response = await client.download(mxc, options)
        if (!response.body) throw new Error('Empty Matrix sticker response')
        const reader = response.body.getReader()
        try { while (true) { const { done, value } = await reader.read(); if (done) return; yield value } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } },
    }
  }
  async prepareSend(_context: StickerProviderContext, sticker: IMSticker) {
    return { type: 'native' as const, providerId: this.providerId, stickerId: sticker.stickerId,
      packId: sticker.packId, reference: { mxc: object(sticker.locator).mxc, body: sticker.title ?? sticker.stickerId,
        mimeType: sticker.mimeType, format: sticker.format, width: sticker.width ?? 0, height: sticker.height ?? 0 } }
  }
}
