import { describe, expect, it } from 'vitest'
import { OneBotClient, type OneBotSocket } from './client.js'
import { OneBotPlatform } from './index.js'
import {
  mapOneBotMessage, normalizeSegments, parseConversationId, toOneBotSegments,
} from './protocol.js'

class MockOneBotSocket implements OneBotSocket {
  readyState = 0
  sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, Array<(event: any) => void>>()
  constructor(private readonly responses: Record<string, unknown> = {}) {
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open', {})
    })
  }
  addEventListener(name: 'open' | 'message' | 'close' | 'error', cb: (event: any) => void) {
    const current = this.listeners.get(name) ?? []
    current.push(cb)
    this.listeners.set(name, current)
  }
  emit(name: string, event: any) {
    for (const callback of this.listeners.get(name) ?? []) callback(event)
  }
  push(event: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(event) })
  }
  send(body: string) {
    const action = JSON.parse(body)
    this.sent.push(action)
    if (!(action.action in this.responses)) return
    queueMicrotask(() => this.push({
      status: 'ok', retcode: 0, data: this.responses[action.action], echo: action.echo,
    }))
  }
  close() {
    this.readyState = 3
    this.emit('close', {})
  }
}

const responses = {
  get_login_info: { user_id: 10001, nickname: 'Me' },
  get_friend_list: [
    { user_id: 20002, nickname: 'Alice', remark: 'A' },
    { user_id: 20003, nickname: 'Bob' },
  ],
  get_group_list: [{ group_id: 30003, group_name: 'Test Group' }],
  get_group_member_list: [
    { user_id: 10001, nickname: 'Me', role: 'owner' },
    { user_id: 20002, nickname: 'Alice', role: 'member' },
  ],
  get_msg: { message_id: 42, user_id: 20002, message_type: 'private', time: 1_700_000_000,
    sender: { user_id: 20002, nickname: 'Alice' }, message: [{ type: 'text', data: { text: 'hello' } }] },
  send_private_msg: { message_id: 42 },
  send_group_msg: { message_id: 43 },
  delete_msg: null,
  set_friend_add_request: null,
  set_group_add_request: null,
}
function mockPlatform() {
  const socket = new MockOneBotSocket(responses)
  const platform = new OneBotPlatform({
    endpoint: 'ws://localhost:3001',
    socketFactory: () => socket,
  })
  return { platform, socket }
}

describe('OneBot V11 protocol', () => {
  it('parses array and escaped CQ-string segments without misinterpreting literals', () => {
    expect(normalizeSegments('Hello&#91;x&#93;[CQ:at,qq=123] &amp; [CQ:image,file=a&#44;b]'))
      .toEqual([
        { type: 'text', data: { text: 'Hello[x]' } },
        { type: 'at', data: { qq: '123' } },
        { type: 'text', data: { text: ' & ' } },
        { type: 'image', data: { file: 'a,b' } },
      ])
    expect(normalizeSegments([{ type: 'text', data: { text: 'hello' } }]))
      .toEqual([{ type: 'text', data: { text: 'hello' } }])
  })

  it('separates private and group IDs and rejects invalid input', () => {
    expect(parseConversationId('group:123')).toEqual({ kind: 'group', id: '123' })
    expect(parseConversationId('private:123')).toEqual({ kind: 'private', id: '123' })
    expect(() => parseConversationId('group:../1')).toThrow('Invalid OneBot')
  })

  it('converts reply and mention text, preserving surrounding text', async () => {
    expect(await toOneBotSegments({
      replyToId: '42',
      parts: [{ type: 'text', text: 'Hello @Alice!', entities: [{
        type: 'mention', offset: 6, length: 6, userId: '20002',
      }] }],
    })).toEqual([
      { type: 'reply', data: { id: '42' } },
      { type: 'text', data: { text: 'Hello ' } },
      { type: 'at', data: { qq: '20002' } },
      { type: 'text', data: { text: '!' } },
    ])
  })

  it('extracts voice and image parts from CQ messages', () => {
    const mapped = mapOneBotMessage({
      message_id: 7, time: 100, user_id: 2, sender: { user_id: 2, nickname: 'Alice' },
      message: '[CQ:reply,id=6]hi[CQ:record,file=voice.silk,url=https://example.org/voice]',
    }, { id: 'private:2', kind: 'direct', title: 'Alice' }, '1')
    expect(mapped.replyToId).toBe('6')
    expect(mapped.content.parts).toMatchObject([
      { type: 'text', text: 'hi' },
      { type: 'media', media: { kind: 'file', voice: true, locator: { url: 'https://example.org/voice' } } },
    ])
  })

  it('rejects oversized inline image uploads', async () => {
    await expect(toOneBotSegments({ parts: [{
      type: 'media',
      media: {
        kind: 'image', source: { async *stream() { yield new Uint8Array(10 * 1024 * 1024 + 1) } },
      },
    }] })).rejects.toThrow('10 MiB')
  })
})

