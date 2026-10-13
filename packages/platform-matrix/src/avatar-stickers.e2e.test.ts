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
import { ReactionRpc } from '../../bridge/src/reaction-rpc.js'
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
  let stickers: StickerRpc
  let recreateStickers: () => StickerRpc, registry: StickerProviderRegistry
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
      if (path.endsWith('/m.annotation')) return reply({ chunk: [
        { type: 'm.reaction', event_id: '$r1', sender: '@alice:test', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$received', key: 'mxc://test/local-b' } } },
        { type: 'm.reaction', event_id: '$r2', sender: '@alice:test', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$received', key: 'mxc://test/local-b' } } },
        { type: 'm.reaction', event_id: '$r3', sender: '@bob:test', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$received', key: '1️⃣' } } },
        { type: 'm.reaction', event_id: '$r4', sender: '@bob:test', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$received', key: 'looks good' } } },
      ] })
      if (path.includes('/send/m.reaction/')) return reply({ event_id: '$new-reaction' })
      if (path.includes('/send/m.sticker/')) return reply({ event_id: '$sent-sticker' })
      if (path.endsWith('/messages')) return reply({ chunk: [{ type: 'm.sticker', event_id: '$received', sender: '@alice:test', origin_server_ts: 1000, content: { body: 'Cat', url: 'mxc://test/local-b', info: { mimetype: 'image/png', w: 64, h: 64 } } }] })
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
    registry = new StickerProviderRegistry()
    registry.register('matrix:stickers', new MatrixStickerProvider(platform.client, 'matrix:stickers', 'matrix', id => platform.getStickerSources(id)))
    recreateStickers = () => new StickerRpc(ctx.database, registry, platform, session)
    stickers = recreateStickers()
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
    if (full.fullChat._ !== 'channelFull' || !full.fullChat.stickerset) throw new Error('Missing room set')
    const set = full.fullChat.stickerset
    const request = { _: 'messages.getStickerSet' as const, stickerset: { _: 'inputStickerSetID' as const, id: set.id, accessHash: set.accessHash }, hash: 0 }
    for (const candidate of [stickers, recreateStickers()]) {
      registry.touch('matrix:stickers')
      const loaded = await candidate.getStickerSet(request)
      expect(loaded).toMatchObject({ _: 'messages.stickerSet', documents: expect.any(Array) })
      if (loaded._ !== 'messages.stickerSet') throw new Error('Missing set content')
      expect(loaded.documents).toHaveLength(3)
    }
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
  it('projects all Unicode emoji and only visible room stickers, renders and sends MXC reactions', async () => {
    await platform.getDialogs(session, { limit: 100 })
    const context = await platform.getAvailableReactions(session, { conversationId: '!b:test' })
    const emoji = context.available.filter(d => d.presentation.type === 'emoji').map(d => d.key)
    expect(emoji.length).toBeGreaterThan(3500)
    expect(emoji).toEqual(expect.arrayContaining(['1️⃣', '🇨🇳', '👩🏽‍💻', '❤️']))
    const custom = context.available.filter(d => d.presentation.type === 'custom').map(d => d.key)
    expect(custom).toEqual(expect.arrayContaining(['mxc://test/local-b', 'mxc://test/global', 'mxc://test/personal']))
    expect(custom).not.toContain('mxc://test/local-a')
    const reactions = new ReactionRpc(platform, session)
    const chat = reactions.chatReactions('!b:test', context)
    expect(chat._).toBe('chatReactionsSome')
    const definition = context.available.find(d => d.key === 'mxc://test/local-b')!
    const customInput = reactions.toTlReaction('!b:test', definition)
    expect(customInput._).toBe('reactionCustomEmoji')
    expect(reactions.resolveInput('!b:test', customInput, context).key).toBe('mxc://test/local-b')
    const target = { conversationId: '!b:test', messageId: '$received', targetId: '$received' }
    const counts = await platform.getMessageReactions(session, target)
    expect(counts.available.length).toBeLessThan(100)
    expect(counts.reactions.find(r => r.key === 'mxc://test/local-b')?.count).toBe(1)
    const message = (await platform.getHistory(session, { id: '!b:test' }, { limit: 1 })).messages[0]
    message.reactionContext = counts
    const projected = reactions.messageReactions('!b:test', message, () => 1)
    expect(projected.results).toEqual(expect.arrayContaining([expect.objectContaining({ reaction: customInput, count: 1 })]))
    const otherContext = await platform.getAvailableReactions(session, { conversationId: '!a:test' })
    const other = otherContext.available.find(d => d.key === 'mxc://test/local-a')!
    expect(() => reactions.resolveInput('!b:test', reactions.toTlReaction('!a:test', other), context)).toThrow('REACTION_INVALID')
    expect(counts.reactions.map(r => r.key)).toEqual(expect.arrayContaining(['1️⃣', 'looks good']))
    expect(counts.available.find(d => d.key === 'mxc://test/local-b')?.presentation.type).toBe('custom')
    const actors = await platform.getMessageReactionActors(session, target, { reactionKey: 'mxc://test/local-b', limit: 10 })
    expect(actors.actors).toHaveLength(1)
    await platform.setMessageReactions(session, target, ['mxc://test/local-b', '1️⃣'])
    const writes = calls.filter(c => c.path.includes('/send/m.reaction/')).map(c => JSON.parse(c.body.toString()))
    expect(writes).toEqual(expect.arrayContaining([{ 'm.relates_to': { rel_type: 'm.annotation', event_id: '$received', key: 'mxc://test/local-b' } }]))
    if (customInput._ !== 'reactionCustomEmoji') throw new Error('Expected custom reaction')
    const file = await reactions.getFile(customInput.documentId.toNumber(), 1, 1)
    expect([...file!.bytes]).toEqual([2])
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
    const part = history.messages[0].content.parts[0]
    expect(part).toMatchObject({ type: 'sticker', sticker: { providerId: 'matrix:stickers', stickerId: local.stickerId, packId: local.packId } })
    if (part.type !== 'sticker') throw new Error('Expected sticker')
    const media = stickers.makeMessageMedia(part.sticker)
    if (media.document?._ !== 'document') throw new Error('Expected document')
    const document = media.document
    const attr = document.attributes.find(a => a._ === 'documentAttributeSticker')
    if (attr?._ !== 'documentAttributeSticker' || attr.stickerset._ !== 'inputStickerSetID') throw new Error('Missing automatic pack association')
    const opened = await stickers.getStickerSet({ _: 'messages.getStickerSet', stickerset: attr.stickerset, hash: 0 })
    if (opened._ !== 'messages.stickerSet') throw new Error('Expected complete pack')
    expect(opened.documents.some(d => d.id.eq(document.id))).toBe(true)
    expect(opened.set.count).toBe(1)
    const canonical = await provider.getSticker(context, part.sticker.stickerId)
    expect(canonical?.packId).toBe(local.packId)
    const asset = await provider.openAsset(context, canonical!)
    const chunks = []; for await (const chunk of asset.source.stream()) chunks.push(...chunk)
    expect(chunks).toEqual([1, 2, 3])
  })
})
