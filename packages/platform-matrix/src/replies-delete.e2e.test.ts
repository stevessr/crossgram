import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLite from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { DialogRpc } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { UpdateManager } from '../../bridge/src/update-manager.js'
import { PlatformRegistry } from '../../bridge/src/platform-manager.js'
import { defineModels } from '../../bridge/src/models.js'
import type { IMEvent, PlatformSession } from '../../bridge/src/platform.js'
import { MatrixPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'matrix-reply-delete', platformId: 'matrix', userId: '@me:test', credentials: {}, metadata: { firstName: 'Me' },
}
const room = '!room:test'
const state = [
  { type: 'm.room.name', state_key: '', content: { name: 'Reply room' } },
  { type: 'm.room.member', state_key: session.userId, content: { membership: 'join', displayname: 'Me' } },
]
const original = { type: 'm.room.message', event_id: '$original', sender: session.userId, origin_server_ts: 1000,
  content: { msgtype: 'm.text', body: 'original' } }
const reply = { type: 'm.room.message', event_id: '$reply', sender: '@alice:test', origin_server_ts: 2000,
  content: { msgtype: 'm.text', body: '> <@me:test> original\n\nanswer', format: 'org.matrix.custom.html',
    formatted_body: '<mx-reply><blockquote><a href="https://matrix.to/#/!room:test/$original">In reply to</a> original</blockquote></mx-reply>answer',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$original' } },
  } }
function wire<T extends tl.TlObject>(value: T): T {
  return new TlBinaryReader(__tlReaderMap, TlBinaryWriter.serializeObject(__tlWriterMap, value)).object() as T
}

