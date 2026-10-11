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

    expect(members.total).toBe(2)
    expect(members.members.find((item) => item.user.id === '@alice:example.org')).toMatchObject({
      role: 'member', permissions: { inviteMembers: true, deleteAnyMessage: false },
    })
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
): typeof globalThis.fetch {
  return async (input, init) => handler(new URL(String(input)), init)
}

function pendingUntilAbort(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
