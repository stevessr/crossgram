import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLite from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { defineModels } from '../../bridge/src/models.js'
import { UploadManager } from '../../bridge/src/upload-manager.js'
import { StickerRpc } from '../../bridge/src/sticker-rpc.js'
import { StickerProviderRegistry } from '../../bridge/src/sticker-provider.js'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { MatrixPlatform } from './index.js'
import { MatrixStickerProvider } from './stickers.js'
import type { MatrixEvent } from './types.js'

const session: PlatformSession = { platformSessionId: 'matrix-avatar-e2e', platformId: 'matrix', userId: '@me:test', credentials: {}, metadata: {} }
const state = (type: string, content: Record<string, unknown>, key = ''): MatrixEvent => ({ type, state_key: key, content, event_id: `$${type}:${key}` })
const pack = (url: string) => ({ pack: { usage: ['sticker'] }, images: { cat: { url, body: 'Cat', info: { mimetype: 'image/png', w: 64, h: 64 } } } })

describe('Matrix avatars and room/global stickers over real HTTP and bridge RPC', () => {
  let homeserver: string, platform: MatrixPlatform, rpc: DialogRpc, uploads: UploadManager
  let cleanup: () => Promise<void>, store: MessageStore
  let profileAvatar = 'mxc://test/old-user', uploadSequence = 0
  const calls: Array<{ path: string, method: string, body: Buffer }> = []
  const rooms: Record<string, MatrixEvent[]> = {
    '!a:test': [state('m.room.name', { name: 'A' }), state('m.room.avatar', { url: 'mxc://test/old-room' }), state('m.room.image_pack', pack('mxc://test/local-a'), 'local'), state('m.room.image_pack', pack('mxc://test/global'), 'global')],
    '!b:test': [state('m.room.name', { name: 'B' }), state('im.ponies.room_emotes', pack('mxc://test/local-b'), '')],
    '!space:test': [state('m.room.create', { type: 'm.space' }), state('m.room.name', { name: 'Space' })],
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks), path = decodeURIComponent(new URL(req.url!, 'http://test').pathname)
      calls.push({ path, method: req.method!, body })
      res.setHeader('content-type', 'application/json')
      const reply = (value: unknown) => res.end(JSON.stringify(value))
      if (path.endsWith('/account/whoami')) return reply({ user_id: session.userId })
      if (path.endsWith('/profile/@me:test/avatar_url') && req.method === 'PUT') { profileAvatar = JSON.parse(body.toString()).avatar_url; return reply({}) }
      if (path.endsWith('/profile/@me:test')) return reply({ displayname: 'Me', avatar_url: profileAvatar })
      if (path.endsWith('/sync')) return reply({ next_batch: 's1', account_data: { events: [
        { type: 'm.image_pack.rooms', content: { rooms: { '!a:test': { global: {} } } } },
        { type: 'im.ponies.user_emotes', content: pack('mxc://test/personal') },
      ] }, rooms: { join: Object.fromEntries(Object.entries(rooms).map(([id, events]) => [id, { state: { events }, timeline: { events: [] } }])) } })
      if (path.includes('/upload')) return reply({ content_uri: `mxc://test/upload-${++uploadSequence}` })
      const match = /\/rooms\/(.+?)\/state(?:\/(.+))?$/.exec(path)
      if (match && req.method === 'GET' && !match[2]) return reply(rooms[match[1]] ?? [])
      if (match && req.method === 'PUT' && match[2] === 'm.room.avatar') {
        const content = JSON.parse(body.toString()); const list = rooms[match[1]] ??= []
        const old = list.findIndex(e => e.type === 'm.room.avatar'); if (old >= 0) list.splice(old, 1)
        list.push(state('m.room.avatar', content)); return reply({ event_id: `$avatar-${uploadSequence}` })
      }
      if (path.includes('/send/m.sticker/')) return reply({ event_id: '$sent-sticker' })
      if (path.endsWith('/messages')) return reply({ chunk: [{ type: 'm.sticker', event_id: '$received', sender: '@alice:test', origin_server_ts: 1000, content: { body: 'Cat', url: 'mxc://test/incoming', info: { mimetype: 'image/png', w: 64, h: 64 } } }] })
      if (path.includes('/download/')) { res.setHeader('content-type', 'image/png'); return res.end(Buffer.from([1, 2, 3])) }
      if (path.includes('/pinned_events')) { res.statusCode = 404; return reply({ errcode: 'M_NOT_FOUND' }) }
      throw new Error(`Unexpected HTTP ${req.method} ${path}`)
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
  })
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    homeserver = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const ctx = new Context(), fibers = [ctx.plugin(Database), ctx.plugin(SQLite, { path: ':memory:' })]
    await Promise.all(fibers); await new Promise(resolve => setTimeout(resolve, 25)); defineModels(ctx); await ctx.database.prepared()
    platform = new MatrixPlatform({ homeserver, accessToken: 'fixture-token', userId: session.userId })
    const dir = await mkdtemp(join(tmpdir(), 'matrix-avatar-')); uploads = new UploadManager(dir)
    store = new MessageStore(ctx.database)
    const registry = new StickerProviderRegistry()
    registry.register('matrix:stickers', new MatrixStickerProvider(platform.client, 'matrix:stickers', 'matrix', id => platform.getStickerSources(id)))
    const stickers = new StickerRpc(ctx.database, registry, platform, session)
    rpc = new DialogRpc(platform, session, store, uploads, undefined, 1, stickers)
    cleanup = async () => { await platform.stop(); await rm(dir, { recursive: true, force: true }); for (const fiber of fibers.reverse()) await fiber.dispose() }
  })
  afterAll(async () => { await cleanup?.(); await new Promise<void>(resolve => server.close(() => resolve())) })

  it('uploads and deletes the authenticated user photo via Telegram RPC', async () => {
    await uploads.savePart(session.platformSessionId, '991', 0, new Uint8Array([1, 2, 3]))
    const result = await rpc.uploadProfilePhoto({ _: 'photos.uploadProfilePhoto', file: { _: 'inputFile', id: Long.fromNumber(991), parts: 1, name: 'avatar.png', md5Checksum: '' } })
    expect(result.photo._).toBe('photo')
    expect(profileAvatar).toBe('mxc://test/upload-1')
    const photos = await rpc.getUserPhotos({ _: 'photos.getUserPhotos', userId: { _: 'inputUserSelf' }, offset: 0, maxId: Long.ZERO, limit: 10 })
    expect(photos.photos).toHaveLength(1)
    if (result.photo._ !== 'photo') throw new Error('Missing uploaded photo')
    const deleted = await rpc.deleteProfilePhotos({ _: 'photos.deletePhotos', id: [{ _: 'inputPhoto', id: result.photo.id, accessHash: result.photo.accessHash, fileReference: result.photo.fileReference }] })
    expect(deleted).toEqual([result.photo.id]); expect(profileAvatar).toBe('')
    expect((await store.getUser(session.platformId, session.userId))?.avatar).toBeNull()
    expect((await rpc.getUserPhotos({ _: 'photos.getUserPhotos', userId: { _: 'inputUserSelf' }, offset: 0, maxId: Long.ZERO, limit: 10 })).photos).toEqual([])
  })
  it('changes and removes room photos through Telegram channels.editPhoto', async () => {
    const dialogs = await rpc.getDialogs({ _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO })
    if (dialogs._ === 'messages.dialogsNotModified') throw new Error('No dialogs')
    const chat = dialogs.chats.find(c => c._ === 'channel' && c.title === 'A')
    if (!chat || chat._ !== 'channel') throw new Error('No room A')
    const channel = { _: 'inputChannel' as const, channelId: chat.id, accessHash: chat.accessHash ?? Long.ZERO }
    await uploads.savePart(session.platformSessionId, '992', 0, new Uint8Array([4, 5, 6]))
    const result = await rpc.editChannelPhoto({ _: 'channels.editPhoto', channel, photo: { _: 'inputChatUploadedPhoto', file: { _: 'inputFile', id: Long.fromNumber(992), parts: 1, name: 'avatar.png', md5Checksum: '' } } })
    expect(result.chats[0]).toMatchObject({ photo: { _: 'chatPhoto' } })
    await rpc.editChannelPhoto({ _: 'channels.editPhoto', channel, photo: { _: 'inputChatPhotoEmpty' } })
    expect(rooms['!a:test'].find(e => e.type === 'm.room.avatar')?.content).toEqual({})
    expect((await store.getConversation(session.platformSessionId, '!a:test'))?.avatar).toBeUndefined()
    const full = await rpc.getFullChannel({ _: 'channels.getFullChannel', channel })
    expect(full.fullChat).toMatchObject({ stickerset: { _: 'stickerSet', count: 3 } })
    expect(full.chats[0]).toMatchObject({ photo: { _: 'chatPhotoEmpty' } })
    await platform.setConversationAvatar(session, { id: '!space:test' }, { kind: 'image', mimeType: 'image/png', source: { async *stream() { yield new Uint8Array([7]) } } })
    expect(rooms['!space:test'].find(e => e.type === 'm.room.avatar')?.content.url).toMatch(/^mxc:/)
    expect((await platform.getChatFolders(session)).find(f => f.id === '!space:test')?.avatar?.locator).toMatchObject({ mxc: expect.stringMatching(/^mxc:/) })
  })
  it('rejects unsupported photo variants before uploading and does not delete another photo ID', async () => {
    const before = calls.length
    await expect(rpc.uploadProfilePhoto({ _: 'photos.uploadProfilePhoto', fallback: true })).rejects.toThrow('PHOTO_INVALID')
    expect(calls).toHaveLength(before)
    expect(await rpc.deleteProfilePhotos({ _: 'photos.deletePhotos', id: [{ _: 'inputPhoto', id: Long.fromNumber(9999), accessHash: Long.ZERO, fileReference: new Uint8Array() }] })).toEqual([])
  })
  it('preserves unknown avatars but clears explicit tombstones in batch reconciliation', async () => {
    const avatar = { id: 'mxc://test/batch', kind: 'image' as const, locator: { mxc: 'mxc://test/batch' } }
    const conversation = { id: '!batch:test', kind: 'group' as const, title: 'Batch' }
    await store.ingestDialogs(session, [{ conversation: { ...conversation, avatar }, unreadCount: 0 }])
    await store.ingestDialogs(session, [{ conversation, unreadCount: 0 }])
    expect((await store.getConversation(session.platformSessionId, conversation.id))?.avatar).toEqual(avatar)
    await store.ingestDialogs(session, [{ conversation: { ...conversation, avatarRemoved: true }, unreadCount: 0 }])
    expect((await store.getConversation(session.platformSessionId, conversation.id))?.avatar).toBeUndefined()
    const user = { id: '@batch:test', firstName: 'Batch' }
    await store.upsertUsers(session, [{ ...user, avatar }])
    await store.upsertUsers(session, [user])
    expect((await store.getUser(session.platformId, user.id))?.avatar).toEqual(avatar)
    await store.upsertUsers(session, [{ ...user, avatarRemoved: true }])
    expect((await store.getUser(session.platformId, user.id))?.avatar).toBeNull()
  })
  it('keeps local packs room-scoped, merges global and personal packs, maps native sticker events and sends without uploading', async () => {
    const provider = new MatrixStickerProvider(platform.client, 'matrix:stickers', 'matrix', id => platform.getStickerSources(id))
    const context = { session, platformKind: 'matrix' }
    const global = await provider.listPacks(context)
    expect(global.packs.flatMap(p => p.stickers.map(s => s.locator))).toEqual(expect.arrayContaining([{ mxc: 'mxc://test/global' }, { mxc: 'mxc://test/personal' }]))
    const inB = await provider.listPacks({ ...context, conversation: { id: '!b:test' } })
    const urls = inB.packs.flatMap(p => p.stickers.map(s => (s.locator as { mxc: string }).mxc))
    expect(urls).toContain('mxc://test/local-b'); expect(urls).not.toContain('mxc://test/local-a'); expect(urls).toContain('mxc://test/global')
    const local = inB.packs.find(p => p.stickers.some(s => (s.locator as { mxc: string }).mxc === 'mxc://test/local-b'))!.stickers[0]
    const plan = await provider.prepareSend(context, local)
    const before = calls.filter(c => c.path.includes('/upload')).length
    const sent = await platform.sendMessage(session, { id: '!b:test' }, { parts: [{ type: 'sticker', sticker: plan }] })
    expect(sent.content.parts[0].type).toBe('sticker')
    expect(calls.filter(c => c.path.includes('/upload'))).toHaveLength(before)
    const history = await platform.getHistory(session, { id: '!b:test' }, { limit: 10 })
    expect(history.messages[0].content.parts[0]).toMatchObject({ type: 'sticker', sticker: { providerId: 'matrix:stickers', stickerId: 'mxc://test/incoming' } })
  })
})
