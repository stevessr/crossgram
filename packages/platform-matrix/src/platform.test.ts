import { describe, expect, it, vi } from 'vitest'
import { messageMentionsUser, type IMEvent, type PlatformSession } from '@mtproto-relay/bridge'
import { MatrixPlatform } from './index.js'
import type { MatrixRoomMessageContent, MatrixSyncResponse } from './types.js'

const session: PlatformSession = {
  platformSessionId: 'matrix-session',
  platformId: 'matrix',
  userId: '@me:example.org',
  credentials: {},
  metadata: {},
}

const roomState = [
  event('m.room.create', {}, { stateKey: '' }),
  event('m.room.name', { name: 'Team Room' }, { stateKey: '' }),
  event('m.room.avatar', { url: 'mxc://example.org/room-avatar' }, { stateKey: '' }),
  event('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, { stateKey: '' }),
  event('m.room.power_levels', {
    users: { '@admin:example.org': 100 }, users_default: 0, state_default: 50, redact: 50,
  }, { stateKey: '' }),
  event('m.room.member', {
    membership: 'join', displayname: 'Me', avatar_url: 'mxc://example.org/me-avatar',
  }, { stateKey: '@me:example.org', sender: '@me:example.org' }),
  event('m.room.member', {
    membership: 'join', displayname: 'Alice', avatar_url: 'mxc://example.org/alice-avatar',
  }, { stateKey: '@alice:example.org', sender: '@alice:example.org' }),
]

describe('MatrixPlatform', () => {
  it('maps account profiles, direct rooms, state, unread counts, and media timelines', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/account/whoami')) return json({ user_id: '@me:example.org' })
      if (url.pathname.includes('/profile/')) return json({
        displayname: 'Matrix Me', avatar_url: 'mxc://example.org/me-avatar',
      })
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1',
        account_data: { events: [{ type: 'm.direct', content: { '@alice:example.org': ['!room:example.org'] } }] },
        rooms: { join: {
          '!room:example.org': {
            state: { events: roomState },
            summary: { 'm.heroes': ['@alice:example.org'], 'm.joined_member_count': 2 },
            unread_notifications: { notification_count: 4 },
            timeline: { events: [event('m.room.message', {
              msgtype: 'm.image', body: 'photo.png', url: 'mxc://example.org/photo',
              info: { mimetype: 'image/png', size: 123, w: 640, h: 480 },
            }, { id: '$photo', sender: '@alice:example.org', ts: 2_000 })] },
          },
        } },
      } satisfies MatrixSyncResponse)
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)

    await expect(platform.getAccount()).resolves.toMatchObject({
      user: {
        id: '@me:example.org', firstName: 'Matrix Me', username: 'me',
        avatar: { locator: { mxc: 'mxc://example.org/me-avatar' } },
      },
    })
    const page = await platform.getDialogs(session)
    expect(page.total).toBe(1)
    expect(page.dialogs[0]).toMatchObject({
      unreadCount: 4,
      conversation: {
        id: '!room:example.org', kind: 'direct', title: 'Team Room',
        avatar: { locator: { mxc: 'mxc://example.org/room-avatar' } },
        metadata: { encrypted: true, participantsCount: 2 },
      },
      lastMessage: {
        id: '$photo', sender: { firstName: 'Alice' },
        content: { parts: [{ type: 'media', media: {
          kind: 'image', mimeType: 'image/png', width: 640, height: 480,
          locator: { mxc: 'mxc://example.org/photo' },
        } }] },
      },
    })
  })

  it('uses event context for anchored history and exposes encrypted placeholders', async () => {
    const paths: string[] = []
    const fetch = routeFetch((url) => {
      paths.push(`${url.pathname}${url.search}`)
      if (url.pathname.includes('/context/')) return json({ start: 'history-token', events_before: [] })
      if (url.pathname.endsWith('/messages')) return json({
        end: 'older-token',
        chunk: [
          event('m.room.encrypted', { algorithm: 'm.megolm.v1.aes-sha2' }, {
            id: '$encrypted', sender: '@alice:example.org', ts: 3_000,
          }),
          event('m.room.message', { msgtype: 'm.text', body: 'hello' }, {
            id: '$plain', sender: '@alice:example.org', ts: 2_000,
          }),
        ],
        state: roomState,
      })
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)

    const history = await platform.getHistory(session, { id: '!room:example.org' }, {
      before: { id: '$anchor', timestamp: 4 }, limit: 20,
    })
    expect(paths[0]).toContain('/context/%24anchor?limit=0')
    expect(paths[1]).toContain('from=history-token')
    expect(history.nextCursor).toBe('older-token')
    expect(history.messages).toHaveLength(2)
    expect(history.messages[0]).toMatchObject({
      id: '$encrypted', metadata: { matrixEncrypted: true },
      content: { parts: [{ type: 'text' }] },
    })
    expect(history.messages[1]?.content.parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('sends mixed content, reports upload progress, edits, redacts, marks read, and slices downloads', async () => {
    const requests: Array<{ path: string, method: string, body?: unknown }> = []
    let sent = 0
    const fetch = routeFetch(async (url, init) => {
      let body: unknown
      if (typeof init?.body === 'string') body = JSON.parse(init.body)
      else if (init?.body instanceof ReadableStream) {
        body = Array.from(new Uint8Array(await new Response(init.body).arrayBuffer()))
      }
      else if (init?.body instanceof Uint8Array) body = Array.from(init.body as Uint8Array)
      requests.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', body })
      if (url.pathname.endsWith('/upload')) return json({ content_uri: 'mxc://example.org/uploaded' })
      if (url.pathname.includes('/send/')) return json({ event_id: `$sent-${++sent}` })
      if (url.pathname.includes('/redact/')) return json({ event_id: '$redaction' })
      if (url.pathname.endsWith('/read_markers')) return json({})
      if (url.pathname.includes('/download/')) return new Response(new Uint8Array([1, 2, 3, 4, 5]))
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    const progress: number[] = []
    const message = await platform.sendMessage(session, { id: '!room:example.org' }, {
      replyToId: '$reply',
      parts: [
        { type: 'text', text: 'caption' },
        {
          type: 'media',
          media: {
            kind: 'file', name: 'report.txt', mimeType: 'text/plain', size: 3,
            source: { size: 3, async *stream() { yield new Uint8Array([7]); yield new Uint8Array([8, 9]) } },
          },
        },
      ],
    }, { onProgress: (value) => { progress.push(value.transferredBytes) } })

    expect(message).toMatchObject({ id: '$sent-1', sourceIds: ['$sent-1', '$sent-2'], outgoing: true })
    expect(progress).toEqual([1, 3])
    const sendBodies = requests.filter((request) => request.path.includes('/send/')).map((request) => request.body)
    expect(sendBodies[0]).toMatchObject({
      msgtype: 'm.text', body: 'caption', 'm.relates_to': { 'm.in_reply_to': { event_id: '$reply' } },
    })
    expect(sendBodies[1]).toMatchObject({
      msgtype: 'm.file', body: 'report.txt', url: 'mxc://example.org/uploaded', info: { size: 3 },
    })

    const edited = await platform.editMessage(session, {
      conversationId: '!room:example.org', messageId: '$logical', targetId: '$physical',
    }, { parts: [{ type: 'text', text: 'edited' }] })
    expect(edited.id).toBe('$logical')
    expect(requests.find((request) => request.path.includes('/send/') &&
      (request.body as { 'm.relates_to'?: { rel_type?: string } } | undefined)
        ?.['m.relates_to']?.rel_type === 'm.replace')?.body).toMatchObject({
        'm.new_content': { body: 'edited' }, 'm.relates_to': { event_id: '$physical' },
      })

    await platform.deleteMessages(session, { id: '!room:example.org' }, ['$one', '$one', '$two'])
    await platform.markRead(session, { conversationId: '!room:example.org', messageId: '$two' })
    expect(requests.filter((request) => request.path.includes('/redact/'))).toHaveLength(2)
    expect(requests.find((request) => request.path.endsWith('/read_markers'))?.body)
      .toEqual({ 'm.fully_read': '$two', 'm.read': '$two' })

    const chunks: number[] = []
    for await (const chunk of platform.downloadMedia(session, {
      id: 'media', kind: 'file', size: 5, locator: { mxc: 'mxc://example.org/file' },
    }, { offset: 1, limit: 3 })) chunks.push(...chunk)
    expect(chunks).toEqual([2, 3, 4])
  })

  it('sends mention metadata over Matrix HTTP, preserves edits, and reads notification targets', async () => {
    const outgoing: MatrixRoomMessageContent[] = []
    const fetch = routeFetch((url, init) => {
      if (url.pathname.includes('/send/m.room.message/')) {
        outgoing.push(JSON.parse(String(init?.body)) as MatrixRoomMessageContent)
        return json({ event_id: '$sent-' + outgoing.length })
      }
      if (url.pathname.endsWith('/messages')) return json({
        end: 'next', chunk: [
          event('m.room.message', {
            msgtype: 'm.text', body: 'hi 👋 @Alice',
            format: 'org.matrix.custom.html',
            formatted_body: 'hi 👋 <a href="https://matrix.to/#/%40alice%3Aexample.org">@Alice</a>',
            'm.mentions': { user_ids: ['@alice:example.org', '@me:example.org'] },
          }, { id: '$incoming', sender: '@bob:example.org', ts: 3_000 }),
          event('m.room.message', {
            msgtype: 'm.text', body: 'plain @Alice',
          }, { id: '$no-mentions', sender: '@bob:example.org', ts: 2_000 }),
        ],
      })
      throw new Error('unexpected request: ' + url)
    })
    const platform = createPlatform(fetch)
    const body = 'hi 👋 @Alice'
    const mention = {
      type: 'mention' as const, offset: body.indexOf('@Alice'), length: 6,
      userId: '@alice:example.org',
    }
    await platform.sendMessage(session, { id: '!room:example.org' }, {
      replyToId: '$reply',
      parts: [{ type: 'text', text: body, entities: [mention] }],
    })
    expect(outgoing[0]).toMatchObject({
      body,
      format: 'org.matrix.custom.html',
      'm.mentions': { user_ids: ['@alice:example.org'] },
      'm.relates_to': { 'm.in_reply_to': { event_id: '$reply' } },
    })
    expect(outgoing[0]?.formatted_body).toContain('matrix.to/#/%40alice%3Aexample.org')

    await platform.editMessage(session, {
      conversationId: '!room:example.org', messageId: '$original', targetId: '$original',
    }, { parts: [{ type: 'text', text: body, entities: [mention] }] })
    expect(outgoing[1]).toMatchObject({
      body: '* ' + body,
      'm.mentions': { user_ids: ['@alice:example.org'] },
      'm.new_content': {
        body, 'm.mentions': { user_ids: ['@alice:example.org'] },
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$original' },
    })

    const history = await platform.getHistory(session, { id: '!room:example.org' })
    expect(history.messages[0]?.content.parts).toEqual([{
      type: 'text', text: body, entities: [mention],
    }])
    expect(history.messages[0]?.metadata).toEqual({
      matrixMentions: ['@alice:example.org', '@me:example.org'],
    })
    expect(messageMentionsUser(history.messages[0]!, '@me:example.org')).toBe(true)
    expect(history.messages[1]?.content.parts).toEqual([{ type: 'text', text: 'plain @Alice' }])
    expect(messageMentionsUser(history.messages[1]!, '@alice:example.org')).toBe(false)
  })

  it('maps members and Matrix power levels to bridge roles and permissions', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/members')) return json({ chunk: roomState.filter((item) => item.type === 'm.room.member') })
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { join: { '!room:example.org': { state: { events: roomState } } } },
      })
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    await platform.getDialogs(session)
    const members = await platform.getConversationMembers(session, { id: '!room:example.org' })
    expect((await platform.getDialogs(session)).dialogs[0]?.conversation.selfPermissions?.pinMessages).toBe(false)

    expect(members.total).toBe(2)
    expect(members.members.find((item) => item.user.id === '@alice:example.org')).toMatchObject({
      role: 'member', permissions: { inviteMembers: true, deleteAnyMessage: false },
    })
  })

  it('treats missing Matrix messages as absent but propagates permission errors', async () => {
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/event/%24missing')) {
        return json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
      }
      if (url.pathname.endsWith('/event/%24forbidden')) {
        return json({ errcode: 'M_FORBIDDEN' }, { status: 403 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    await expect(platform.getMessage(session, { id: '!room:example.org' }, '$missing'))
      .resolves.toBeNull()
    await expect(platform.getMessage(session, { id: '!room:example.org' }, '$forbidden'))
      .rejects.toMatchObject({ status: 403, errcode: 'M_FORBIDDEN' })
  })

  it('pins and unpins Matrix events without losing other pins in concurrent writes', async () => {
    let pinned: string[] = []
    let muted = false
    const requests: string[] = []
    const fetch = routeFetch(async (url, init) => {
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url.pathname}`)
      if (url.pathname.endsWith('/state/m.room.pinned_events')) {
        if (method === 'GET') return json({ pinned })
        pinned = (JSON.parse(init?.body as string) as { pinned: string[] }).pinned
        return json({ event_id: '$pins' })
      }
      if (url.pathname.includes('/pushrules/global/room/')) {
        if (method === 'GET') return muted
          ? json({ actions: ['dont_notify'], enabled: true })
          : json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
        muted = method === 'PUT'
        return json({})
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    const conversation = { id: '!room:example.org' }
    expect(platform.capabilities.messageActions?.pin).toEqual({ read: true, write: true })
    expect(platform.capabilities.notifications).toEqual({ read: true, mute: true })

    await Promise.all([
      platform.setMessagePinned(session, conversation, '$one', true),
      platform.setMessagePinned(session, conversation, '$two', true),
    ])
    expect(await platform.getPinnedMessageIds(session, conversation)).toEqual(['$one', '$two'])
    await platform.setMessagePinned(session, conversation, '$one', true)
    expect(requests.filter((request) => request.startsWith('PUT ') && request.includes('/state/')))
      .toHaveLength(2)
    await platform.setMessagePinned(session, conversation, '$one', false)
    expect(await platform.getPinnedMessageIds(session, conversation)).toEqual(['$two'])
    await Promise.all([
      platform.clearPinnedMessages(session, conversation),
      platform.setMessagePinned(session, conversation, '$after-clear', true),
    ])
    expect(await platform.getPinnedMessageIds(session, conversation)).toEqual(['$after-clear'])
    const writesBefore = requests.filter((request) =>
      request.startsWith('PUT ') && request.includes('/state/')).length
    await platform.clearPinnedMessages(session, conversation)
    await platform.clearPinnedMessages(session, conversation)
    expect(await platform.getPinnedMessageIds(session, conversation)).toEqual([])
    expect(requests.filter((request) =>
      request.startsWith('PUT ') && request.includes('/state/'))).toHaveLength(writesBefore + 1)

    await platform.setConversationNotificationSettings(session, conversation, { muted: true })
    expect(await platform.getConversationNotificationSettings(session, conversation))
      .toEqual({ muted: true })
    await platform.setConversationNotificationSettings(session, conversation, { muted: false })
    expect(await platform.getConversationNotificationSettings(session, conversation))
      .toEqual({ muted: false })
  })

  it('streams external pins and echoes local Matrix state IDs for durable deduplication', async () => {
    const roomId = '!room:example.org'
    let sync = 0
    let nativePins = ['$one']
    let releaseEcho!: (response: Response) => void
    const echo = new Promise<Response>((resolve) => { releaseEcho = resolve })
    const state = (pinned: string[], id: string) =>
      event('m.room.pinned_events', { pinned }, { id, stateKey: '', ts: 1_000 * sync })
    const roomSync = (next: string, pinned: string[], id: string) => json({
      next_batch: next,
      rooms: { join: { [roomId]: { state: { events: [state(pinned, id)] } } } },
    })
    const fetch = routeFetch((url, init) => {
      if (url.pathname.endsWith('/sync')) {
        sync++
        if (sync === 1) return json({
          next_batch: 's1', rooms: { join: { [roomId]: {
            state: { events: [...roomState, state(['$one'], '$initial')] },
          } } },
        })
        if (sync === 2) {
          nativePins = ['$one', '$two']
          return roomSync('s2', nativePins, '$external-add')
        }
        if (sync === 3) {
          nativePins = ['$two', '$one']
          return roomSync('s3', nativePins, '$external-order')
        }
        if (sync === 4) {
          nativePins = ['$two']
          return roomSync('s4', nativePins, '$external-remove')
        }
        if (sync === 5) return echo
        return pendingUntilAbort(init?.signal)
      }
      if (url.pathname.endsWith('/state/m.room.pinned_events')) {
        if (init?.method === 'PUT') {
          nativePins = (JSON.parse(String(init.body)) as { pinned: string[] }).pinned
          return json({ event_id: '$local' })
        }
        return json({ pinned: nativePins })
      }
      throw new Error(`unexpected Matrix HTTP call: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: session.userId, syncTimeoutMs: 50 })
    const observed: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { observed.push(value) })
    await vi.waitFor(() => expect(observed.filter((item) => item.type === 'message-pins')).toHaveLength(3))
    const pins = observed.filter((item): item is Extract<IMEvent, { type: 'message-pins' }> =>
      item.type === 'message-pins')
    expect(pins.map((item) => ({
      eventId: item.eventId,
      pinned: item.pinnedMessageIds,
      removed: item.removedMessageIds,
    }))).toEqual([
      { eventId: '$external-add', pinned: ['$one', '$two'], removed: [] },
      { eventId: '$external-order', pinned: ['$two', '$one'], removed: [] },
      { eventId: '$external-remove', pinned: ['$two'], removed: ['$one'] },
    ])

    const mutation = await platform.setMessagePinned(session, { id: roomId }, '$self', true)
    expect(mutation).toEqual({
      changed: true, eventId: '$local', pinnedMessageIds: ['$two', '$self'],
    })
    // A redundant write never allocates a second Matrix state event or PTS.
    await expect(platform.setMessagePinned(session, { id: roomId }, '$self', true))
      .resolves.toEqual({ changed: false, pinnedMessageIds: ['$two', '$self'] })
    expect(nativePins).toEqual(['$two', '$self'])
    releaseEcho(roomSync('s5', nativePins, '$local'))
    await vi.waitFor(() =>
      expect(observed.filter((item) => item.type === 'message-pins')).toHaveLength(4))
    await unsubscribe()
    expect(observed.at(-1)).toMatchObject({
      type: 'message-pins', eventId: '$local',
      pinnedMessageIds: ['$two', '$self'], removedMessageIds: [],
    })
  })

  it('retries a rejected pin event without advancing the Matrix sync token or snapshot', async () => {
    const roomId = '!room:example.org'
    const requestedTokens: Array<string | null> = []
    const fetch = routeFetch((url, init) => {
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      requestedTokens.push(url.searchParams.get('since'))
      if (requestedTokens.length === 1) {
        return json({ next_batch: 'start', rooms: { join: {
          [roomId]: { state: { events: [
            ...roomState,
            event('m.room.pinned_events', { pinned: ['$old'] }, { id: '$initial', stateKey: '' }),
          ] },
        } } })
      }
      if (url.searchParams.get('since') === 'start') {
        return json({ next_batch: 'advance', rooms: { join: {
          [roomId]: { state: { events: [
            event('m.room.pinned_events', { pinned: ['$new'] }, {
              id: '$retry-pin', stateKey: '', ts: 2_000,
            }),
          ] },
        } } })
      }
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: session.userId, syncTimeoutMs: 50 })
    const delivered: Array<Extract<IMEvent, { type: 'message-pins' }>> = []
    const unsubscribe = await platform.subscribe(session, async (value) => {
      if (value.type !== 'message-pins') return
      delivered.push(value)
      if (delivered.length === 1) throw new Error('temporary delivery failure')
    })
    await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 4_000 })
    await unsubscribe()
    expect(requestedTokens.slice(0, 3)).toEqual([null, 'start', 'start'])
    expect(delivered[0]).toMatchObject({
      eventId: '$retry-pin', pinnedMessageIds: ['$new'], removedMessageIds: ['$old'],
    })
    expect(delivered[1]).toEqual(delivered[0])
  })

  it('subscribes from an initial token and emits messages, edits, redactions, receipts, and conversation changes', async () => {
    let sync = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      sync++
      if (sync === 1) return json({
        next_batch: 's0', rooms: { join: { '!room:example.org': { state: { events: roomState } } } },
      })
      if (sync === 2) {
        expect(url.searchParams.get('since')).toBe('s0')
        return json({
          next_batch: 's1', rooms: { join: { '!room:example.org': {
            state: { events: [event('m.room.name', { name: 'Renamed' }, { stateKey: '' })] },
            timeline: { events: [
              event('m.room.message', { msgtype: 'm.text', body: 'new' }, {
                id: '$new', sender: '@alice:example.org', ts: 10_000,
              }),
              event('m.room.message', {
                msgtype: 'm.text', body: '* fixed',
                'm.new_content': { msgtype: 'm.text', body: 'fixed' },
                'm.relates_to': { rel_type: 'm.replace', event_id: '$new' },
              }, { id: '$edit', sender: '@alice:example.org', ts: 11_000 }),
              event('m.room.redaction', {}, { id: '$redact', sender: '@me:example.org', ts: 12_000, redacts: '$old' }),
            ] },
            ephemeral: { events: [{
              type: 'm.receipt', content: { '$new': { 'm.read': { '@me:example.org': { ts: 13_000 } } } },
            }] },
          } } },
        })
      }
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { syncTimeoutMs: 50, userId: '@me:example.org' })
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { events.push(value) })
    await vi.waitFor(() => expect(events).toHaveLength(5))
    await unsubscribe()

    expect(events.map((value) => value.type)).toEqual([
      'conversation', 'message', 'message-edit', 'message-delete', 'read',
    ])
    expect(events[0]).toMatchObject({ conversation: { title: 'Renamed' } })
    expect(events[2]).toMatchObject({ eventId: '$edit', message: { id: '$new', content: { parts: [{ text: 'fixed' }] } } })
    expect(events[3]).toMatchObject({ messageIds: ['$old'] })
    expect(events[4]).toMatchObject({ upToMessageId: '$new' })
  })
})

function createPlatform(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return new MatrixPlatform({
    homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    ...extra,
  })
}

function event(
  type: string,
  content: Record<string, unknown>,
  options: { id?: string, sender?: string, ts?: number, stateKey?: string, redacts?: string } = {},
) {
  return {
    type,
    content,
    event_id: options.id,
    sender: options.sender,
    origin_server_ts: options.ts,
    state_key: options.stateKey,
    redacts: options.redacts,
  }
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init)
}

function routeFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => handler(new URL(String(input)), init)
}

function pendingUntilAbort(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
