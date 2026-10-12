import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, chmod, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { TelegramPlatform, mapMessage } from './index.js'
import { prepareStorage } from './storage.js'
import { backend, message } from './fixtures.js'
const session: PlatformSession = { platformSessionId: 'test', platformId: 'telegram', userId: '42', credentials: {}, metadata: {} }

describe('Telegram text adapter', () => {
  it('maps authoritative account and one dialog window without exposing secrets', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    expect(await platform.getAccount()).toMatchObject({ user: { id: '42', firstName: 'Owner' }, credentials: {} })
    const page = await platform.getDialogs(session, { limit: 1 })
    expect(page.dialogs[0]).toMatchObject({ conversation: { id: '77', kind: 'direct' }, lastMessage: { id: '10', timestamp: 1800000000000 } })
    expect(client.call).toHaveBeenCalledTimes(1)
    await platform.getDialogs(session, { cursor: page.nextCursor, limit: 1 })
    expect(client.call.mock.calls.at(-1)?.[0]).toMatchObject({ offsetId: 10, excludePinned: true })
  })
  it('resolves bridge afterId anchors and rejects bot accounts', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    await platform.getDialogs(session, { afterId: '77', limit: 1 })
    expect(client.call.mock.calls[0][0]).toMatchObject({ _: 'messages.getPeerDialogs' })
    expect(client.call.mock.calls[1][0]).toMatchObject({ _: 'messages.getDialogs', offsetId: 10 })
    const me = await client.getMe()
    Object.defineProperty(me, 'isBot', { value: true })
    client.getMe.mockResolvedValue(me)
    await expect(platform.getAccount()).rejects.toThrow('not a bot')
  })
  it('caps history windows and persists scoped cursors without iterating', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    const first = await platform.getHistory(session, { id: '77' }, { limit: 1 })
    expect(client.getHistory).toHaveBeenCalledTimes(1)
    await platform.getHistory(session, { id: '77' }, { cursor: first.nextCursor, limit: 999 })
    expect(client.getHistory.mock.calls.at(-1)?.[1]).toMatchObject({ limit: 100, offset: { id: 10, date: 1800000000 } })
    await expect(platform.getHistory(session, { id: '78' }, { cursor: first.nextCursor })).rejects.toThrow('another conversation')
    await expect(platform.getHistory(session, { id: '77' }, { cursor: 'invalid' })).rejects.toThrow('cursor')
  })
  it('maps newer and older anchors and rejects invalid IDs/limits', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    await platform.getHistory(session, { id: '77' }, { after: { id: '9', timestamp: 1800000000000 } })
    expect(client.getHistory.mock.calls[0]?.[1]).toMatchObject({ reverse: true, minId: 9 })
    for (const id of ['0', '9x', '9007199254740992']) await expect(platform.getHistory(session, { id })).rejects.toThrow('peer ID')
    await expect(platform.getHistory(session, { id: '77' }, { limit: -1 })).rejects.toThrow('limit')
  })
  it('confirms text and replies, forwards read boundaries, rejects unsupported sends', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    expect(await platform.sendMessage(session, { id: '77' }, { parts: [{ type: 'text', text: '你好' }], replyToId: '10' })).toMatchObject({ id: '11' })
    expect(client.sendText).toHaveBeenCalledWith(77, '你好', { replyTo: 10 })
    await platform.markRead(session, { conversationId: '77', messageId: '10' })
    expect(client.readHistory).toHaveBeenCalledWith(77, { maxId: 10 })
    await expect(platform.sendMessage(session, { id: '77' }, { parts: [] })).rejects.toThrow('1..4096')
    await expect(platform.sendMessage(session, { id: '77' }, { parts: [{ type: 'image' } as never] })).rejects.toThrow('text only')
    const controller = new AbortController(); controller.abort()
    await expect(platform.sendMessage(session, { id: '77' }, { parts: [{ type: 'text', text: 'no' }] }, { signal: controller.signal })).rejects.toThrow()
    expect(client.sendText).toHaveBeenCalledTimes(1)
  })
  it('serializes deliveries, retries a failed head and drains/removes listeners', async () => {
    vi.useFakeTimers()
    try {
      const { client, adapterClient } = backend()
      const platform = new TelegramPlatform(adapterClient)
      const delivered: string[] = []
      let fail = true
      const unsubscribe = await platform.subscribe(session, async (event) => {
        if (fail) { fail = false; throw new Error('retry') }
        if (event.type === 'message' || event.type === 'message-edit') delivered.push(event.message.id)
      })
      client.onNewMessage.emit(message(10)); client.onEditMessage.emit(message(11))
      await vi.advanceTimersByTimeAsync(1001)
      expect(delivered).toEqual(['10', '11'])
      await unsubscribe()
      client.onNewMessage.emit(message(12))
      expect(client.onNewMessage.length).toBe(0)
      expect(client.onEditMessage.length).toBe(0)
      await platform.stop()
      expect(client.destroy).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('uses a single FIFO drain for a large live update burst without reordering or losing edits', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    const delivered: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let entered!: () => void
    const enteredGate = new Promise<void>((resolve) => { entered = resolve })
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (delivered.length === 0) {
        entered()
        await firstGate
      }
      if (event.type === 'message' || event.type === 'message-edit') {
        delivered.push(`${event.type}:${event.message.id}`)
      }
    })
    client.onNewMessage.emit(message(1))
    await enteredGate
    for (let i = 2; i <= 1_026; i++) {
      if (i % 4 === 0) client.onEditMessage.emit(message(i))
      else client.onNewMessage.emit(message(i))
    }
    expect(delivered).toEqual([])
    releaseFirst()
    await vi.waitFor(() => expect(delivered).toHaveLength(1_026))
    expect(delivered[0]).toBe('message:1')
    expect(delivered[1025]).toBe('message:1026')
    expect(delivered[3]).toBe('message-edit:4')
    expect(new Set(delivered).size).toBe(1_026)
    await unsubscribe()
  })

  it('releases the queued burst on unsubscribe without waiting for retriable undelivered events', async () => {
    const { client, adapterClient } = backend()
    const platform = new TelegramPlatform(adapterClient)
    const delivered: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const enteredGate = new Promise<void>((resolve) => { entered = resolve })
    const unsubscribe = await platform.subscribe(session, async (event) => {
      entered()
      await gate
      if (event.type === 'message') delivered.push(event.message.id)
    })
    client.onNewMessage.emit(message(1))
    await enteredGate
    for (let i = 2; i < 1_000; i++) client.onNewMessage.emit(message(i))
    const closing = unsubscribe()
    release()
    await closing
    expect(delivered).toEqual(['1'])
    expect(client.onNewMessage.length).toBe(0)
  })

  it('retains media-only messages as explicit unsupported placeholders', () => {
    const msg = message()
    Object.defineProperties(msg, { text: { value: '' }, media: { value: { type: 'photo' } } })
    expect(mapMessage(msg).content.parts).toEqual([{ type: 'text', text: '\n[Telegram attachment: not supported yet]' }])
  })
  it('creates private storage and rejects public directories/symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-storage-'))
    try {
      const path = join(directory, 'private', 'session.sqlite')
      await prepareStorage(path)
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
      await symlink(path, join(directory, 'link'))
      await expect(prepareStorage(join(directory, 'link'))).rejects.toThrow()
      if (process.platform !== 'win32') {
        await chmod(join(directory, 'private'), 0o755)
        await expect(prepareStorage(path)).rejects.toThrow('0700')
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
