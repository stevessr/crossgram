import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '@satorijs/core'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { SatoriPlatform } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'session', platformId: 'satori', userId: 'self', credentials: {}, metadata: {},
}

function makeBot(): Bot {
  return {
    sid: 'mock:self', selfId: 'self', userId: 'self', platform: 'mock',
    user: { id: 'self', name: 'Mock Account' },
    features: [
      'message.create', 'message.list', 'message.get', 'message.update', 'message.delete',
      'guild.list', 'channel.list', 'friend.list', 'guild.member.list', 'user.get',
    ],
    getLogin: vi.fn(async () => ({
      sn: 1, adapter: 'mock', platform: 'mock', status: 1, features: [],
      user: { id: 'self', name: 'Mock Account' },
    })),
    getGuildList: vi.fn(async () => ({
      data: [{ id: 'guild', name: 'Guild' }], next: undefined,
    })),
    getChannelList: vi.fn(async () => ({
      data: [
        { id: 'general', type: 0, name: 'General' },
        { id: 'voice', type: 3, name: 'Voice' },
      ],
    })),
    getFriendList: vi.fn(async () => ({ data: [{ user: { id: 'alice', name: 'Alice' } }] })),
    getMessageList: vi.fn(async () => ({
      data: [{ id: 'm1', channel: { id: 'general', type: 0 }, user: { id: 'alice' }, content: 'hello' }],
      next: 'history-next',
    })),
    getMessage: vi.fn(async (channelId: string, id: string) => ({
      id, channel: { id: channelId, type: 0 }, user: { id: 'alice' }, content: 'one',
    })),
    createMessage: vi.fn(async (channelId: string) => ([{
      id: 'sent', channel: { id: channelId, type: 0 }, user: { id: 'self' }, content: 'sent',
    }])),
    createUpload: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(),
  } as unknown as Bot
}

function context(bot: Bot) {
  return {
    bots: [bot],
    logger: () => ({ warn: vi.fn() }),
    on: vi.fn(() => vi.fn()),
    http: { file: vi.fn() },
  } as never
}

describe('SatoriPlatform', () => {
  it('projects one imported bot into account, dialogs, contacts, history, and actions', async () => {
    const bot = makeBot()
    const platform = new SatoriPlatform(context(bot), 'mock:self')

    await expect(platform.getAccount()).resolves.toMatchObject({
      user: { id: 'self', firstName: 'Mock Account' },
      credentials: { satoriBotSid: 'mock:self' },
    })
    expect(platform.capabilities).toMatchObject({
      history: true,
      messageActions: { delete: { own: { supported: true } }, edit: { mode: 'native' } },
    })
    await expect(platform.getDialogs(session)).resolves.toMatchObject({
      dialogs: [{ conversation: { id: 'general', kind: 'channel', title: 'General', spaceId: 'guild' } }],
    })
    await expect(platform.getContacts(session)).resolves.toMatchObject({
      users: [{ id: 'alice', firstName: 'Alice' }],
    })
    await expect(platform.getHistory(session, { id: 'general' }, { limit: 20 })).resolves.toMatchObject({
      messages: [{ id: 'm1', conversationId: 'general', senderId: 'alice' }],
      nextCursor: 'history-next',
    })
    await expect(platform.sendMessage(session, { id: 'general' }, {
      parts: [{ type: 'text', text: 'sent' }],
    })).resolves.toMatchObject({ id: 'sent', outgoing: true, sourceIds: ['sent'] })
    await platform.editMessage(session, {
      conversationId: 'general', messageId: 'm1', targetId: 'm1',
    }, { parts: [{ type: 'text', text: 'edited' }] })
    await platform.deleteMessages(session, { id: 'general' }, ['m1', 'm2'])
    expect(bot.editMessage).toHaveBeenCalledOnce()
    expect(bot.deleteMessage).toHaveBeenCalledTimes(2)
  })

  it('paginates a large channel page across guilds without skipping entries', async () => {
    const bot = makeBot()
    vi.mocked(bot.getGuildList!).mockResolvedValue({
      data: [{ id: 'guild-a', name: 'A' }, { id: 'guild-b', name: 'B' }],
    } as never)
    vi.mocked(bot.getChannelList!).mockImplementation(async (guildId) => ({
      data: Array.from({ length: guildId === 'guild-a' ? 45 : 3 }, (_, index) => ({
        id: `${guildId}-${index}`, type: 0, name: `Channel ${index}`,
      })),
    }) as never)
    const platform = new SatoriPlatform(context(bot), 'mock:self')
    const received: string[] = []
    let cursor: string | undefined
    do {
      const page = await platform.getDialogs(session, { cursor, limit: 16 })
      received.push(...page.dialogs.map((dialog) => dialog.conversation.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(received).toEqual([
      ...Array.from({ length: 45 }, (_, index) => `guild-a-${index}`),
      ...Array.from({ length: 3 }, (_, index) => `guild-b-${index}`),
    ])
    expect(bot.getChannelList).toHaveBeenCalledTimes(2)
  })

  it('retains only the most recent conversation metadata without losing hot entries', () => {
    const platform = new SatoriPlatform(context(makeBot()), 'mock:self')
    const internal = platform as any
    for (let i = 0; i < 4_096; i++) {
      internal.remember({ id: `channel-${i}`, kind: 'channel', title: `Channel ${i}` })
    }
    internal.remember({ id: 'channel-0', kind: 'channel', title: 'Recently active' })
    internal.remember({ id: 'new-channel', kind: 'group', title: 'Newest' })
    expect(internal.conversations.size).toBe(4_096)
    expect(internal.conversations.has('channel-0')).toBe(true)
    expect(internal.conversations.get('channel-0').title).toBe('Recently active')
    expect(internal.conversations.has('channel-1')).toBe(false)
    expect(internal.conversations.has('new-channel')).toBe(true)
  })

  it('serializes a burst with one drain and finishes accepted events before unsubscribe', async () => {
    const bot = makeBot()
    const listeners = new Map<string, (event: unknown) => void>()
    const ctx = context(bot) as any
    ctx.on = vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener)
      return () => listeners.delete(type)
    })
    const platform = new SatoriPlatform(ctx, 'mock:self')
    const delivered: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const unsubscribe = await platform.subscribe(session, async (event) => {
      if (!delivered.length) await gate
      if (event.type === 'message') delivered.push(event.message.id)
    })
    const listener = listeners.get('message-created')!
    for (let index = 0; index < 750; index++) {
      listener({
        bot, selfId: 'self', sn: index + 1, timestamp: 1_800_000_000_000,
        event: {
          channel: { id: 'general', type: 0, name: 'General' },
          message: { id: `m-${index}`, content: 'hello', user: { id: 'alice' } },
        },
      })
    }
    const closing = unsubscribe()
    release()
    await closing
    expect(delivered).toHaveLength(750)
    expect(delivered[0]).toBe('m-0')
    expect(delivered.at(-1)).toBe('m-749')
    expect(listeners.size).toBe(0)
  })

  it('requires an explicit SID when more than one imported bot exists', () => {
    const first = makeBot()
    const second = { ...makeBot(), sid: 'mock:second' } as Bot
    const platform = new SatoriPlatform(context(first))
    ;(platform as any).ctx.bots.push(second)
    expect(() => platform.requireBot()).toThrow(/exactly one bot.*mock:self, mock:second/)
  })
})
