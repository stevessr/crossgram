import { describe, expect, it } from 'vitest'
import { mapPack, roomPacks, packId } from './stickers.js'
import { MatrixPlatform } from './index.js'
import type { MatrixEvent } from './types.js'
const event = (type: string, key: string, content: Record<string, unknown>): MatrixEvent => ({ type, state_key: key, content })
const images = { cat: { url: 'mxc://test/cat', info: { mimetype: 'image/png', w: 128, h: 64 } } }
describe('Matrix image packs', () => {
  it('marks only explicitly enabled keys global, with stable namespaced identities', () => {
    const events = [event('im.ponies.room_emotes', '', { images }), event('m.room.image_pack', 'local', { images })]
    const sources = roomPacks('!room:test', events, { '!room:test': { '': {} } })
    expect(sources.map(s => s.global)).toEqual([true, false])
    expect(roomPacks('!room:test', events, { '!room:test': {} }).every(s => !s.global)).toBe(true)
    expect(packId('!room:test', '')).not.toBe(packId('!other:test', ''))
  })
  it('prefers stable state over legacy state and filters empty/redacted/deleted packs', () => {
    const sources = roomPacks('!room:test', [event('im.ponies.room_emotes', '', { images }), event('m.room.image_pack', '', {})], {})
    expect(sources).toHaveLength(1)
    expect(mapPack('matrix:stickers', sources[0]).stickers).toEqual([])
  })
  it('honors sticker usage and rejects non-MXC images', () => {
    const source = { id: 'pack', title: 'Pack', global: false, content: {
      pack: { usage: ['emoticon'] }, images: { ...images,
        sticker: { url: 'mxc://test/sticker', usage: ['sticker'] }, bad: { url: 'https://untrusted.test/a', usage: ['sticker'] } },
    } }
    const pack = mapPack('matrix:stickers', source)
    expect(pack.stickers).toHaveLength(1)
    expect(pack.stickers[0].locator).toEqual({ mxc: 'mxc://test/sticker' })
    expect(pack.automaticAssociation).toBeUndefined()
  })
  it('associates enabled global packs with only their owning account', () => {
    const pack = mapPack('matrix:stickers', { id: 'global', title: 'Global', global: true, content: { images } })
    expect(pack.automaticAssociation).toBe('provider-account')
    expect(pack.stickers[0]).toMatchObject({ width: 128, height: 64, format: 'static' })
  })
})

describe('Matrix adapter sticker catalog invalidation', () => {
  it('keeps global selection replacement separate from room-local packs and avoids scanning member state', async () => {
    const { MatrixPlatform } = await import('./index.js')
    const { MatrixStickerProvider } = await import('./stickers.js')
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as unknown as {
      loadJoinedDialogs(): Promise<unknown[]>
      joinedRoomIds: Set<string>
      ingestState(room: string, events: MatrixEvent[]): void
      ingestAccountData(response: unknown): boolean
    }
    internal.loadJoinedDialogs = async () => []
    internal.joinedRoomIds.add('!a:test'); internal.joinedRoomIds.add('!b:test')
    internal.ingestState('!a:test', [event('m.room.image_pack', 'local', { images })])
    internal.ingestState('!b:test', [event('m.room.image_pack', 'local', { images })])
    const provider = new MatrixStickerProvider(platform.client, 'matrix:stickers', 'matrix', id => platform.getStickerSources(id))
    const context = { platformKind: 'matrix', session: { platformId: 'matrix', platformSessionId: 's', userId: '@me:test', credentials: {}, metadata: {} } }
    internal.ingestAccountData({ account_data: { events: [{ type: 'm.image_pack.rooms', content: { rooms: { '!a:test': { local: {} } } } }] } })
    expect((await provider.listPacks(context)).packs).toHaveLength(1)
    expect((await provider.listPacks({ ...context, conversation: { id: '!b:test' } })).packs).toHaveLength(2)
    internal.ingestAccountData({ account_data: { events: [{ type: 'm.image_pack.rooms', content: { rooms: {} } }] } })
    expect((await provider.listPacks(context)).packs).toHaveLength(0)
    expect((await provider.listPacks({ ...context, conversation: { id: '!b:test' } })).packs).toHaveLength(1)
    internal.ingestState('!b:test', [event('m.room.image_pack', 'local', {})])
    expect((await provider.listPacks({ ...context, conversation: { id: '!b:test' } })).packs).toHaveLength(0)
    await platform.stop()
  })
})