describe('Matrix replies, send confirmation and deletion over HTTP, SQLite and TL projection', () => {
  let platform: MatrixPlatform, rpc: DialogRpc, store: MessageStore, manager: UpdateManager
  let cleanup: () => Promise<void>
  let upstreamSent = false
  let rejectRedaction = false
  const calls: Array<{ path: string, method: string, body: any }> = []
  const pushes: tl.RawUpdates[] = []
  const server = createServer(async (req, res) => {
    try {
      expect(req.headers.authorization).toBe('Bearer fixture-token')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString(), path = decodeURIComponent(new URL(req.url!, 'http://test').pathname)
      calls.push({ path, method: req.method!, body: text ? JSON.parse(text) : undefined })
      res.setHeader('content-type', 'application/json')
      const send = (data: unknown) => res.end(JSON.stringify(data))
      if (path.endsWith('/sync')) return send({ next_batch: 's1', rooms: { join: { [room]: { state: { events: state }, timeline: { events: [] } } } } })
      if (path.endsWith('/state')) return send(state)
      if (path.endsWith('/account/whoami')) return send({ user_id: session.userId })
      if (path.includes('/profile/')) {
        if (upstreamSent) { res.statusCode = 503; return send({ errcode: 'M_UNKNOWN', error: 'profile unavailable' }) }
        return send({ displayname: path.split('/').at(-1) })
      }
      if (path.endsWith('/messages')) return send({ chunk: [reply] })
      if (path.includes('/event/')) return send(original)
      if (path.includes('/send/m.room.message/')) { upstreamSent = true; return send({ event_id: '$sent' }) }
      if (path.includes('/redact/')) {
        if (rejectRedaction) { res.statusCode = 403; return send({ errcode: 'M_FORBIDDEN', error: 'Cannot redact' }) }
        return send({ event_id: '$redaction' })
      }
      res.statusCode = 404; return send({ errcode: 'M_NOT_FOUND' })
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
  })
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const ctx = new Context(), fibers = [ctx.plugin(Database), ctx.plugin(SQLite, { path: ':memory:' })]
    await Promise.all(fibers); await new Promise(resolve => setTimeout(resolve, 25)); defineModels(ctx); await ctx.database.prepared()
    for (const authKeyId of ['0011223344556677', '1122334455667788']) await ctx.database.create('mtproto_auth_binding', {
      authKeyId, platformId: session.platformId, platformSessionId: session.platformSessionId,
    })
    platform = new MatrixPlatform({ homeserver: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      accessToken: 'fixture-token', userId: session.userId, requestTimeoutMs: 500 })
    store = new MessageStore(ctx.database)
    manager = new UpdateManager(ctx.database, new PlatformRegistry([['matrix', platform]]), store,
      (_key, value) => { pushes.push(wire(value as tl.RawUpdates)); return 1 })
    rpc = new DialogRpc(platform, session, store, undefined, undefined, 1, undefined, undefined, undefined,
      async (account, event, options) => {
        if (event.type === 'message') return manager.publish(account, {
          event, result: await store.ingest(account, event.conversation, event.message),
        }, options)
        if (event.type === 'message-delete') return manager.publish(account, {
          event, result: await store.deleteMessages(account, event.conversation, event.messageIds),
        }, options)
      }, '0011223344556677')
    cleanup = async () => { await platform.stop(); for (const fiber of fibers.reverse()) await fiber.dispose() }
  })
  afterAll(async () => { await cleanup?.(); await new Promise<void>(resolve => server.close(() => resolve())) })

  it('uses a native reply header, confirms sends without profile calls, and publishes deletion exactly once', async () => {
    const dialogs = await rpc.getDialogs({ _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, limit: 20, hash: Long.ZERO })
    if (dialogs._ === 'messages.dialogsNotModified') throw new Error('No dialogs')
    const chat = dialogs.chats.find(c => c._ === 'channel')
    if (!chat || chat._ !== 'channel') throw new Error('No room')
    const peer = { _: 'inputPeerChannel' as const, channelId: chat.id, accessHash: chat.accessHash ?? Long.ZERO }
    const channel = { ...peer, _: 'inputChannel' as const }
    const history = wire(await rpc.getHistory({ _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 20, maxId: 0, minId: 0, hash: Long.ZERO }))
    if (history._ === 'messages.messagesNotModified') throw new Error('No history')
    const originalStored = await store.findProjectedByPlatformId(session.platformSessionId, room, '$original')
    expect(originalStored).toBeTruthy()
    const originalTl = { id: originalStored!.parts[0].tlMessageId }
    expect(calls.some(c => c.path.endsWith('/event/$original'))).toBe(true)
    expect(history.messages.find(m => m._ === 'message' && m.message === 'answer')).toMatchObject({
      replyTo: { _: 'messageReplyHeader', replyToMsgId: originalTl.id },
    })
    const randomId = Long.fromNumber(1234567)
    const sent = wire(await rpc.sendMessage({ _: 'messages.sendMessage', peer, message: 'sent reply', randomId,
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: originalTl.id },
    })) as tl.RawUpdates
    const messageId = sent.updates.find(u => u._ === 'updateMessageID') as tl.RawUpdateMessageID
    expect(messageId.randomId.equals(randomId)).toBe(true)
    expect(sent.seq).toBe(0)
    expect(calls.find(c => c.path.includes('/send/'))?.body).toMatchObject({
      body: 'sent reply', 'm.relates_to': { 'm.in_reply_to': { event_id: '$original' } },
    })
    const sendIndex = calls.findIndex(c => c.path.includes('/send/'))
    expect(calls.slice(sendIndex + 1).filter(c => c.path.includes('/profile/'))).toEqual([])
    const beforePts = (await store.getChannelUpdateState(session.platformSessionId, chat.id)).pts
    pushes.length = 0
    const deleted = wire(await rpc.deleteMessages({ _: 'channels.deleteMessages', channel, id: [messageId.id] }, channel))
    expect(deleted).toMatchObject({ pts: beforePts + 1, ptsCount: 1 })
    expect(calls.filter(c => c.path.includes('/redact/'))).toMatchObject([{ path: expect.stringContaining('/redact/$sent/'), method: 'PUT', body: {} }])
    expect(pushes).toHaveLength(1)
    expect(pushes[0].updates).toMatchObject([{ _: 'updateDeleteChannelMessages', messages: [messageId.id], pts: deleted.pts, ptsCount: 1 }])
    const conversation = (await store.getConversation(session.platformSessionId, room))!
    const echo: Extract<IMEvent, { type: 'message-delete' }> = {
      type: 'message-delete', eventId: '$redaction', conversation, messageIds: ['$sent'], timestamp: 3,
    }
    await manager.publish(session, { event: echo, result: await store.deleteMessages(session, conversation, echo.messageIds) })
    expect(pushes).toHaveLength(1)
    expect((await store.getChannelUpdateState(session.platformSessionId, chat.id)).pts).toBe(deleted.pts)
    expect((await store.readHistory(session.platformSessionId, room)).some(m => m.id === '$sent')).toBe(false)
    expect(await rpc.deleteMessages({ _: 'channels.deleteMessages', channel, id: [messageId.id] }, channel))
      .toMatchObject({ pts: deleted.pts, ptsCount: 0 })
    expect(pushes).toHaveLength(1)
    rejectRedaction = true
    await expect(rpc.deleteMessages({ _: 'channels.deleteMessages', channel, id: [originalTl.id] }, channel)).rejects.toThrow()
    expect((await store.readHistory(session.platformSessionId, room)).some(m => m.id === '$original')).toBe(true)
    expect((await store.getChannelUpdateState(session.platformSessionId, chat.id)).pts).toBe(deleted.pts)
  })
})
