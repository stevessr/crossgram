import { describe, expect, it } from 'vitest'
import { mapPack, roomPacks, packId } from './stickers.js'
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