describe('OneBot V11 transport and platform integration', () => {
  it('correlates action echoes and authenticates a forward WS endpoint', async () => {
    const urls: string[] = []
    const socket = new MockOneBotSocket(responses)
    const client = new OneBotClient({
      endpoint: 'ws://localhost:3001/v11',
      accessToken: 'test-token',
      socketFactory: (url) => { urls.push(url); return socket },
    })
    expect(await client.call('get_login_info')).toMatchObject({ user_id: 10001 })
    expect(urls[0]).toContain('access_token=test-token')
    expect(socket.sent[0]).toMatchObject({ action: 'get_login_info', echo: 'crossgram-1' })
    client.stop()
  })

  it('loads account and paginated directory through action messages', async () => {
    const { platform, socket } = mockPlatform()
    expect((await platform.getAccount()).user).toMatchObject({ id: '10001', firstName: 'Me' })
    const first = await platform.getDialogs({} as never, { limit: 2 })
    expect(first.dialogs.map((x) => x.conversation.id)).toEqual(['private:20002', 'private:20003'])
    expect(first.nextCursor).toBe('2')
    const second = await platform.getDialogs({} as never, { cursor: first.nextCursor })
    expect(second.dialogs[0]?.conversation).toMatchObject({ id: 'group:30003', title: 'Test Group' })
    expect((await platform.getConversationMembers({} as never, { id: 'group:30003' })).members)
      .toMatchObject([{ role: 'owner' }, { role: 'member' }])
    expect(socket.sent.filter((x) => x.action === 'get_friend_list')).toHaveLength(1)
    platform.stop()
  })

  it('maps incoming messages, recalls and requests; sends actions in the proper chat', async () => {
    const { platform, socket } = mockPlatform()
    await platform.getAccount()
    const events: Array<{ type: string }> = []
    const unsubscribe = await platform.subscribe({} as never, (event) => { events.push(event) })
    socket.push({
      post_type: 'message', message_type: 'group', group_id: 30003, user_id: 20002,
      message_id: 50, time: 100, sender: { user_id: 20002, nickname: 'Alice' },
      message: '[CQ:at,qq=10001] hi',
    })
    socket.push({ post_type: 'notice', notice_type: 'group_recall', group_id: 30003, message_id: 50, time: 101 })
    socket.push({ post_type: 'request', request_type: 'friend', flag: 'abc', user_id: 20002, comment: 'hi' })
    expect(events.map((x) => x.type)).toEqual(['message', 'message-delete', 'request'])
    expect(await platform.getRequests({} as never)).toMatchObject({
      requests: [{ id: 'friend:abc', kind: 'friend', state: 'pending' }],
    })
    await platform.resolveRequest({} as never, 'friend:abc', 'accept')
    await platform.sendMessage({} as never, { id: 'private:20002' }, { parts: [{ type: 'text', text: 'hello' }] })
    await platform.deleteMessages({} as never, { id: 'group:30003' }, ['50'])
    expect(socket.sent.filter((x) => x.action === 'send_private_msg')[0]?.params)
      .toMatchObject({ user_id: 20002, message: [{ type: 'text', data: { text: 'hello' } }] })
    expect(socket.sent.some((x) => x.action === 'delete_msg')).toBe(true)
    expect(socket.sent.some((x) => x.action === 'set_friend_add_request')).toBe(true)
    await unsubscribe()
    platform.stop()
  })

  it('fails timed-out API calls and stops pending actions after disconnect', async () => {
    const socket = new MockOneBotSocket()
    const client = new OneBotClient({ endpoint: 'ws://localhost:3001', socketFactory: () => socket, requestTimeoutMs: 100 })
    await expect(client.call('get_missing')).rejects.toThrow('timed out')
    const pending = client.call('get_later')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(socket.sent).toHaveLength(2)
    socket.close()
    await expect(pending).rejects.toThrow('closed')
    client.stop()
  })
})
