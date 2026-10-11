import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { MatrixClient } from './client.js'
import { MatrixPlatform } from './index.js'

const session: PlatformSession = {
  platformSessionId: 'matrix-test',
  platformId: 'matrix',
  userId: '@me:example.org',
  credentials: {},
  metadata: {},
}
const room = { id: '!room:example.org' }

function message(id: string, msgtype: string, body: string, ts: number, roomId = room.id) {
  return {
    type: 'm.room.message',
    room_id: roomId,
    event_id: id,
    sender: '@alice:example.org',
    origin_server_ts: ts,
    content: {
      msgtype,
      body,
      ...(msgtype === 'm.text' ? {} : {
        url: 'mxc://example.org/' + id,
        info: { mimetype: msgtype === 'm.image' ? 'image/png' : 'application/octet-stream' },
      }),
    },
  }
}

describe('Matrix room message search', () => {
  it('uses authenticated Matrix POST /search with the room, sender, and pagination filters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/_matrix/client/v3/search')
      expect(url.searchParams.get('next_batch')).toBe('opaque + token')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
      expect(JSON.parse(String(init?.body))).toEqual({
        search_categories: {
          room_events: {
            search_term: 'hello',
            keys: ['content.body'],
            order_by: 'recent',
            filter: {
              rooms: [room.id],
              types: ['m.room.message'],
              limit: 7,
              senders: ['@alice:example.org'],
            },
          },
        },
      })
      return Response.json({ search_categories: { room_events: { count: 1, results: [] } } })
    })
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'secret', fetch,
    })
    await expect(client.searchRoomEvents({
      searchTerm: 'hello', roomId: room.id, fromUserId: '@alice:example.org',
      limit: 7, nextBatch: 'opaque + token',
    })).resolves.toMatchObject({ search_categories: { room_events: { count: 1 } } })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('maps server search results into bridge messages and preserves the opaque cursor and count', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      search_categories: {
        room_events: {
          count: 4,
          next_batch: 'next-search-page',
          results: [{ result: message('$text', 'm.text', 'hello world', 5_000) }],
        },
      },
    }))
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    expect(platform.capabilities.search).toBe(true)
    const result = await platform.searchMessages(session, room, { query: 'hello', limit: 1 })
    expect(result).toMatchObject({
      total: 4,
      nextCursor: 'next-search-page',
      messages: [{
        id: '$text',
        conversationId: room.id,
        senderId: '@alice:example.org',
        timestamp: 5,
        content: { parts: [{ type: 'text', text: 'hello world' }] },
      }],
    })
  })

  it('filters time and media, and advances upstream pages without skipping matching results', async () => {
    const responses = [
      { next_batch: 's1', results: [{ result: message('$text', 'm.text', 'photo text', 5_000) }] },
      { next_batch: 's2', results: [{ result: message('$old', 'm.image', 'old photo', 1_000) }] },
      { next_batch: 's3', results: [{ result: message('$photo', 'm.image', 'recent photo', 7_000) }] },
      { results: [{ result: message('$other', 'm.image', 'other photo', 8_000) }] },
    ]
    const cursors: Array<string | null> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      cursors.push(url.searchParams.get('next_batch'))
      const body = JSON.parse(String(init?.body))
      expect(body.search_categories.room_events.filter.senders).toEqual(['@alice:example.org'])
      expect(body.search_categories.room_events.filter.rooms).toEqual([room.id])
      expect(body.search_categories.room_events.filter.limit).toBe(1)
      return Response.json({
        search_categories: { room_events: { count: 4, ...responses[cursors.length - 1] } },
      })
    })
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const query = {
      query: 'photo', limit: 1, fromUserId: '@alice:example.org',
      minTimestamp: 4, maxTimestamp: 10, mediaKind: 'image' as const,
    }
    const first = await platform.searchMessages(session, room, query)
    expect(first.messages.map((item) => item.id)).toEqual(['$photo'])
    expect(first.messages[0]?.content.parts[0]).toMatchObject({
      type: 'media', media: { kind: 'image', locator: { mxc: 'mxc://example.org/$photo' } },
    })
    expect(first.nextCursor).toBe('s3')
    expect(first.total).toBeUndefined()

    const next = await platform.searchMessages(session, room, { ...query, cursor: first.nextCursor })
    expect(next.messages.map((item) => item.id)).toEqual(['$other'])
    expect(next.nextCursor).toBeUndefined()
    expect(cursors).toEqual([null, 's1', 's2', 's3'])
  })

  it('scans filtered room history for searches with filters but no text term', async () => {
    const paths: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input))
      paths.push(url.pathname)
      expect(url.pathname).toBe('/_matrix/client/v3/rooms/!room%3Aexample.org/messages')
      expect(url.searchParams.get('dir')).toBe('b')
      expect(JSON.parse(url.searchParams.get('filter') ?? '{}')).toEqual({
        types: ['m.room.message'],
        senders: ['@alice:example.org'],
      })
      return Response.json(paths.length === 1
        ? { end: 'p1', chunk: [message('$old', 'm.file', 'old-file', 1_000)] }
        : { end: 'p2', chunk: [message('$file', 'm.file', 'new-file', 6_000)] })
    })
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const result = await platform.searchMessages(session, room, {
      query: ' ', fromUserId: '@alice:example.org', mediaKind: 'file',
      minTimestamp: 3, limit: 1,
    })
    expect(result.messages.map((item) => item.id)).toEqual(['$file'])
    expect(result.nextCursor).toBe('p2')
    expect(paths).toHaveLength(2)
  })

  it('scans history for empty-term searches, allowing bridge-native link and combined media filters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/_matrix/client/v3/rooms/!room%3Aexample.org/messages')
      expect(url.searchParams.get('dir')).toBe('b')
      return Response.json({
        chunk: [message('$link', 'm.text', 'https://matrix.org', 5_000)],
      })
    })
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const result = await platform.searchMessages(session, room, { query: '', limit: 10 })
    expect(result.messages.map((item) => item.id)).toEqual(['$link'])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('paginates past empty server result batches instead of treating them as completion', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input))
      const cursor = url.searchParams.get('next_batch')
      return Response.json({ search_categories: { room_events: cursor === 'continue'
        ? { results: [{ result: message('$found', 'm.text', 'hello', 3_000) }] }
        : { next_batch: 'continue', results: [] },
      } })
    })
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const result = await platform.searchMessages(session, room, { query: 'hello', limit: 1 })
    expect(result.messages.map((item) => item.id)).toEqual(['$found'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects out-of-room, wrong-sender and out-of-range events before projection', async () => {
    const wrongSender = {
      ...message('$sender', 'm.image', 'image', 5_000),
      sender: '@mallory:example.org',
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      search_categories: { room_events: { results: [
        { result: message('$wrong-room', 'm.image', 'image', 5_000, '!other:example.org') },
        { result: wrongSender },
        { result: message('$old', 'm.image', 'image', 4_000) },
        { result: message('$valid', 'm.image', 'image', 5_000) },
        { result: message('$valid', 'm.image', 'image', 5_000) },
      ] } },
    }))
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const result = await platform.searchMessages(session, room, {
      query: 'image', fromUserId: '@alice:example.org',
      minTimestamp: 5, maxTimestamp: 5, mediaKind: 'image',
    })
    expect(result.messages.map((item) => item.id)).toEqual(['$valid'])
    expect(result.total).toBeUndefined()
    expect(result.nextCursor).toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('treats repeated upstream pagination tokens as exhausted, avoiding bridge retry loops', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(new URL(String(input)).searchParams.get('next_batch')).toBe('stalled')
      return Response.json({ search_categories: { room_events: {
        next_batch: 'stalled',
        results: [{ result: message('$text', 'm.text', 'hello', 5_000) }],
      } } })
    })
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const result = await platform.searchMessages(session, room, {
      query: 'hello', cursor: 'stalled', mediaKind: 'image', limit: 1,
    })
    expect(result).toEqual({ messages: [], nextCursor: undefined })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not dispatch inverted time ranges or zero-limit searches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const platform = new MatrixPlatform({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    await expect(platform.searchMessages(session, room, {
      query: 'hello', minTimestamp: 10, maxTimestamp: 1,
    })).resolves.toEqual({ messages: [] })
    await expect(platform.searchMessages(session, room, { query: '', limit: 0 }))
      .resolves.toEqual({ messages: [] })
    expect(fetch).not.toHaveBeenCalled()
  })
})