describe('automatic Matrix message-to-pack mapping', () => {
  it('uses canonical pack/sticker IDs, prefers the local pack, and invalidates on updates', async () => {
    const { MatrixPlatform } = await import('./index.js')
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    internal.joinedRoomIds.add('!a:test'); internal.joinedRoomIds.add('!b:test')
    internal.ingestState('!a:test', [event('m.room.image_pack', 'local', { images })])
    internal.ingestState('!b:test', [event('m.room.image_pack', 'global', { images })])
    internal.ingestAccountData({ account_data: { events: [{ type: 'm.image_pack.rooms', content: { rooms: { '!b:test': { global: {} } } } }] } })
    const received = (room: string, url = 'mxc://test/cat') => internal.mapTimelineMessage(room, {
      type: 'm.sticker', event_id: '$sticker', sender: '@alice:test', origin_server_ts: 1000,
      content: { url, body: 'Received cat', info: { mimetype: 'image/png', w: 256, h: 256 } },
    }).content.parts[0].sticker
    const localId = packId('!a:test', 'local'), globalId = packId('!b:test', 'global')
    expect(received('!a:test')).toMatchObject({ packId: localId, stickerId: packId(localId, 'cat'), width: 256 })
    expect(received('!unrelated:test')).toMatchObject({ packId: globalId, stickerId: packId(globalId, 'cat') })
    internal.ingestState('!a:test', [event('m.room.image_pack', 'local', {})])
    expect(received('!a:test').packId).toBe(globalId)
    internal.ingestAccountData({ account_data: { events: [{ type: 'm.image_pack.rooms', content: { rooms: {} } }] } })
    expect(received('!a:test').packId).toBeUndefined()
    expect(received('!a:test').stickerId).toBe('mxc://test/cat')
    expect(received('!unrelated:test', 'mxc://test/unknown').packId).toBeUndefined()
    await platform.stop()
  })

  it('retains downloadable received media after pack removal without resurrecting the catalog', async () => {
    const { MatrixPlatform } = await import('./index.js')
    const { MatrixStickerProvider } = await import('./stickers.js')
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    internal.loadJoinedDialogs = async () => []
    internal.joinedRoomIds.add('!room:test')
    internal.ingestState('!room:test', [event('m.room.image_pack', '', { images })])
    const part = internal.mapTimelineMessage('!room:test', { type: 'm.sticker', event_id: '$s', sender: '@me:test', content: { url: 'mxc://test/cat' } }).content.parts[0]
    const provider = new MatrixStickerProvider(platform.client, 'matrix:stickers', 'matrix', id => platform.getStickerSources(id), id => platform.getObservedSticker(id))
    internal.ingestState('!room:test', [event('m.room.image_pack', '', {})])
    const context = { platformKind: 'matrix', session: { platformId: 'matrix', platformSessionId: 's', userId: '@me:test', credentials: {}, metadata: {} } }
    expect(await provider.getPack(context, part.sticker.packId)).toBeNull()
    expect(await provider.getSticker(context, part.sticker.stickerId)).toMatchObject({ locator: { mxc: 'mxc://test/cat' }, mimeType: 'image/png', width: 128 })
    await platform.stop()
  })

  it('classifies video stickers and maps encrypted sticker events through file.url', async () => {
    const { MatrixPlatform } = await import('./index.js')
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    const sticker = (content: Record<string, unknown>) => internal.mapTimelineMessage('!room:test', {
      type: 'm.sticker', event_id: '$s', sender: '@me:test', origin_server_ts: 1000, content,
    })?.content.parts[0]
    expect(sticker({ url: 'mxc://test/webm', body: 'clip',
      info: { mimetype: 'video/webm', w: 128, h: 128 } })?.sticker).toMatchObject({ format: 'video', mimeType: 'video/webm' })
    expect(sticker({ url: 'mxc://test/gif', body: 'gif',
      info: { mimetype: 'image/gif' } })?.sticker).toMatchObject({ format: 'animated' })
    expect(sticker({ body: 'hidden', file: { url: 'mxc://test/encrypted' } })?.sticker).toMatchObject({
      stickerId: 'mxc://test/encrypted', locator: { mxc: 'mxc://test/encrypted' }, format: 'static',
    })
    expect(sticker({ body: 'unreachable' })).toBeUndefined()
    await platform.stop()
  })

  it('inherits canonical Space packs and attaches global-only catalogs to rooms', async () => {
    const { MatrixPlatform } = await import('./index.js')
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    internal.loadJoinedDialogs = async () => []
    internal.joinedRoomIds.add('!space:test'); internal.joinedRoomIds.add('!room:test')
    internal.ingestState('!space:test', [event('m.room.image_pack', 'space', { images })])
    internal.ingestState('!room:test', [event('m.space.parent', '!space:test', { canonical: true })])
    const result = internal.mapTimelineMessage('!room:test', { type: 'm.sticker', event_id: '$s', sender: '@me:test', content: { url: 'mxc://test/cat' } })
    expect(result.content.parts[0].sticker.packId).toBe(packId('!space:test', 'space'))
    internal.ingestAccountData({ account_data: { events: [{ type: 'm.image_pack', content: { images } }] } })
    expect(await platform.getConversationStickerPack({} as any, { id: '!empty:test' })).toMatchObject({ providerId: 'matrix:stickers' })
    await platform.stop()
  })
})

