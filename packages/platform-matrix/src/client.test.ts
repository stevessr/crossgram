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

  it('fetches typed Matrix relations with encoded IDs and pagination', async () => {
    let request: URL | undefined
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org',
      accessToken: 'token',
      fetch: async (input) => {
        request = new URL(String(input))
        return Response.json({ chunk: [], next_batch: 'page-2' })
      },
    })

    await expect(client.getRelations('!room:example.org', '$event/with space', 'm.annotation', {
      from: 'page token', limit: 50,
    })).resolves.toEqual({ chunk: [], next_batch: 'page-2' })
    expect(request?.pathname).toBe(
      '/_matrix/client/v1/rooms/!room%3Aexample.org/relations/%24event%2Fwith%20space/m.annotation',
    )
    expect(request?.searchParams.get('from')).toBe('page token')
    expect(request?.searchParams.get('limit')).toBe('50')
  })

  it.each([
    ['M_UNRECOGNIZED', 404, true], ['M_FORBIDDEN', 403, false], ['M_NOT_FOUND', 404, false],
  ] as const)('only downgrades authenticated media for unsupported endpoints: %s', async (errcode, status, fallback) => {
    const paths: string[] = []
    const client = new MatrixClient({ homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async (input, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token')
        paths.push(new URL(String(input)).pathname)
        return paths.length === 1 ? Response.json({ errcode, error: errcode }, { status })
          : new Response(new Uint8Array([1, 2]))
      },
    })
    if (fallback) expect(await client.download('mxc://test/media')).toBeInstanceOf(Response)
    else await expect(client.download('mxc://test/media')).rejects.toMatchObject({ status, errcode })
    expect(paths).toEqual(fallback ? ['/_matrix/client/v1/media/download/test/media', '/_matrix/media/v3/download/test/media']
      : ['/_matrix/client/v1/media/download/test/media'])
    await client.close()
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
    expect(requests[1]?.url.pathname).toBe('/_matrix/client/v1/media/download/cdn.example/id')
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

  it('mutes rooms through Element-compatible override push rules', async () => {
    const rules: Record<string, { actions: string[], enabled?: boolean } | null> = {
      override: null,
      room: null,
    }
    const writes: Array<{ path: string, method: string, body?: unknown }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const kind = url.pathname.includes('/pushrules/global/override/')
        ? 'override' : url.pathname.includes('/pushrules/global/room/') ? 'room' : undefined
      if (kind) {
        writes.push({ path: url.pathname, method, body })
        if (method === 'GET') {
          return rules[kind]
            ? Response.json(rules[kind])
            : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
        }
        if (method === 'PUT') {
          rules[kind] = { actions: body.actions, enabled: true }
          return Response.json({})
        }
        if (method === 'DELETE') {
          rules[kind] = null
          return Response.json({})
        }
      }
      throw new Error(`unexpected Matrix request: ${url}`)
    })
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token', fetch,
    })
    const roomId = '!r:example.org'
    await expect(client.getRoomNotificationMuted(roomId)).resolves.toBe(false)
    await client.setRoomNotificationMuted(roomId, true)
    // The mute lands in the override kind with Element's room_id condition.
    expect(rules.override).toMatchObject({ actions: [] })
    expect(writes.find((item) => item.method === 'PUT')?.body).toMatchObject({
      conditions: [{ kind: 'event_match', key: 'room_id', pattern: roomId }],
      actions: [],
    })
    await expect(client.getRoomNotificationMuted(roomId)).resolves.toBe(true)
    await client.setRoomNotificationMuted(roomId, false)
    expect(rules.override).toBeNull()
    await expect(client.getRoomNotificationMuted(roomId)).resolves.toBe(false)
  })

  it('reads Element-style empty override actions as muted and keeps legacy room rules in sync', async () => {
    // Element wrote an override rule with empty actions: muted.
    let override: { actions: string[], enabled?: boolean } | null = { actions: [], enabled: true }
    let room: { actions: string[], enabled?: boolean } | null = null
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        if (url.pathname.includes('/pushrules/global/override/')) {
          if (method === 'GET') return override ? Response.json(override) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
          if (method === 'DELETE') { override = null; return Response.json({}) }
        }
        if (url.pathname.includes('/pushrules/global/room/')) {
          if (method === 'GET') return room ? Response.json(room) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
          if (method === 'PUT') { room = { actions: JSON.parse(init?.body as string).actions, enabled: true }; return Response.json({}) }
          if (method === 'DELETE') { room = null; return Response.json({}) }
        }
        throw new Error(`unexpected Matrix request: ${url}`)
      },
    })
    const id = '!muted:example.org'
    await expect(client.getRoomNotificationMuted(id)).resolves.toBe(true)
    // A notify override unmutes despite the room kind.
    override = { actions: ['notify'], enabled: true }
    await expect(client.getRoomNotificationMuted(id)).resolves.toBe(false)
    // A disabled override falls back to the room-kind rule.
    override = { actions: [], enabled: false }
    room = { actions: ['dont_notify'], enabled: true }
    await expect(client.getRoomNotificationMuted(id)).resolves.toBe(true)
    // Unmuting removes the override and clears the legacy room-kind mute.
    await client.setRoomNotificationMuted(id, false)
    expect(override).toBeNull()
    expect(room).toBeNull()
  })

  it('cleans up a legacy room-kind dont_notify rule when muting', async () => {
    let room: { actions: Array<string | Record<string, unknown>>, enabled?: boolean } | null = {
      actions: ['dont_notify', { set_tweak: 'highlight', value: false }], enabled: true,
    }
    let override: Record<string, unknown> | null = null
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        if (url.pathname.includes('/pushrules/global/override/')) {
          if (method === 'GET') return override ? Response.json(override) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
          if (method === 'PUT') { override = body; return Response.json({}) }
        }
        if (url.pathname.includes('/pushrules/global/room/')) {
          if (method === 'GET') return room ? Response.json(room) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 })
          if (method === 'PUT') { room = { actions: body.actions, enabled: true }; return Response.json({}) }
          if (method === 'DELETE') { room = null; return Response.json({}) }
        }
        throw new Error(`unexpected Matrix request: ${url}`)
      },
    })
    await client.setRoomNotificationMuted('!legacy:example.org', true)
    expect(override).toMatchObject({ actions: [] })
    // Tweaks survive the legacy-rule rewrite; dont_notify is replaced by notify.
    expect(room?.actions).toEqual(['notify', { set_tweak: 'highlight', value: false }])
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

  it('logs in with a password and reports a fresh token without storing it', async () => {
    const requests: Array<{ path: string, body: unknown, auth?: string }> = []
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'stale-token',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        requests.push({
          path: url.pathname,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
          auth: new Headers(init?.headers).get('authorization') ?? undefined,
        })
        if (url.pathname.endsWith('/login')) {
          return Response.json({ user_id: '@me:example.org', access_token: 'syt-fresh', device_id: 'DEVICE1' })
        }
        if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 })
        if (url.pathname.endsWith('/devices')) {
          return Response.json({ devices: [{ device_id: 'DEVICE1', display_name: 'CrossGram relay' }] })
        }
        throw new Error(`unexpected ${url.pathname}`)
      },
    })

    const login = await client.loginWithPassword('@me:example.org', 'hunter2')
    expect(login).toEqual({ user_id: '@me:example.org', access_token: 'syt-fresh', device_id: 'DEVICE1' })
    expect(requests.at(-1)).toMatchObject({
      path: '/_matrix/client/v3/login',
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: '@me:example.org' },
        password: 'hunter2',
        initial_device_display_name: 'CrossGram relay',
      },
      // Login must not carry the stale configured token.
      auth: 'Bearer stale-token',
    })

    const tokenLogin = await client.loginWithToken('sso-verification-token', 'CrossGram relay')
    expect(tokenLogin.access_token).toBe('syt-fresh')
    expect(requests.at(-1)).toMatchObject({
      path: '/_matrix/client/v3/login',
      body: { type: 'm.login.token', token: 'sso-verification-token', initial_device_display_name: 'CrossGram relay' },
    })

    await client.logout('syt-fresh')
    expect(requests.at(-1)).toMatchObject({ path: '/_matrix/client/v3/logout', auth: 'Bearer syt-fresh' })

    const devices = await client.getDevices('syt-fresh')
    expect(devices.devices[0]).toMatchObject({ device_id: 'DEVICE1', display_name: 'CrossGram relay' })
    expect(requests.at(-1)).toMatchObject({ path: '/_matrix/client/v3/devices', auth: 'Bearer syt-fresh' })
  })

  it('builds the SSO redirect URL with an encoded callback', async () => {
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async () => Response.json({}),
    })
    expect(client.ssoRedirectUrl('https://relay.example.org/matrix/sso?next=/a b'))
      .toBe('https://matrix.example.org/_matrix/client/v3/login/sso/redirect?redirectUrl=https%3A%2F%2Frelay.example.org%2Fmatrix%2Fsso%3Fnext%3D%2Fa%20b')
    await client.close()
  })

  it('surfaces homeserver rate limiting as a retry-after hint', async () => {
    const client = new MatrixClient({
      homeserver: 'https://matrix.example.org', accessToken: 'token',
      fetch: async () => Response.json(
        { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 7500 },
        { status: 429 },
      ),
    })
    await expect(client.whoAmI()).rejects.toMatchObject({
      status: 429, errcode: 'M_LIMIT_EXCEEDED', retryAfterMs: 7500,
    })
    await client.close()
  })
})
