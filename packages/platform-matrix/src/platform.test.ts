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
  it('reads and synchronizes Matrix annotation reactions using the typed relations endpoint', async () => {
    const calls: string[] = []
    const fetch = routeFetch((url, init) => {
      calls.push(`${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/account/whoami')) return json({ user_id: '@me:example.org' })
      if (url.pathname.endsWith('/m.annotation')) return json({ chunk: [
        event('m.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$target', key: '🔥' } }, { id: '$reaction', sender: '@alice:example.org', ts: 5_000 }),
      ] })
      if (url.pathname.includes('/send/m.reaction/')) return json({ event_id: '$mine' })
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    const context = await platform.getMessageReactions(session, { conversationId: '!room:example.org', messageId: '$target', targetId: '$target' })
    expect(context.reactions).toMatchObject([{ key: '🔥', count: 1, selected: false }])
    expect(calls.find((call) => call.includes('/relations/'))).toContain('/relations/%24target/m.annotation?')
    await platform.setMessageReactions(session, { conversationId: '!room:example.org', messageId: '$target', targetId: '$target' }, ['🔥'])
    expect(calls.some((call) => call.includes('/send/m.reaction/'))).toBe(true)
    await platform.stop()
  })

  it('fails closed for encrypted rooms before media upload, text, edit, reaction and poll writes', async () => {
    const paths: string[] = []
    let streamed = false
    const encrypted = event('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, { stateKey: '' })
    const fetch = routeFetch((url) => {
      paths.push(url.pathname)
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 'stale', rooms: { join: { '!room:example.org': { state: { events: [] } } },
        },
      })
      throw new Error('unexpected request: ' + url)
    }, () => json([encrypted]))
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    // The last /sync snapshot was unencrypted, but the live room state has changed.
    await platform.getDialogs(session)
    const conversation = { id: '!room:example.org' }
    const encryptedError = /end-to-end encrypted/
    await expect(platform.sendMessage(session, conversation, {
      parts: [{ type: 'text', text: 'secret' }],
    })).rejects.toThrow(encryptedError)
    await expect(platform.sendMessage(session, conversation, {
      parts: [{ type: 'media', media: {
        kind: 'file', name: 'secret.txt', mimeType: 'text/plain', size: 1,
        source: { size: 1, async *stream() { streamed = true; yield new Uint8Array([1]) } },
      } }],
    })).rejects.toThrow(encryptedError)
    await expect(platform.editMessage(session, {
      conversationId: conversation.id, messageId: '$old', targetId: '$old',
    }, { parts: [{ type: 'text', text: 'replacement' }] })).rejects.toThrow(encryptedError)
    await expect(platform.setMessageReactions(session, {
      conversationId: conversation.id, messageId: '$old', targetId: '$old',
    }, ['👍'])).rejects.toThrow(encryptedError)
    await expect(platform.clickInlineButton(session, {
      conversationId: conversation.id, messageId: '$poll',
    }, { type: 'callback', text: 'Vote', data: 'matrix-poll-vote:0' })).rejects.toThrow(encryptedError)
    expect(streamed).toBe(false)
    expect(paths).toEqual(['/_matrix/client/v3/sync'])
  })

  it('does not downgrade to plaintext when room-state verification fails or is malformed', async () => {
    const attempts: string[] = []
    let response: Response = json({ errcode: 'M_UNAVAILABLE' }, { status: 503 })
    const fetch = routeFetch((url) => {
      attempts.push(url.pathname)
      if (url.pathname.includes('/send/')) return json({ event_id: '$sent' })
      throw new Error('unexpected request: ' + url)
    }, () => response)
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const send = () => platform.sendMessage(session, { id: '!room:example.org' }, {
      parts: [{ type: 'text', text: 'normal room message' }],
    })
    await expect(send()).rejects.toThrow(/Cannot verify Matrix room encryption state/)
    response = json({ malformed: true })
    await expect(send()).rejects.toThrow(/Cannot verify Matrix room encryption state/)
    expect(attempts).toEqual([])
    response = json([])
    await expect(send()).resolves.toMatchObject({ sourceIds: ['$sent'] })
    expect(attempts).toEqual([expect.stringContaining('/send/')])
  })

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
      if (url.pathname.includes('/event/')) return json({ type: 'm.room.message', content: { msgtype: 'm.file', body: 'original.txt', url: 'mxc://example.org/original', filename: 'original.txt', info: { mimetype: 'text/plain', size: 9 } } })
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
        'm.new_content': { msgtype: 'm.file', body: 'edited', url: 'mxc://example.org/original', filename: 'original.txt' },
        'm.relates_to': { event_id: '$physical' },
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
      if (url.pathname.includes('/event/')) return json({ type: 'm.room.message', content: { msgtype: 'm.text', body: 'before' } })
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

  it('keeps joined-member totals incrementally without scanning all room state on message projection', () => {
    const platform = createPlatform(routeFetch(() => { throw new Error('unexpected request') }), {
      userId: '@me:example.org',
    })
    const room = '!large:example.org'
    const internal = platform as any
    const memberEvents = Array.from({ length: 1_205 }, (_, index) =>
      event('m.room.member', { membership: 'join', displayname: `User ${index}` }, {
        stateKey: `@user-${index}:example.org`,
      }))
    internal.refreshJoinedRoomState({ [room]: { state: { events: memberEvents } } }, true)
    expect(internal.updateConversation(room).metadata.participantsCount).toBe(1_205)
    // A repeated state event must not inflate counts.
    internal.ingestState(room, [
      memberEvents[12],
      event('m.room.member', { membership: 'leave' }, { stateKey: '@user-13:example.org' }),
      event('m.room.member', { membership: 'join' }, { stateKey: '@extra:example.org' }),
    ])
    const original = internal.roomState.get(room)
    const values = original.values.bind(original)
    original.values = () => { throw new Error('unnecessary full member scan') }
    expect(internal.updateConversation(room).metadata.participantsCount).toBe(1_205)
    original.values = values
    internal.directRoomIds.add(room)
    expect(internal.updateConversation(room).kind).toBe('direct')
    expect(internal.updateConversation(room).title).toBe('User 0')
  })

  it('avoids rewriting every other joined room on message-only syncs and updates direct room mappings', async () => {
    const platform = createPlatform(routeFetch(() => { throw new Error('unexpected request') }), {
      userId: '@me:example.org',
    })
    const internal = platform as any
    const rooms = Object.fromEntries(Array.from({ length: 120 }, (_, index) =>
      [`!room-${index}:example.org`, { state: { events: [
        event('m.room.create', {}, { stateKey: '' }),
      ] } }]))
    internal.refreshJoinedRoomState(rooms, true)
    for (const roomId of Object.keys(rooms)) internal.updateConversation(roomId)
    const untouched = internal.conversations.get('!room-119:example.org')
    await internal.dispatchSync({
      next_batch: 'next',
      rooms: { join: { '!room-0:example.org': { timeline: { events: [] } } } },
    }, '@me:example.org', vi.fn())
    expect(internal.conversations.get('!room-119:example.org')).toBe(untouched)
    await internal.dispatchSync({
      next_batch: 'next-2',
      account_data: { events: [{ type: 'm.direct', content: {
        '@friend:example.org': ['!room-119:example.org'],
      } }] },
    }, '@me:example.org', vi.fn())
    expect(internal.conversations.get('!room-119:example.org')).not.toBe(untouched)
    expect(internal.conversations.get('!room-119:example.org').kind).toBe('direct')
  })

  it('finds a single member beyond the first 1,000 without mapping/sorting every member', async () => {
    const room = '!large:example.org'
    const members = Array.from({ length: 1_205 }, (_, index) =>
      event('m.room.member', { membership: 'join', displayname: `Member ${index}` }, {
        stateKey: `@user-${index}:example.org`,
      }))
    const fetch = vi.fn(routeFetch((url) => {
      if (url.pathname.endsWith('/members')) return json({ chunk: members })
      throw new Error(`unexpected request: ${url}`)
    }))
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const member = await platform.getConversationMember(session, { id: room }, '@user-1204:example.org')
    expect(member).toMatchObject({ user: { id: '@user-1204:example.org', firstName: 'Member 1204' } })
    expect(await platform.getConversationMember(session, { id: room }, '@not-present:example.org')).toBeNull()
    const internal = platform as any
    internal.ingestState(room, [members[1]])
    const requests = fetch.mock.calls.length
    expect(await platform.getConversationMember(session, { id: room }, '@user-1:example.org'))
      .toMatchObject({ user: { id: '@user-1:example.org' } })
    expect(fetch.mock.calls.length).toBe(requests)
  })

  it('maps joined rooms beneath nested Matrix Spaces with stable pagination', async () => {
    const space = '!space:example.org'
    const nested = '!nested:example.org'
    const general = '!general:example.org'
    const leaf = '!leaf:example.org'
    const standalone = '!standalone:example.org'
    const join: MatrixSyncResponse['rooms'] = { join: {
      [space]: { state: { events: [
        event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
        event('m.room.name', { name: 'Workspace' }, { stateKey: '' }),
        event('m.space.child', { via: ['example.org'], order: 'a' }, { stateKey: general }),
        event('m.space.child', { via: ['example.org'], order: 'b' }, { stateKey: nested }),
        event('m.space.child', { via: ['example.org'] }, { stateKey: '!not-joined:example.org' }),
      ] } },
      [nested]: { state: { events: [
        event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
        event('m.room.name', { name: 'Nested' }, { stateKey: '' }),
        event('m.space.child', { via: ['example.org'] }, { stateKey: leaf }),
      ] } },
      [general]: { state: { events: [
        event('m.room.create', {}, { stateKey: '' }),
        event('m.room.name', { name: 'General' }, { stateKey: '' }),
      ] }, unread_notifications: { notification_count: 2 } },
      [leaf]: { state: { events: [
        event('m.room.create', {}, { stateKey: '' }),
        event('m.room.name', { name: 'Nested room' }, { stateKey: '' }),
      ] } },
      [standalone]: { state: { events: [
        event('m.room.create', {}, { stateKey: '' }),
        event('m.room.name', { name: 'Standalone' }, { stateKey: '' }),
      ] } },
    } }
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({ next_batch: 's1', rooms: join })
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })

    expect(platform.capabilities.conversations.subchannels).toBe(true)
    const roots = await platform.getDialogs(session)
    expect(roots.total).toBe(2)
    expect(roots.dialogs.map((dialog) => dialog.conversation.id)).toEqual([space, standalone])
    expect(roots.dialogs[0]?.conversation).toMatchObject({
      kind: 'channel', spaceId: space,
      metadata: { matrixSpace: true, hasSubchannels: true },
    })

    const first = await platform.getSubdialogs(session, { id: space }, { limit: 1 })
    expect(first).toMatchObject({ total: 2, nextCursor: '1' })
    expect(first.dialogs[0]).toMatchObject({
      unreadCount: 2, conversation: {
        id: general, kind: 'channel', parentId: space, spaceId: space,
      },
    })
    const second = await platform.getSubdialogs(session, { id: space }, { afterId: general, limit: 10 })
    expect(second.dialogs.map((dialog) => dialog.conversation.id)).toEqual([nested])
    expect(second.dialogs[0]?.conversation.metadata).toMatchObject({
      matrixSpace: true, hasSubchannels: true,
    })
    const nestedPage = await platform.getSubdialogs(session, { id: nested })
    expect(nestedPage.dialogs[0]?.conversation).toMatchObject({
      id: leaf, kind: 'channel', parentId: nested, spaceId: space,
    })
    expect((await platform.getSubdialogs(session, { id: general })).total).toBe(0)
    await expect(platform.getConversation(session, leaf)).resolves.toMatchObject({
      id: leaf, kind: 'channel', parentId: nested, spaceId: space,
    })
    await expect(platform.getConversation(session, '!not-joined:example.org')).resolves.toBeNull()
  })

  it('does not rebuild Space hierarchy on message-only sync but refreshes child state', () => {
    const platform = createPlatform(routeFetch(() => { throw new Error('unexpected network request') }))
    const room = '!space:example.org'
    const child = '!child:example.org'
    const internal = platform as any
    internal.refreshJoinedRoomState({ [room]: { state: { events: [
      event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
    ] } }, [child]: { state: { events: [] } } }, true)
    const existingParents = internal.spaceParents
    const existingChildren = internal.spaceChildren
    internal.refreshJoinedRoomState({ [room]: { timeline: { events: [
      event('m.room.message', { body: 'hello' }),
    ] } } }, false)
    expect(internal.spaceParents).toBe(existingParents)
    expect(internal.spaceChildren).toBe(existingChildren)
    internal.refreshJoinedRoomState({ [room]: { state: { events: [
      event('m.space.child', { via: ['example.org'] }, { stateKey: child }),
    ] } } }, false)
    expect(internal.spaceParents).not.toBe(existingParents)
    expect(internal.spaceParents.get(child)).toBe(room)
  })

  it('shares one full-state request across concurrent Space and dialog reads', async () => {
    let reads = 0
    const space = '!space:example.org'
    const child = '!child:example.org'
    const fetch = routeFetch(async (url) => {
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      reads++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return json({
        next_batch: 's0', rooms: { join: {
          [space]: { state: { events: [
            event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
            event('m.space.child', { via: ['example.org'] }, { stateKey: child }),
          ] } },
          [child]: { state: { events: [event('m.room.create', {}, { stateKey: '' })] } },
        } },
      })
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const [roots, children] = await Promise.all([
      platform.getDialogs(session), platform.getSubdialogs(session, { id: space }),
    ])
    expect(roots.dialogs.map((dialog) => dialog.conversation.id)).toEqual([space])
    expect(children.dialogs.map((dialog) => dialog.conversation.id)).toEqual([child])
    expect(reads).toBe(1)
    await platform.getSubdialogs(session, { id: space }, { cursor: '0', limit: 1 })
    expect(reads).toBe(1)
  })

  it('does not let a delayed full-state fetch erase newer joined Space relationships', async () => {
    let fullReads = 0
    let releaseStale: ((response: Response) => void) | undefined
    const stale = { next_batch: 'old', rooms: { join: {
      '!old:example.org': { state: { events: [
        event('m.room.create', {}, { stateKey: '' }),
      ] } },
    } } }
    const current = { next_batch: 'fresh', rooms: { join: {
      '!space:example.org': { state: { events: [
        event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
        event('m.space.child', { via: ['example.org'] }, { stateKey: '!child:example.org' }),
      ] } },
      '!child:example.org': { state: { events: [
        event('m.room.create', {}, { stateKey: '' }),
      ] } },
    } } }
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      if (url.searchParams.has('since')) return pendingUntilAbort(init?.signal)
      fullReads++
      if (fullReads === 1) return new Promise<Response>((resolve) => { releaseStale = resolve })
      return json(current)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org', syncTimeoutMs: 50 })
    const pending = platform.getDialogs(session)
    await vi.waitFor(() => expect(fullReads).toBe(1))
    const unsubscribe = await platform.subscribe(session, () => {})
    releaseStale!(json(stale))
    const result = await pending
    await unsubscribe()
    expect(result.dialogs.map((dialog) => dialog.conversation.id)).toEqual(['!space:example.org'])
    expect((await platform.getSubdialogs(session, { id: '!space:example.org' }))
      .dialogs.map((dialog) => dialog.conversation.id)).toEqual(['!child:example.org'])
    // A subsequent subdialog read may require a fresh snapshot after an
    // incremental invalidation; only correctness, not an exact count, matters.
    expect(fullReads).toBeGreaterThanOrEqual(3)
  })

  it('emits child parent changes even when the child has a timeline in the same sync batch', async () => {
    const space = '!space:example.org'
    const child = '!child:example.org'
    let sync = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      if (++sync === 1) return json({ next_batch: 's0', rooms: { join: {
        [space]: { state: { events: [
          event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
        ] } },
        [child]: { state: { events: [
          event('m.room.create', {}, { stateKey: '' }),
        ] } },
      } } })
      if (sync === 2) return json({ next_batch: 's1', rooms: { join: {
        [space]: { state: { events: [
          event('m.space.child', { via: ['example.org'] }, { stateKey: child }),
        ] } },
        [child]: { timeline: { events: [
          event('m.room.message', { msgtype: 'm.text', body: 'hello' }, {
            id: '$child-message', sender: '@alice:example.org', ts: 12_000,
          }),
        ] } },
      } } })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org', syncTimeoutMs: 50 })
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { events.push(value) })
    await vi.waitFor(() => expect(events.filter((value) =>
      value.type === 'conversation' && value.conversation.id === child)).toHaveLength(1))
    await unsubscribe()

    expect(events.map((value) => value.type)).toEqual([
      'conversation', 'conversation', 'message',
    ])
    expect(events[1]).toMatchObject({
      type: 'conversation', conversation: {
        id: child, kind: 'channel', parentId: space, spaceId: space,
      },
    })
    expect(events[2]).toMatchObject({
      type: 'message', conversation: { id: child, parentId: space },
      message: { id: '$child-message' },
    })
  })

  it('promotes a joined child back to a root when its parent Space is left', async () => {
    const space = '!space:example.org'
    const child = '!child:example.org'
    let incremental = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      if (!url.searchParams.has('since')) {
        const initial = incremental === 0
        return json({ next_batch: 's0', rooms: { join: {
          ...(initial ? { [space]: { state: { events: [
            event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
            event('m.space.child', { via: ['example.org'] }, { stateKey: child }),
          ] } } } : {}),
          [child]: { state: { events: [event('m.room.create', {}, { stateKey: '' })] } },
        } } })
      }
      if (++incremental === 1) return json({
        next_batch: 's1', rooms: { leave: { [space]: {} } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org', syncTimeoutMs: 50 })
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { events.push(value) })
    await vi.waitFor(() => expect(events.some((value) =>
      value.type === 'conversation' && value.conversation.id === child)).toBe(true))
    await unsubscribe()

    expect(events).toMatchObject([{
      type: 'conversation', conversation: { id: child, kind: 'group', parentId: undefined },
    }])
    const roots = await platform.getDialogs(session)
    expect(roots.dialogs.map((dialog) => dialog.conversation.id)).toEqual([child])
    expect((await platform.getSubdialogs(session, { id: space })).total).toBe(0)
  })

  it('keeps pin events and Space hierarchy updates together in one incremental sync', async () => {
    const space = '!space:example.org'
    const child = '!child:example.org'
    let sync = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      if (++sync === 1) return json({ next_batch: 'before', rooms: { join: {
        [space]: { state: { events: [
          event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
          event('m.space.child', { via: ['example.org'] }, { stateKey: child }),
          event('m.room.pinned_events', { pinned: ['$first'] }, { stateKey: '', id: '$original' }),
        ] } },
        [child]: { state: { events: [event('m.room.create', {}, { stateKey: '' })] } },
      } } })
      if (sync === 2) return json({ next_batch: 'after', rooms: { join: {
        [space]: { state: { events: [
          event('m.space.child', {}, { stateKey: child }),
          event('m.room.pinned_events', { pinned: ['$first', '$second'] }, { stateKey: '', id: '$updated' }),
        ] } },
      } } })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: session.userId, syncTimeoutMs: 50 })
    const observed: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { observed.push(value) })
    await vi.waitFor(() => {
      expect(observed.some((value) => value.type === 'message-pins')).toBe(true)
      expect(observed.some((value) =>
        value.type === 'conversation' && value.conversation.id === child)).toBe(true)
    })
    await unsubscribe()
    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message-pins', eventId: '$updated',
        pinnedMessageIds: ['$first', '$second'], removedMessageIds: [],
      }),
      expect.objectContaining({
        type: 'conversation', conversation: expect.objectContaining({
          id: space, metadata: expect.objectContaining({ hasSubchannels: false }),
        }),
      }),
      expect.objectContaining({
        type: 'conversation', conversation: expect.objectContaining({
          id: child, kind: 'group', parentId: undefined,
        }),
      }),
    ]))
  })

  it('updates child metadata after a Space relationship is removed in incremental sync', async () => {
    const space = '!space:example.org'
    const child = '!child:example.org'
    let sync = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      if (++sync === 1) return json({ next_batch: 's0', rooms: { join: {
        [space]: { state: { events: [
          event('m.room.create', { type: 'm.space' }, { stateKey: '' }),
          event('m.space.child', { via: ['example.org'] }, { stateKey: child }),
        ] } },
        [child]: { state: { events: [event('m.room.create', {}, { stateKey: '' })] } },
      } } })
      if (sync === 2) return json({ next_batch: 's1', rooms: { join: {
        [space]: { state: { events: [
          event('m.space.child', {}, { stateKey: child }),
        ] } },
      } } })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org', syncTimeoutMs: 50 })
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { events.push(value) })
    await vi.waitFor(() => expect(events.some((value) =>
      value.type === 'conversation' && value.conversation.id === child)).toBe(true))
    await unsubscribe()
    const root = events.find((value) =>
      value.type === 'conversation' && value.conversation.id === space)
    const updatedChild = events.find((value) =>
      value.type === 'conversation' && value.conversation.id === child)
    expect(root).toMatchObject({ conversation: { metadata: { hasSubchannels: false } } })
    expect(updatedChild).toMatchObject({ conversation: { kind: 'group', parentId: undefined } })
  })
  it('shows Matrix invites in the request inbox, paginates them, and accepts or rejects rooms', async () => {
    const actions: Array<{ path: string, method: string }> = []
    const invite = (roomId: string, inviter: string, title: string) => ({
      invite_state: { events: [
        event('m.room.name', { name: title }, { stateKey: '' }),
        event('m.room.avatar', { url: 'mxc://example.org/invite-avatar' }, { stateKey: '' }),
        event('m.room.member', { membership: 'join', displayname: 'Inviter' }, {
          stateKey: inviter, sender: inviter,
        }),
        event('m.room.member', { membership: 'invite', reason: 'Welcome!' }, {
          id: `$invite-${title}`, stateKey: '@me:example.org', sender: inviter, ts: 123_000,
        }),
      ] },
    })
    const fetch = routeFetch((url, init) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 'initial',
        rooms: { invite: {
          '!alpha:example.org': invite('!alpha:example.org', '@alice:example.org', 'Alpha'),
          '!beta:example.org': invite('!beta:example.org', '@bob:example.org', 'Beta'),
        } },
      } satisfies MatrixSyncResponse)
      if (/\/(join|leave)$/.test(url.pathname)) {
        actions.push({ path: url.pathname, method: init?.method ?? 'GET' })
        return json({})
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const first = await platform.getRequests(session, { kind: 'group-join', limit: 1 })
    expect(first.requests).toHaveLength(1)
    expect(first.nextCursor).toBe('1')
    const second = await platform.getRequests(session, { kind: 'group-join', limit: 1, cursor: first.nextCursor })
    expect(second.requests).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(await platform.getRequests(session, { kind: 'friend' })).toEqual({ requests: [] })
    await expect(platform.getRequests(session, { cursor: '-1' })).rejects.toThrow(/invalid Matrix request cursor/)
    const requests = [...first.requests, ...second.requests]
    expect(requests.map((request) => request.group?.title)).toEqual(['Alpha', 'Beta'])
    expect(requests[0]).toMatchObject({
      kind: 'group-join', state: 'pending',
      requester: { id: '@alice:example.org', firstName: 'Inviter' },
      group: {
        id: '!alpha:example.org', kind: 'group',
        avatar: { locator: { mxc: 'mxc://example.org/invite-avatar' } },
      },
      message: 'Welcome!', createdAt: 123_000,
      metadata: { matrixRoomInvite: true, matrixRoomId: '!alpha:example.org' },
    })
    expect((await platform.getDialogs(session)).total).toBe(0)
    const accepted = await platform.resolveRequest(session, requests[0]!.id, 'accept')
    const rejected = await platform.resolveRequest(session, requests[1]!.id, 'reject')
    expect(accepted.state).toBe('accepted')
    expect(rejected.state).toBe('rejected')
    expect(actions).toEqual([
      { path: '/_matrix/client/v3/rooms/!alpha%3Aexample.org/join', method: 'POST' },
      { path: '/_matrix/client/v3/rooms/!beta%3Aexample.org/leave', method: 'POST' },
    ])
    await expect(platform.resolveRequest(session, requests[0]!.id, 'accept'))
      .resolves.toMatchObject({ state: 'accepted' })
    expect(actions).toHaveLength(2)
  })

  it('uses one stable sync snapshot across request-list pages', async () => {
    let syncs = 0
    const invitation = (room: string) => ({ invite_state: { events: [
      event('m.room.member', { membership: 'invite' }, {
        id: `$invite-${room}`, stateKey: '@me:example.org', sender: '@alice:example.org',
      }),
    ] } })
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      syncs++
      if (syncs === 1) return json({ next_batch: 's1', rooms: { invite: {
        '!a:example.org': invitation('a'), '!b:example.org': invitation('b'),
      } } })
      return json({ next_batch: 's2', rooms: { invite: { '!c:example.org': invitation('c') } } })
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const first = await platform.getRequests(session, { limit: 1 })
    const second = await platform.getRequests(session, { limit: 1, cursor: first.nextCursor })
    expect(syncs).toBe(1)
    expect([first.requests[0]?.group?.id, second.requests[0]?.group?.id]).toEqual([
      '!a:example.org', '!b:example.org',
    ])
    const refreshed = await platform.getRequests(session)
    expect(syncs).toBe(2)
    expect(refreshed.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'pending', group: expect.objectContaining({ id: '!c:example.org' }) }),
      expect.objectContaining({ state: 'rejected', group: expect.objectContaining({ id: '!a:example.org' }) }),
      expect.objectContaining({ state: 'rejected', group: expect.objectContaining({ id: '!b:example.org' }) }),
    ]))
  })

  it('recognizes a fresh re-invitation when Matrix supplies a new event ID', async () => {
    let revision = '$first-invite'
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            id: revision, stateKey: '@me:example.org', sender: '@alice:example.org',
          }),
        ] } } } },
      })
      if (url.pathname.endsWith('/leave')) return json({})
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const [oldInvite] = (await platform.getRequests(session)).requests
    await expect(platform.resolveRequest(session, oldInvite!.id, 'reject'))
      .resolves.toMatchObject({ state: 'rejected' })
    revision = '$second-invite'
    const replacements = (await platform.getRequests(session)).requests
    const newInvite = replacements.find((request) => request.state === 'pending')
    expect(newInvite).toMatchObject({ state: 'pending', group: { id: '!room:example.org' } })
    expect(newInvite?.id).not.toBe(oldInvite?.id)
    expect(replacements.find((request) => request.id === oldInvite?.id)?.state).toBe('rejected')
  })

  it('reconciles a superseded pending invite before publishing the replacement', async () => {
    let revision = '$old'
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      return json({ next_batch: 's1', rooms: { invite: {
        '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            id: revision, stateKey: '@me:example.org', sender: '@alice:example.org',
          }),
        ] } },
      } } })
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const previous = (await platform.getRequests(session)).requests[0]!
    revision = '$new'
    const current = (await platform.getRequests(session)).requests
    expect(current.find((request) => request.id === previous.id)?.state).toBe('rejected')
    expect(current.find((request) => request.id !== previous.id)?.state).toBe('pending')
  })

  it('serializes conflicting decisions and ignores stale invited-room snapshots', async () => {
    const join = Promise.withResolvers<Response>()
    const actions: string[] = []
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org', id: '$invite',
          }),
        ] } } } },
      })
      if (url.pathname.endsWith('/join')) {
        actions.push('join')
        return join.promise
      }
      if (url.pathname.endsWith('/leave')) {
        actions.push('leave')
        return json({})
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const original = (await platform.getRequests(session)).requests[0]!
    const accepting = platform.resolveRequest(session, original.id, 'accept')
    await expect(platform.resolveRequest(session, original.id, 'reject'))
      .rejects.toThrow(/already in progress/)
    join.resolve(json({ room_id: '!room:example.org' }))
    expect((await accepting).state).toBe('accepted')
    const later = await platform.getRequests(session)
    expect(later.requests).toHaveLength(1)
    expect(later.requests[0]).toMatchObject({ id: original.id, state: 'accepted' })
    await expect(platform.resolveRequest(session, original.id, 'reject'))
      .rejects.toThrow(/no longer pending/)
    expect(actions).toEqual(['join'])
  })

  it('emits the terminal request again after a successful API action', async () => {
    let sync = 0
    let joins = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/join')) {
        joins++
        return json({ room_id: '!room:example.org' })
      }
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      sync++
      if (sync <= 2) return json({
        next_batch: `s${sync}`, rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org', id: '$invite',
          }),
        ] } } } },
      })
      if (sync === 3) return json({
        next_batch: 's3', rooms: { join: { '!room:example.org': {} } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org', syncTimeoutMs: 50 })
    const request = (await platform.getRequests(session)).requests[0]!
    await platform.resolveRequest(session, request.id, 'accept')
    await expect(platform.resolveRequest(session, request.id, 'accept'))
      .resolves.toMatchObject({ state: 'accepted' })
    expect(joins).toBe(1)
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { events.push(value) })
    await vi.waitFor(() => expect(events.some((value) =>
      value.type === 'request' && value.request.state === 'accepted')).toBe(true))
    await unsubscribe()
    const terminal = events.find((value) => value.type === 'request')
    expect(terminal).toMatchObject({ request: { id: request.id, state: 'accepted' } })
    expect(joins).toBe(1)
  })

  it('keeps an invitation pending when an accept operation fails', async () => {
    let attempts = 0
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org',
          }),
        ] } } } },
      })
      if (url.pathname.endsWith('/join')) {
        attempts++
        return json({ errcode: 'M_FORBIDDEN', error: 'not allowed' }, { status: 403 })
      }
      if (url.pathname.endsWith('/leave')) return json({})
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const { requests: [request] } = await platform.getRequests(session)
    await expect(platform.resolveRequest(session, request!.id, 'accept')).rejects.toThrow('not allowed')
    await expect(platform.resolveRequest(session, request!.id, 'accept')).rejects.toThrow('not allowed')
    expect(attempts).toBe(2)
    await expect(platform.resolveRequest(session, request!.id, 'reject'))
      .resolves.toMatchObject({ state: 'rejected' })
  })

  it('emits new invites and resolves remotely joined or withdrawn invites', async () => {
    let sync = 0
    const membership = (roomId: string, sender: string) => ({
      [roomId]: { invite_state: { events: [
        event('m.room.name', { name: 'Invitation' }, { stateKey: '' }),
        event('m.room.member', { membership: 'invite' }, {
          stateKey: '@me:example.org', sender, id: `$invite-${roomId}`,
        }),
      ] } },
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      sync++
      if (sync === 1) return json({
        next_batch: 's0', rooms: { invite: membership('!old:example.org', '@alice:example.org') },
      })
      if (sync === 2) return json({
        next_batch: 's1', rooms: { invite: membership('!new:example.org', '@bob:example.org') },
      })
      if (sync === 3) return json({
        next_batch: 's2', rooms: { join: { '!old:example.org': {} }, leave: { '!new:example.org': {} } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { syncTimeoutMs: 50, userId: '@me:example.org' })
    const requests: Array<{ state: string, roomId?: string }> = []
    const unsubscribe = await platform.subscribe(session, (value) => {
      if (value.type === 'request') {
        requests.push({ state: value.request.state, roomId: value.request.group?.id })
      }
    })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    await unsubscribe()
    expect(requests).toEqual([
      { state: 'pending', roomId: '!new:example.org' },
      { state: 'accepted', roomId: '!old:example.org' },
      { state: 'rejected', roomId: '!new:example.org' },
    ])
  })

  it('retries the same sync token if an invitation event cannot be delivered', async () => {
    let sync = 0
    const tokens: Array<string | null> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      tokens.push(url.searchParams.get('since'))
      sync++
      if (sync === 1) return json({ next_batch: 's0' })
      if (sync <= 3) return json({
        next_batch: 's1',
        rooms: { invite: { '!retry:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org', id: '$retry',
          }),
        ] } } } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { syncTimeoutMs: 50, userId: '@me:example.org' })
    let deliveries = 0
    const unsubscribe = await platform.subscribe(session, (event) => {
      if (event.type !== 'request') return
      deliveries++
      if (deliveries === 1) throw new Error('temporary delivery failure')
    })
    // Production deliberately backs off for 1s after an unsuccessful sync.
    await vi.waitFor(() => expect(deliveries).toBe(2), { timeout: 4_000 })
    await unsubscribe()
    expect(tokens.slice(0, 3)).toEqual([null, 's0', 's0'])
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
  it('shows Matrix invites in the request inbox, paginates them, and accepts or rejects rooms', async () => {
    const actions: Array<{ path: string, method: string }> = []
    const invite = (roomId: string, inviter: string, title: string) => ({
      invite_state: { events: [
        event('m.room.name', { name: title }, { stateKey: '' }),
        event('m.room.avatar', { url: 'mxc://example.org/invite-avatar' }, { stateKey: '' }),
        event('m.room.member', { membership: 'join', displayname: 'Inviter' }, {
          stateKey: inviter, sender: inviter,
        }),
        event('m.room.member', { membership: 'invite', reason: 'Welcome!' }, {
          id: `$invite-${title}`, stateKey: '@me:example.org', sender: inviter, ts: 123_000,
        }),
      ] },
    })
    const fetch = routeFetch((url, init) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 'initial',
        rooms: { invite: {
          '!alpha:example.org': invite('!alpha:example.org', '@alice:example.org', 'Alpha'),
          '!beta:example.org': invite('!beta:example.org', '@bob:example.org', 'Beta'),
        } },
      } satisfies MatrixSyncResponse)
      if (/\/(join|leave)$/.test(url.pathname)) {
        actions.push({ path: url.pathname, method: init?.method ?? 'GET' })
        return json({})
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const first = await platform.getRequests(session, { kind: 'group-join', limit: 1 })
    expect(first.requests).toHaveLength(1)
    expect(first.nextCursor).toBe('1')
    const second = await platform.getRequests(session, { kind: 'group-join', limit: 1, cursor: first.nextCursor })
    expect(second.requests).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(await platform.getRequests(session, { kind: 'friend' })).toEqual({ requests: [] })
    await expect(platform.getRequests(session, { cursor: '-1' })).rejects.toThrow(/invalid Matrix request cursor/)
    const requests = [...first.requests, ...second.requests]
    expect(requests.map((request) => request.group?.title)).toEqual(['Alpha', 'Beta'])
    expect(requests[0]).toMatchObject({
      kind: 'group-join', state: 'pending',
      requester: { id: '@alice:example.org', firstName: 'Inviter' },
      group: {
        id: '!alpha:example.org', kind: 'group',
        avatar: { locator: { mxc: 'mxc://example.org/invite-avatar' } },
      },
      message: 'Welcome!', createdAt: 123_000,
      metadata: { matrixRoomInvite: true, matrixRoomId: '!alpha:example.org' },
    })
    expect((await platform.getDialogs(session)).total).toBe(0)
    const accepted = await platform.resolveRequest(session, requests[0]!.id, 'accept')
    const rejected = await platform.resolveRequest(session, requests[1]!.id, 'reject')
    expect(accepted.state).toBe('accepted')
    expect(rejected.state).toBe('rejected')
    expect(actions).toEqual([
      { path: '/_matrix/client/v3/rooms/!alpha%3Aexample.org/join', method: 'POST' },
      { path: '/_matrix/client/v3/rooms/!beta%3Aexample.org/leave', method: 'POST' },
    ])
    await expect(platform.resolveRequest(session, requests[0]!.id, 'accept'))
      .resolves.toMatchObject({ state: 'accepted' })
    expect(actions).toHaveLength(2)
  })

  it('uses one stable sync snapshot across request-list pages', async () => {
    let syncs = 0
    const invitation = (room: string) => ({ invite_state: { events: [
      event('m.room.member', { membership: 'invite' }, {
        id: `$invite-${room}`, stateKey: '@me:example.org', sender: '@alice:example.org',
      }),
    ] } })
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      syncs++
      if (syncs === 1) return json({ next_batch: 's1', rooms: { invite: {
        '!a:example.org': invitation('a'), '!b:example.org': invitation('b'),
      } } })
      return json({ next_batch: 's2', rooms: { invite: { '!c:example.org': invitation('c') } } })
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const first = await platform.getRequests(session, { limit: 1 })
    const second = await platform.getRequests(session, { limit: 1, cursor: first.nextCursor })
    expect(syncs).toBe(1)
    expect([first.requests[0]?.group?.id, second.requests[0]?.group?.id]).toEqual([
      '!a:example.org', '!b:example.org',
    ])
    const refreshed = await platform.getRequests(session)
    expect(syncs).toBe(2)
    expect(refreshed.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'pending', group: expect.objectContaining({ id: '!c:example.org' }) }),
      expect.objectContaining({ state: 'rejected', group: expect.objectContaining({ id: '!a:example.org' }) }),
      expect.objectContaining({ state: 'rejected', group: expect.objectContaining({ id: '!b:example.org' }) }),
    ]))
  })

  it('recognizes a fresh re-invitation when Matrix supplies a new event ID', async () => {
    let revision = '$first-invite'
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            id: revision, stateKey: '@me:example.org', sender: '@alice:example.org',
          }),
        ] } } } },
      })
      if (url.pathname.endsWith('/leave')) return json({})
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const [oldInvite] = (await platform.getRequests(session)).requests
    await expect(platform.resolveRequest(session, oldInvite!.id, 'reject'))
      .resolves.toMatchObject({ state: 'rejected' })
    revision = '$second-invite'
    const replacements = (await platform.getRequests(session)).requests
    const newInvite = replacements.find((request) => request.state === 'pending')
    expect(newInvite).toMatchObject({ state: 'pending', group: { id: '!room:example.org' } })
    expect(newInvite?.id).not.toBe(oldInvite?.id)
    expect(replacements.find((request) => request.id === oldInvite?.id)?.state).toBe('rejected')
  })

  it('reconciles a superseded pending invite before publishing the replacement', async () => {
    let revision = '$old'
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      return json({ next_batch: 's1', rooms: { invite: {
        '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            id: revision, stateKey: '@me:example.org', sender: '@alice:example.org',
          }),
        ] } },
      } } })
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const previous = (await platform.getRequests(session)).requests[0]!
    revision = '$new'
    const current = (await platform.getRequests(session)).requests
    expect(current.find((request) => request.id === previous.id)?.state).toBe('rejected')
    expect(current.find((request) => request.id !== previous.id)?.state).toBe('pending')
  })

  it('serializes conflicting decisions and ignores stale invited-room snapshots', async () => {
    const join = Promise.withResolvers<Response>()
    const actions: string[] = []
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org', id: '$invite',
          }),
        ] } } } },
      })
      if (url.pathname.endsWith('/join')) {
        actions.push('join')
        return join.promise
      }
      if (url.pathname.endsWith('/leave')) {
        actions.push('leave')
        return json({})
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const original = (await platform.getRequests(session)).requests[0]!
    const accepting = platform.resolveRequest(session, original.id, 'accept')
    await expect(platform.resolveRequest(session, original.id, 'reject'))
      .rejects.toThrow(/already in progress/)
    join.resolve(json({ room_id: '!room:example.org' }))
    expect((await accepting).state).toBe('accepted')
    const later = await platform.getRequests(session)
    expect(later.requests).toHaveLength(1)
    expect(later.requests[0]).toMatchObject({ id: original.id, state: 'accepted' })
    await expect(platform.resolveRequest(session, original.id, 'reject'))
      .rejects.toThrow(/no longer pending/)
    expect(actions).toEqual(['join'])
  })

  it('emits the terminal request again after a successful API action', async () => {
    let sync = 0
    let joins = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/join')) {
        joins++
        return json({ room_id: '!room:example.org' })
      }
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      sync++
      if (sync <= 2) return json({
        next_batch: `s${sync}`, rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org', id: '$invite',
          }),
        ] } } } },
      })
      if (sync === 3) return json({
        next_batch: 's3', rooms: { join: { '!room:example.org': {} } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org', syncTimeoutMs: 50 })
    const request = (await platform.getRequests(session)).requests[0]!
    await platform.resolveRequest(session, request.id, 'accept')
    await expect(platform.resolveRequest(session, request.id, 'accept'))
      .resolves.toMatchObject({ state: 'accepted' })
    expect(joins).toBe(1)
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (value) => { events.push(value) })
    await vi.waitFor(() => expect(events.some((value) =>
      value.type === 'request' && value.request.state === 'accepted')).toBe(true))
    await unsubscribe()
    const terminal = events.find((value) => value.type === 'request')
    expect(terminal).toMatchObject({ request: { id: request.id, state: 'accepted' } })
    expect(joins).toBe(1)
  })

  it('keeps an invitation pending when an accept operation fails', async () => {
    let attempts = 0
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/sync')) return json({
        next_batch: 's1', rooms: { invite: { '!room:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org',
          }),
        ] } } } },
      })
      if (url.pathname.endsWith('/join')) {
        attempts++
        return json({ errcode: 'M_FORBIDDEN', error: 'not allowed' }, { status: 403 })
      }
      if (url.pathname.endsWith('/leave')) return json({})
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const { requests: [request] } = await platform.getRequests(session)
    await expect(platform.resolveRequest(session, request!.id, 'accept')).rejects.toThrow('not allowed')
    await expect(platform.resolveRequest(session, request!.id, 'accept')).rejects.toThrow('not allowed')
    expect(attempts).toBe(2)
    await expect(platform.resolveRequest(session, request!.id, 'reject'))
      .resolves.toMatchObject({ state: 'rejected' })
  })

  it('emits new invites and resolves remotely joined or withdrawn invites', async () => {
    let sync = 0
    const membership = (roomId: string, sender: string) => ({
      [roomId]: { invite_state: { events: [
        event('m.room.name', { name: 'Invitation' }, { stateKey: '' }),
        event('m.room.member', { membership: 'invite' }, {
          stateKey: '@me:example.org', sender, id: `$invite-${roomId}`,
        }),
      ] } },
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      sync++
      if (sync === 1) return json({
        next_batch: 's0', rooms: { invite: membership('!old:example.org', '@alice:example.org') },
      })
      if (sync === 2) return json({
        next_batch: 's1', rooms: { invite: membership('!new:example.org', '@bob:example.org') },
      })
      if (sync === 3) return json({
        next_batch: 's2', rooms: { join: { '!old:example.org': {} }, leave: { '!new:example.org': {} } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { syncTimeoutMs: 50, userId: '@me:example.org' })
    const requests: Array<{ state: string, roomId?: string }> = []
    const unsubscribe = await platform.subscribe(session, (value) => {
      if (value.type === 'request') {
        requests.push({ state: value.request.state, roomId: value.request.group?.id })
      }
    })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    await unsubscribe()
    expect(requests).toEqual([
      { state: 'pending', roomId: '!new:example.org' },
      { state: 'accepted', roomId: '!old:example.org' },
      { state: 'rejected', roomId: '!new:example.org' },
    ])
  })

  it('retries the same sync token if an invitation event cannot be delivered', async () => {
    let sync = 0
    const tokens: Array<string | null> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      tokens.push(url.searchParams.get('since'))
      sync++
      if (sync === 1) return json({ next_batch: 's0' })
      if (sync <= 3) return json({
        next_batch: 's1',
        rooms: { invite: { '!retry:example.org': { invite_state: { events: [
          event('m.room.member', { membership: 'invite' }, {
            stateKey: '@me:example.org', sender: '@alice:example.org', id: '$retry',
          }),
        ] } } } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { syncTimeoutMs: 50, userId: '@me:example.org' })
    let deliveries = 0
    const unsubscribe = await platform.subscribe(session, (event) => {
      if (event.type !== 'request') return
      deliveries++
      if (deliveries === 1) throw new Error('temporary delivery failure')
    })
    // Production deliberately backs off for 1s after an unsuccessful sync.
    await vi.waitFor(() => expect(deliveries).toBe(2), { timeout: 4_000 })
    await unsubscribe()
    expect(tokens.slice(0, 3)).toEqual([null, 's0', 's0'])
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
          ] } },
        } } })
      }
      if (url.searchParams.get('since') === 'start') {
        return json({ next_batch: 'advance', rooms: { join: {
          [roomId]: { state: { events: [
            event('m.room.pinned_events', { pinned: ['$new'] }, {
              id: '$retry-pin', stateKey: '', ts: 2_000,
            }),
          ] } },
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
  it('projects stable and legacy Matrix polls without showing individual votes as messages', async () => {
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/messages')) throw new Error(`unexpected request: ${url}`)
      return json({ chunk: [
        event('m.poll.start', {
          'm.text': [{ mimetype: 'text/plain', body: 'Dinner? 1. Pizza 2. Noodles' }],
          'm.poll': {
            kind: 'm.disclosed', max_selections: 2,
            question: { 'm.text': [{ body: 'Dinner?' }] },
            answers: [
              { 'm.id': 'pizza', 'm.text': [{ body: 'Pizza' }] },
              { 'm.id': 'noodles', 'm.text': [{ body: 'Noodles' }] },
            ],
          },
        }, { id: '$poll', sender: '@alice:example.org', ts: 1_000 }),
        event('m.poll.response', {
          'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
          'm.selections': ['pizza'],
        }, { id: '$vote', sender: '@me:example.org', ts: 2_000 }),
        event('m.poll.end', {
          'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
          'm.text': [{ body: 'Poll closed' }],
        }, { id: '$close', sender: '@alice:example.org', ts: 3_000 }),
        event('org.matrix.msc3381.poll.start', {
          'org.matrix.msc1767.text': 'Where to go?',
          'org.matrix.msc3381.poll.start': {
            kind: 'org.matrix.msc3381.poll.undisclosed',
            question: { 'org.matrix.msc1767.text': 'Where to go?' },
            answers: [{ id: 'beach', 'org.matrix.msc1767.text': 'Beach' }],
          },
        }, { id: '$legacy', sender: '@alice:example.org', ts: 4_000 }),
        event('org.matrix.msc3381.poll.end', {
          'm.relates_to': { rel_type: 'm.reference', event_id: '$legacy' },
          'org.matrix.msc1767.text': 'Voting ended',
        }, { id: '$legacy-end', sender: '@alice:example.org', ts: 5_000 }),
        event('m.poll.start', { 'm.text': [{ body: 'Fallback when poll is malformed' }] },
          { id: '$fallback', sender: '@alice:example.org', ts: 6_000 }),
      ] })
    })
    const platform = createPlatform(fetch)
    const page = await platform.getHistory(session, { id: '!room:example.org' })
    expect(page.messages.map((item) => item.id)).toEqual([
      '$poll', '$close', '$legacy', '$legacy-end', '$fallback',
    ])
    expect(page.messages[0]).toMatchObject({ content: { parts: [{ type: 'poll', poll: {
      question: 'Dinner?', kind: 'disclosed', maxSelections: 2,
      answers: [{ id: 'pizza', text: 'Pizza' }, { id: 'noodles', text: 'Noodles' }],
    } }] } })
    expect(page.messages[1]).toMatchObject({
      replyToId: '$poll', content: { parts: [{ type: 'text', text: 'Poll closed' }] },
    })
    expect(page.messages[2]).toMatchObject({ content: { parts: [{ type: 'poll', poll: {
      question: 'Where to go?', kind: 'undisclosed', maxSelections: 1,
      answers: [{ id: 'beach', text: 'Beach' }],
    } }] } })
    expect(page.messages[3]).toMatchObject({ replyToId: '$legacy', content: {
      parts: [{ text: 'Voting ended' }],
    } })
    expect(page.messages[4]?.content.parts).toEqual([
      { type: 'text', text: 'Fallback when poll is malformed' },
    ])
  })

  it('maps Matrix poll replacement edits from m.new_content and preserves the source ID', async () => {
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/messages')) throw new Error(`unexpected request: ${url}`)
      return json({ chunk: [
        event('m.poll.start', {
          'm.text': [{ body: '* Old question' }],
          'm.poll': { kind: 'm.undisclosed', question: { 'm.text': [{ body: 'Old question' }] },
            answers: [{ 'm.id': 'old', 'm.text': [{ body: 'Old answer' }] }] },
          'm.new_content': {
            'm.text': [{ body: 'Updated question and answers' }],
            'm.poll': {
              kind: 'm.poll.disclosed', question: { 'm.text': [{ body: 'Updated question' }] },
              answers: [{ 'm.id': 'new', 'm.text': [{ body: 'Updated answer' }] }],
            },
          },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$original-poll' },
        }, { id: '$poll-edit', sender: '@alice:example.org', ts: 8_000 }),
      ] })
    })
    const page = await createPlatform(fetch).getHistory(session, { id: '!room:example.org' })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({
      id: '$original-poll', sourceIds: ['$original-poll'],
      content: { parts: [{ type: 'poll', poll: {
        question: 'Updated question', kind: 'disclosed', maxSelections: 1,
        answers: [{ id: 'new', text: 'Updated answer' }],
      } }] },
    })
  })


  it('submits stable single-choice poll votes through Matrix reference events', async () => {
    const poll = event('m.poll.start', {
      'm.text': [{ body: 'Choose a dessert' }],
      'm.poll.start': {
        kind: 'm.poll.disclosed',
        question: { 'm.text': [{ body: 'Dessert?' }] },
        answers: [
          { id: '🍓', 'm.text': [{ body: 'Strawberries' }] },
          { id: '🍰', 'm.text': [{ body: 'Cake' }] },
        ],
      },
    }, { id: '$dessert', sender: '@alice:example.org' })
    const sent: Array<{ path: string, body: Record<string, unknown> }> = []
    const fetch = routeFetch((url, init) => {
      if (url.pathname.endsWith('/messages')) return json({ chunk: [poll] })
      if (url.pathname.includes('/event/')) return json(poll)
      if (url.pathname.includes('/relations/')) return json({ chunk: [] })
      if (url.pathname.includes('/send/')) {
        sent.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
        return json({ event_id: '$vote' })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    const history = await platform.getHistory(session, { id: '!room:example.org' })
    expect(history.messages[0].content.parts[0]).toMatchObject({
      type: 'poll', poll: { question: 'Dessert?', kind: 'disclosed' },
    })
    const buttons = history.messages[0].content.inlineKeyboard?.rows
      .flatMap((row) => row.buttons)
    expect(buttons).toMatchObject([
      { type: 'callback', text: 'Strawberries', data: 'matrix-poll-vote:0' },
      { type: 'callback', text: 'Cake', data: 'matrix-poll-vote:1' },
    ])
    const result = await platform.clickInlineButton(session, {
      conversationId: '!room:example.org', messageId: '$dessert',
    }, { type: 'callback', text: 'Cake', data: 'matrix-poll-vote:1' })
    expect(result).toMatchObject({ message: expect.stringContaining('投票已提交') })
    expect(sent).toHaveLength(1)
    expect(sent[0].path).toContain('/send/m.poll.response/')
    expect(sent[0].body).toMatchObject({
      'm.relates_to': { rel_type: 'm.reference', event_id: '$dessert' },
      'm.selections': ['🍰'],
      'm.poll.response': { answers: ['🍰'] },
    })
    await expect(platform.clickInlineButton(session, {
      conversationId: '!room:example.org', messageId: '$dessert',
    }, { type: 'callback', text: 'Nope', data: 'matrix-poll-vote:35' }))
      .resolves.toMatchObject({ alert: true })
    expect(sent).toHaveLength(1)
  })

  it('prevents late votes and omits keyboards on closed or multi-choice Matrix polls', async () => {
    const poll = event('org.matrix.msc3381.poll.start', {
      'org.matrix.msc3381.poll.start': {
        kind: 'org.matrix.msc3381.poll.disclosed', max_selections: 1,
        question: { 'org.matrix.msc1767.text': 'Go?' },
        answers: [{ id: 'yes', 'org.matrix.msc1767.text': 'Yes' }],
      },
    }, { id: '$poll', sender: '@alice:example.org' })
    const end = event('org.matrix.msc3381.poll.end', {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'org.matrix.msc3381.poll.end': {},
    }, { id: '$end', sender: '@alice:example.org' })
    let sends = 0
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/messages')) return json({ chunk: [poll, end] })
      if (url.pathname.includes('/event/')) return json(poll)
      if (url.pathname.includes('/relations/')) return json({ chunk: [end] })
      if (url.pathname.includes('/send/')) { sends++; return json({ event_id: '$nope' }) }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    const history = await platform.getHistory(session, { id: '!room:example.org' })
    expect(history.messages[0].content.inlineKeyboard).toBeUndefined()
    expect(await platform.clickInlineButton(session, {
      conversationId: '!room:example.org', messageId: '$poll',
    }, { type: 'callback', text: 'Yes', data: 'matrix-poll-vote:0' })).toMatchObject({
      alert: true, message: '投票已经结束',
    })
    expect(sends).toBe(0)
  })

  it('sends unstable MSC3381 votes only after paginated relation checks succeed', async () => {
    const poll = event('org.matrix.msc3381.poll.start', {
      'org.matrix.msc3381.poll.start': {
        question: { 'org.matrix.msc1767.text': 'Question' },
        answers: [{ id: 'a', 'org.matrix.msc1767.text': 'Answer' }],
      },
    }, { id: '$poll', sender: '@alice:example.org' })
    const paths: string[] = []
    const sent: Record<string, unknown>[] = []
    const fetch = routeFetch((url, init) => {
      paths.push(`${url.pathname}${url.search}`)
      if (url.pathname.includes('/event/')) return json(poll)
      if (url.pathname.includes('/relations/')) {
        return json(url.searchParams.has('from') ? { chunk: [] } : { chunk: [], next_batch: 'more' })
      }
      if (url.pathname.includes('/send/')) {
        sent.push(JSON.parse(String(init?.body)))
        return json({ event_id: '$vote' })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    expect(await platform.clickInlineButton(session, {
      conversationId: '!room:example.org', messageId: '$poll',
    }, { type: 'callback', text: 'Answer', data: 'matrix-poll-vote:0' }))
      .toMatchObject({ message: expect.stringContaining('投票已提交') })
    expect(paths.filter((value) => value.includes('/relations/'))).toHaveLength(2)
    expect(paths.find((value) => value.includes('from=more'))).toBeDefined()
    expect(sent).toMatchObject([{ 'org.matrix.msc3381.poll.response': { answers: ['a'] } }])
  })


  it('fails closed when the homeserver cannot confirm poll relations', async () => {
    const poll = event('m.poll.start', {
      'm.poll.start': { question: { 'm.text': [{ body: 'Are you sure?' }] },
        answers: [{ 'm.id': 'yes', 'm.text': [{ body: 'Yes' }] }] },
    }, { id: '$poll', sender: '@alice:example.org' })
    let attempts = 0
    const fetch = routeFetch((url) => {
      if (url.pathname.includes('/event/')) return json(poll)
      if (url.pathname.includes('/relations/')) return json({
        errcode: 'M_UNAVAILABLE', error: 'temporarily unavailable',
      }, { status: 503 })
      if (url.pathname.includes('/send/')) { attempts++; return json({ event_id: '$unexpected' }) }
      throw new Error(`unexpected request: ${url}`)
    })
    const response = await createPlatform(fetch).clickInlineButton(session, {
      conversationId: '!room:example.org', messageId: '$poll',
    }, { type: 'callback', text: 'Yes', data: 'matrix-poll-vote:0' })
    expect(response).toMatchObject({ alert: true, message: expect.stringContaining('无法验证') })
    expect(attempts).toBe(0)
  })

  it('updates the original poll keyboard when Matrix sync delivers a poll-end event', async () => {
    const roomId = '!room:example.org'
    const poll = event('m.poll.start', {
      'm.poll.start': {
        question: { 'm.text': [{ body: 'Lunch?' }] },
        answers: [{ 'm.id': 'rice', 'm.text': [{ body: 'Rice' }] }],
      },
    }, { id: '$poll', sender: '@alice:example.org', ts: 1_000 })
    const end = event('m.poll.end', {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'm.text': [{ body: 'Lunch poll ended' }],
    }, { id: '$end', sender: '@alice:example.org', ts: 2_000 })
    let sync = 0
    const fetch = routeFetch((url, init) => {
      if (url.pathname.includes('/event/')) return json(poll)
      if (!url.pathname.endsWith('/sync')) throw new Error(`unexpected request: ${url}`)
      sync++
      if (sync === 1) return json({
        next_batch: 'start', rooms: { join: { [roomId]: { state: { events: roomState } } } },
      })
      if (sync === 2) return json({
        next_batch: 'next', rooms: { join: { [roomId]: { timeline: { events: [poll, end] } } } },
      })
      return pendingUntilAbort(init?.signal)
    })
    const platform = createPlatform(fetch, { userId: '@me:example.org' })
    const events: IMEvent[] = []
    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.waitFor(() => expect(events).toHaveLength(3))
    await unsubscribe()
    expect(events.map((event) => event.type)).toEqual(['message', 'message', 'message-edit'])
    const opened = events[0], closed = events[2]
    if (opened?.type !== 'message' || closed?.type !== 'message-edit') throw new Error('wrong event types')
    expect(opened.message.content.inlineKeyboard?.rows).toHaveLength(1)
    expect(closed.message).toMatchObject({ id: '$poll' })
    expect(closed.message.content.inlineKeyboard).toBeUndefined()
  })


  it('backfills verified counts for a closed poll in Matrix history', async () => {
    const poll = event('m.poll.start', {
      'm.poll.start': {
        kind: 'm.poll.undisclosed',
        question: { 'm.text': [{ body: 'Best fruit?' }] },
        answers: [{ 'm.id': 'apple', 'm.text': [{ body: 'Apple' }] },
          { 'm.id': 'pear', 'm.text': [{ body: 'Pear' }] }],
      },
    }, { id: '$poll', sender: '@alice:example.org', ts: 1_000 })
    const end = event('m.poll.end', {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'm.text': [{ body: 'Voting closed' }],
      'm.poll.results': { apple: 9999 },
    }, { id: '$end', sender: '@alice:example.org', ts: 5_000 })
    const response = (id: string, sender: string, selection: string) =>
      event('m.poll.response', {
        'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
        'm.selections': [selection],
      }, { id, sender, ts: 4_000 })
    const fetch = routeFetch((url) => {
      if (url.pathname.endsWith('/messages')) return json({ chunk: [poll, end] })
      if (url.pathname.includes('/relations/')) return json({
        chunk: [response('$vote1', '@bob:example.org', 'apple'),
          response('$vote2', '@carol:example.org', 'pear'), end],
      })
      throw new Error(`unexpected request: ${url}`)
    })
    const platform = createPlatform(fetch)
    const messages = (await platform.getHistory(session, { id: '!room:example.org' })).messages
    expect(messages[0]).toMatchObject({ content: { parts: [{ type: 'poll', poll: {
      question: 'Best fruit?', closed: true, totalVoters: 2,
      counts: { apple: 1, pear: 1 },
    } }] } })
    expect(messages[0].content.inlineKeyboard).toBeUndefined()
  })

  it('parses valid geo URIs into map cards and preserves malformed locations as text', async () => {
    const fetch = routeFetch((url) => {
      if (!url.pathname.endsWith('/messages')) throw new Error(`unexpected request: ${url}`)
      return json({ chunk: [
        event('m.room.message', { msgtype: 'm.location', body: 'Big Ben', geo_uri: 'geo:51.5008,-0.1247;u=15' },
          { id: '$geo', sender: '@alice:example.org' }),
        event('m.room.message', { msgtype: 'm.location', body: 'Invalid point', geo_uri: 'geo:91,200' },
          { id: '$invalid', sender: '@alice:example.org' }),
        event('m.room.message', { msgtype: 'm.location', body: 'Missing URI' },
          { id: '$missing', sender: '@alice:example.org' }),
        event('m.room.message', { msgtype: 'm.location', body: 'Southwest edge', geo_uri: 'geo:-90,-180' },
          { id: '$edge', sender: '@alice:example.org' }),
        event('m.room.message', {
          msgtype: 'm.location', body: 'Old location',
          'm.location': { uri: 'geo:39.9,116.4;u=20', description: 'Beijing' },
          'm.text': 'Geographic coordinates',
        }, { id: '$extensible', sender: '@alice:example.org' }),
        event('m.location', {
          'm.location': { uri: 'geo:35.68,139.69', description: 'Tokyo' },
        }, { id: '$standalone', sender: '@alice:example.org' }),
        event('m.room.message', {
          msgtype: 'm.location',
          'org.matrix.msc3488.location': { uri: 'geo:23.1,113.3', description: 'Guangzhou' },
        }, { id: '$unstable', sender: '@alice:example.org' }),
        event('m.room.message', {
          msgtype: 'm.location', body: 'Legacy fallback',
          geo_uri: 'geo:37.56,126.97',
          'm.location': { uri: 'not a geo uri', description: 'Seoul' },
        }, { id: '$legacy-fallback', sender: '@alice:example.org' }),
      ] })
    })
    const platform = createPlatform(fetch)
    const page = await platform.getHistory(session, { id: '!room:example.org' })
    expect(page.messages[0]).toMatchObject({ content: { parts: [{ type: 'card', card: {
      kind: 'location', title: 'Big Ben', latitude: 51.5008, longitude: -0.1247,
      url: 'https://www.openstreetmap.org/?mlat=51.5008&mlon=-0.1247',
    } }] } })
    expect(page.messages[1]?.content.parts).toEqual([{ type: 'text', text: 'Invalid point' }])
    expect(page.messages[2]?.content.parts).toEqual([{ type: 'text', text: 'Missing URI' }])
    expect(page.messages[3]).toMatchObject({ content: { parts: [{ type: 'card', card: {
      latitude: -90, longitude: -180,
    } }] } })
    expect(page.messages[4]).toMatchObject({ content: { parts: [{ type: 'card', card: {
      title: 'Beijing', latitude: 39.9, longitude: 116.4,
    } }] } })
    expect(page.messages[5]).toMatchObject({ content: { parts: [{ type: 'card', card: {
      title: 'Tokyo', latitude: 35.68, longitude: 139.69,
    } }] } })
    expect(page.messages[6]).toMatchObject({ content: { parts: [{ type: 'card', card: {
      title: 'Guangzhou', latitude: 23.1, longitude: 113.3,
    } }] } })
    expect(page.messages[7]).toMatchObject({ content: { parts: [{ type: 'card', card: {
      title: 'Seoul', latitude: 37.56, longitude: 126.97,
    } }] } })
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
  roomState: (url: URL, init?: RequestInit) => Response | Promise<Response> = () => json([]),
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/state')) return roomState(url, init)
    return handler(url, init)
  }
}

function pendingUntilAbort(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