describe('coexisting stable and legacy sticker catalogs', () => {
  it('unions global selections, fetches missing joined-room packs, and preserves personal image usage', async () => {
    const { MatrixPlatform } = await import('./index.js')
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    internal.loadJoinedDialogs = async () => []
    internal.joinedRoomIds.add('!a:test')
    internal.joinedRoomIds.add('!b:test')
    internal.ingestState('!a:test', [event('m.room.image_pack', 'local', { images })])
    internal.ingestState('!b:test', [event('im.ponies.room_emotes', 'legacy', { images })])
    internal.ingestAccountData({ account_data: { events: [
      { type: 'im.ponies.emote_rooms', content: { rooms: { '!b:test': { legacy: {} } } } },
      { type: 'm.image_pack.rooms', content: { rooms: { '!a:test': { missing: {} } } } },
      { type: 'im.ponies.user_emotes', content: { pack: { usage: ['sticker'] }, images: { old: { url: 'mxc://test/old' } } } },
      { type: 'm.image_pack', content: { pack: { usage: ['emoticon'] }, images: { newer: { url: 'mxc://test/new' } } } },
    ] } })
    const fetched: string[] = []
    platform.client.getStateContent = async (room, _type, key) => { fetched.push(`${room}/${key}`); return { images } }
    try {
      const sources = await platform.getStickerSources()
      expect(sources.map(s => s.id)).toEqual(expect.arrayContaining([packId('!a:test', 'missing'), packId('!b:test', 'legacy'), packId('@account', '')]))
      expect(sources.map(s => s.id)).not.toContain(packId('!a:test', 'local'))
      expect(fetched).toEqual(['!a:test/missing'])
      const personal = mapPack('matrix:stickers', sources.find(s => s.id === packId('@account', ''))!)
      expect(personal.stickers.map(s => s.locator)).toEqual([{ mxc: 'mxc://test/old' }])
      internal.ingestAccountData({ account_data: { events: [{ type: 'm.image_pack.rooms', content: { rooms: {} } }, { type: 'm.image_pack', content: {} }] } })
      expect((await platform.getStickerSources()).map(s => s.id)).toContain(packId('!b:test', 'legacy'))
      internal.ingestAccountData({ account_data: { events: [{ type: 'im.ponies.emote_rooms', content: { rooms: {} } }] } })
      expect((await platform.getStickerSources()).map(s => s.id)).not.toContain(packId('!b:test', 'legacy'))
    } finally { await platform.stop() }
  })

  it('warms every joined room with packs separately and prefetches external global packs once', async () => {
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    internal.loadJoinedDialogs = async () => []
    internal.joinedRoomIds.add('!a:test')
    internal.joinedRoomIds.add('!b:test')
    internal.ingestState('!a:test', [event('m.room.image_pack', 'local', { images })])
    internal.ingestState('!b:test', [event('im.ponies.room_emotes', 'legacy', { images })])
    internal.ingestAccountData({ account_data: { events: [
      { type: 'm.image_pack.rooms', content: { rooms: { '!b:test': { external: {} } } } },
    ] } })
    const fetched: string[] = []
    platform.client.getStateContent = async (room, _type, key) => { fetched.push(`${room}/${key}`); return { images } }
    try {
      await platform.warmStickerCaches()
      // Rooms with several packs keep distinct per-room media indexes.
      expect(internal.stickerMediaIndexes.get('!a:test')?.size).toBe(1)
      expect(internal.stickerMediaIndexes.get('!b:test')?.size).toBe(1)
      // The external global pack was resolved during warm-up, exactly once:
      // the room-less global pass must reuse the per-room prefetch.
      expect(fetched).toEqual(['!b:test/external'])
    } finally { await platform.stop() }
  })

  it('survives a failed dialog fetch during sticker warm-up', async () => {
    const platform = new MatrixPlatform({ homeserver: 'https://matrix.test', accessToken: 'fixture' })
    const internal = platform as any
    internal.loadJoinedDialogs = async () => { throw new Error('homeserver down') }
    internal.joinedRoomIds.add('!a:test')
    internal.ingestState('!a:test', [event('m.room.image_pack', 'local', { images })])
    try {
      await expect(platform.warmStickerCaches()).resolves.toBeUndefined()
    } finally { await platform.stop() }
  })
})
