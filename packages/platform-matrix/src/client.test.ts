import { describe, expect, it, vi } from 'vitest'
import { MatrixClient, MatrixHttpError, parseMxc } from './client.js'

describe('MatrixClient', () => {
  it('authenticates requests, encodes Matrix IDs, and serializes query parameters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/_matrix/client/v3/rooms/!room%3Aexample.org/messages')
      expect(url.searchParams.get('dir')).toBe('f')
      expect(url.searchParams.get('limit')).toBe('7')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
      return Response.json({ chunk: [], end: 'next' })
    })
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org/', accessToken: 'test-token', fetch,
    })

    await expect(client.getMessages('!room:example.org', { dir: 'f', limit: 7 }))
      .resolves.toEqual({ chunk: [], end: 'next' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('surfaces structured Matrix errors', async () => {
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org',
      accessToken: 'expired',
      fetch: async () => Response.json({
        errcode: 'M_UNKNOWN_TOKEN', error: 'Access token is invalid',
      }, { status: 401 }),
    })

    const error = await client.whoAmI().catch((value) => value)
    expect(error).toBeInstanceOf(MatrixHttpError)
    expect(error).toMatchObject({ status: 401, errcode: 'M_UNKNOWN_TOKEN', message: 'Access token is invalid' })
  })

  it('accepts HTTP(S) proxies and rejects unsupported proxy protocols', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ user_id: '@me:example.org' }))
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token', proxy: '  http://127.0.0.1:7890  ', fetch,
    })

    await expect(client.whoAmI()).resolves.toEqual({ user_id: '@me:example.org' })
    expect(() => new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token', proxy: 'socks5://127.0.0.1:1080', fetch,
    })).toThrow('Matrix proxy must use http:// or https://: socks5:')
    expect(() => new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token', proxy: 'not a URL', fetch,
    })).toThrow()
    await client.close()
  })

  it('uploads binary data with progress and downloads an mxc URI', async () => {
    const requests: Array<{ url: URL, method: string, body?: Uint8Array }> = []
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org',
      accessToken: 'secret',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const requestBody = init?.body instanceof ReadableStream
          ? new Uint8Array(await new Response(init.body).arrayBuffer())
          : init?.body instanceof Uint8Array ? init.body : undefined
        requests.push({
          url,
          method: init?.method ?? 'GET',
          body: requestBody,
        })
        if (url.pathname.endsWith('/upload')) return Response.json({ content_uri: 'mxc://cdn.example/id' })
        return new Response(new Uint8Array([4, 5, 6]))
      },
    })
    const progress: number[] = []
    const mxc = await client.upload((async function* () {
      yield new Uint8Array([1, 2])
      yield new Uint8Array([3])
    })(), {
      filename: 'a b.bin', contentType: 'application/octet-stream',
      onChunk: (size) => { progress.push(size) },
    })
    const download = await client.download(mxc)

    expect(mxc).toBe('mxc://cdn.example/id')
    expect(progress).toEqual([2, 1])
    expect(requests[0]?.url.searchParams.get('filename')).toBe('a b.bin')
    expect(requests[0]?.body).toEqual(new Uint8Array([1, 2, 3]))
    expect(requests[1]?.url.pathname).toBe('/_matrix/media/v3/download/cdn.example/id')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('uses unique transaction IDs for sends and redactions', async () => {
    const paths: string[] = []
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'secret',
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname)
        return Response.json({ event_id: `$event-${paths.length}` })
      },
    })

    await client.sendEvent('!r:hs', 'm.room.message', { body: 'one' })
    await client.sendEvent('!r:hs', 'm.room.message', { body: 'two' })
    await client.redactEvent('!r:hs', '$event/with/slash')

    expect(paths[0]).not.toBe(paths[1])
    expect(paths[2]).toMatch(/\/redact\/%24event%2Fwith%2Fslash\//)
  })

  it('uses room state for pins and account push rules for notifications', async () => {
    const pins = ['$initial']
    let muted = false
    const writes: Array<{ path: string, method: string, body?: unknown }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      writes.push({ path: url.pathname, method, body })
      if (url.pathname.endsWith('/state/m.room.pinned_events')) {
        if (method === 'GET') return Response.json({ pinned: pins })
        pins.splice(0, pins.length, ...body.pinned)
        return Response.json({ event_id: '$state-event' })
      }
      if (url.pathname.includes('/pushrules/global/room/')) {
        if (method === 'GET') return muted
          ? Response.json({ actions: ['dont_notify'], enabled: true })
          : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
        if (method === 'PUT') { muted = true; return Response.json({}) }
        if (method === 'DELETE') { muted = false; return Response.json({}) }
      }
      throw new Error(`unexpected Matrix request: ${url}`)
    })
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const roomId = '!r:example.org'
    await expect(client.getRoomPinnedEvents(roomId)).resolves.toEqual(['$initial'])
    await client.setRoomPinnedEvents(roomId, ['$initial', '$second'])
    expect(pins).toEqual(['$initial', '$second'])
    expect(writes.find((item) => item.method === 'PUT')?.body)
      .toEqual({ pinned: ['$initial', '$second'] })
    await expect(client.getRoomNotificationMuted(roomId)).resolves.toBe(false)
    await client.setRoomNotificationMuted(roomId, true)
    await expect(client.getRoomNotificationMuted(roomId)).resolves.toBe(true)
    await client.setRoomNotificationMuted(roomId, false)
    await expect(client.getRoomNotificationMuted(roomId)).resolves.toBe(false)
    expect(writes.filter((item) => item.path.includes('/pushrules/') && item.method === 'PUT'))
      .toHaveLength(1)
    expect(writes.filter((item) => item.path.includes('/pushrules/') && item.method === 'DELETE'))
      .toHaveLength(1)
  })

  it('preserves custom push rule tweaks when toggling room mute', async () => {
    let rule: { actions: Array<string | { set_tweak: string, value: boolean }>, enabled?: boolean } = {
      actions: ['dont_notify', { set_tweak: 'highlight', value: false }],
      enabled: true,
    }
    const requests: Array<{ method: string, body?: unknown }> = []
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async (_input, init) => {
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        requests.push({ method, body })
        if (method === 'GET') return Response.json(rule)
        if (method === 'PUT') {
          if (body.actions) rule.actions = body.actions
          if (body.enabled !== undefined) rule.enabled = body.enabled
          return Response.json({})
        }
        return Response.json({})
      },
    })
    const id = '!custom:example.org'
    await client.setRoomNotificationMuted(id, false)
    expect(rule.actions).toEqual([
      'notify', { set_tweak: 'highlight', value: false },
    ])
    await client.setRoomNotificationMuted(id, true)
    expect(rule.actions).toEqual([
      'dont_notify', { set_tweak: 'highlight', value: false },
    ])
    rule.enabled = false
    await client.setRoomNotificationMuted(id, true)
    expect(requests.filter((entry) => (entry.body as { enabled?: boolean })?.enabled === true))
      .toHaveLength(1)
    expect(rule.enabled).toBe(true)
  })

  it('treats missing pinned state as empty but preserves non-404 errors', async () => {
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async () => Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }),
    })
    await expect(client.getRoomPinnedEvents('!room:example.org')).resolves.toEqual([])
    const unavailable = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async () => Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }),
    })
    await expect(unavailable.getRoomPinnedEvents('!room:example.org')).rejects.toMatchObject({
      status: 403, errcode: 'M_FORBIDDEN',
    })
    await expect(unavailable.getRoomNotificationMuted('!room:example.org')).rejects.toMatchObject({
      status: 403,
    })
  })

  it('validates Matrix content URIs', () => {
    expect(parseMxc('mxc://example.org/a/b')).toEqual({ serverName: 'example.org', mediaId: 'a/b' })
    expect(() => parseMxc('https://example.org/a')).toThrow(/invalid Matrix content URI/)
  })
})
