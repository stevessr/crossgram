import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLite from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { DialogRpc, peerTlSeed, stableId } from '../../bridge/src/dialogs.js'
import { MessageStore } from '../../bridge/src/message-store.js'
import { UpdateManager } from '../../bridge/src/update-manager.js'
import { PlatformRegistry } from '../../bridge/src/platform-manager.js'
import { defineModels } from '../../bridge/src/models.js'
import type { PlatformSession } from '../../bridge/src/platform.js'
import { MatrixPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'matrix-send-dedup', platformId: 'matrix', userId: '@me:test', credentials: {}, metadata: { firstName: 'Me' },
}
const room = '!room:test'
const state = [
  { type: 'm.room.name', state_key: '', content: { name: 'Retry fixture' } },
  { type: 'm.room.member', state_key: session.userId, content: { membership: 'join', displayname: 'Me' } },
]
function wire(value: tl.TypeUpdates): tl.RawUpdates {
  return new TlBinaryReader(__tlReaderMap, TlBinaryWriter.serializeObject(__tlWriterMap, value)).object() as tl.RawUpdates
}

describe('Matrix send idempotency over real HTTP and bridge/SQLite/TL', () => {
  let homeserver: string, store: MessageStore, ctx: Context, cleanup: () => Promise<void>
  let loseNextResponse = false
  const platforms: MatrixPlatform[] = []
  // A homeserver transaction ledger, deliberately separate from relay state.
  const committed = new Map<string, string>()
  const attempts: string[] = []
  const server = createServer(async (req, res) => {
    try {
      expect(req.headers.authorization).toBe('Bearer fixture-token')
      for await (const _chunk of req) { /* consume request before committing */ }
      const path = new URL(req.url!, 'http://test').pathname
      res.setHeader('content-type', 'application/json')
      const send = (value: unknown) => res.end(JSON.stringify(value))
      if (path.endsWith('/sync')) return send({ next_batch: 's1', rooms: { join: { [room]: { state: { events: state }, timeline: { events: [] } } } } })
      if (path.endsWith('/state')) return send(state)
      if (path.endsWith('/account/whoami')) return send({ user_id: session.userId })
      if (path.includes('/profile/')) return send({ displayname: 'Me' })
      if (path.includes('/send/m.room.message/')) {
        attempts.push(path)
        if (!committed.has(path)) committed.set(path, `$sent-${committed.size + 1}`)
        if (loseNextResponse) { loseNextResponse = false; res.destroy(); return }
        return send({ event_id: committed.get(path) })
      }
      res.statusCode = 404; return send({ errcode: 'M_NOT_FOUND' })
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
  })
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    homeserver = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLite, { path: ':memory:' })]
    await Promise.all(fibers); await new Promise(resolve => setTimeout(resolve, 25)); defineModels(ctx); await ctx.database.prepared()
    store = new MessageStore(ctx.database)
    cleanup = async () => {
      await Promise.all(platforms.map(platform => platform.stop()))
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
  afterAll(async () => { await cleanup?.(); await new Promise<void>(resolve => server.close(() => resolve())) })

  function makeRpc(failPublication = false): DialogRpc {
    // Rebuild both the RPC's recent-promise cache and the Matrix adapter, as on
    // reconnect/restart. Only the message DB and homeserver ledger survive.
    const platform = new MatrixPlatform({ homeserver, accessToken: 'fixture-token', userId: session.userId, requestTimeoutMs: 1000 })
    platforms.push(platform)
    const manager = new UpdateManager(ctx.database, new PlatformRegistry([['matrix', platform]]), store, () => 0)
    return new DialogRpc(platform, session, store, undefined, undefined, 1, undefined, undefined, undefined,
      async (account, event, options) => {
        if (event.type !== 'message') return
        if (failPublication) { failPublication = false; throw new Error('publication failed after upstream success') }
        return manager.publish(account, { event, result: await store.ingest(account, event.conversation, event.message) }, options)
      })
  }
  function request(randomId: number): tl.messages.RawSendMessageRequest {
    return { _: 'messages.sendMessage', peer: { _: 'inputPeerChannel', channelId: stableId(peerTlSeed(session.platformSessionId, room)), accessHash: Long.ZERO },
      message: 'identical text', randomId: Long.fromNumber(randomId) }
  }
  function confirmation(result: tl.RawUpdates, randomId: number): number {
    const update = result.updates.find(u => u._ === 'updateMessageID') as tl.RawUpdateMessageID
    expect(update).toBeTruthy()
    expect(update.randomId.equals(Long.fromNumber(randomId))).toBe(true)
    expect(result.seq).toBe(0)
    return update.id
  }

  it('does not resend after the server commits but the HTTP response is lost', async () => {
    const rpc = makeRpc()
    const before = committed.size, from = attempts.length
    loseNextResponse = true
    await expect(rpc.sendMessage(request(100))).rejects.toThrow()
    expect(committed.size).toBe(before + 1)
    const confirmed = confirmation(wire(await rpc.sendMessage(request(100))), 100)
    expect(committed.size).toBe(before + 1)
    expect(attempts.slice(from)).toHaveLength(2)
    expect(new Set(attempts.slice(from)).size).toBe(1)
    // A reconstructed RPC/adapter cannot cause another upstream event either.
    expect(confirmation(wire(await makeRpc().sendMessage(request(100))), 100)).toBe(confirmed)
    expect(committed.size).toBe(before + 1)
    expect((await store.readHistory(session.platformSessionId, room)).filter(m => m.id === committed.get(attempts[from]))).toHaveLength(1)
  })

  it('retries failed local confirmation without creating another Matrix message', async () => {
    const rpc = makeRpc(true), before = committed.size
    await expect(rpc.sendMessage(request(200))).rejects.toThrow('publication failed after upstream success')
    expect(committed.size).toBe(before + 1)
    confirmation(wire(await rpc.sendMessage(request(200))), 200)
    expect(committed.size).toBe(before + 1)
  })

  it('coalesces concurrent clients but allows intentional identical sends with distinct random IDs', async () => {
    const before = committed.size
    const results = await Promise.all([makeRpc().sendMessage(request(300)), makeRpc().sendMessage(request(300))])
    expect(confirmation(wire(results[0]), 300)).toBe(confirmation(wire(results[1]), 300))
    expect(committed.size).toBe(before + 1)
    const second = confirmation(wire(await makeRpc().sendMessage(request(301))), 301)
    expect(second).not.toBe(confirmation(wire(results[0]), 300))
    expect(committed.size).toBe(before + 2)
  })
})
