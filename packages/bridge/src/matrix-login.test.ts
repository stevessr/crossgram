import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MatrixLoginError, clientAddress, matrixLogin, normalizeHomeserver,
  readMatrixLoginRequest, registerMatrixLoginRoute, resetRateLimits, sameState,
  type ServerRequest, type ServerResponse,
} from './matrix-login.js'

function fakeRequest(body: unknown, headers: Record<string, string> = {}): ServerRequest {
  const encoded = JSON.stringify(body)
  return {
    _req: { socket: { remoteAddress: '203.0.113.7' } } as never,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(encoded))
        controller.close()
      },
    }),
  }
}

function fakeResponse(): ServerResponse & { body?: unknown, statusCode: number } {
  const response: { body?: unknown, statusCode: number, headers: Headers, json(data: unknown): unknown, status: number } = {
    statusCode: 200,
    headers: new Headers(),
    json(data: unknown) {
      response.body = data
      return response
    },
    status: 200,
  }
  // Mirror the server plugin's `status` accessor onto the plain object.
  Object.defineProperty(response, 'status', {
    get: () => response.statusCode,
    set: (value: number) => { response.statusCode = value },
  })
  return response
}

function homeserverFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    handler(String(input), init)) as typeof globalThis.fetch
}

afterEach(() => {
  vi.restoreAllMocks()
  resetRateLimits()
})

describe('matrix login proxy', () => {
  it('normalizes homeserver origins and rejects unsafe URLs', () => {
    expect(normalizeHomeserver('https://matrix.example.org/')).toBe('https://matrix.example.org')
    expect(normalizeHomeserver('http://127.0.0.1:8008')).toBe('http://127.0.0.1:8008')
    expect(() => normalizeHomeserver('ftp://matrix.example.org')).toThrow(MatrixLoginError)
    expect(() => normalizeHomeserver('https://user:pass@matrix.example.org')).toThrow(/用户信息/)
    expect(() => normalizeHomeserver('not a url')).toThrow(MatrixLoginError)
  })

  it('logs in with a password and forwards only the picked fields', async () => {
    let sentBody: unknown
    let sentPath = ''
    const result = await matrixLogin({
      homeserver: 'https://matrix.example.org',
      userId: '@alice:example.org',
      password: 'secret',
    }, homeserverFetch((url, init) => {
      sentPath = url
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ user_id: '@alice:example.org', access_token: 'syt-1', device_id: 'DEV' })
    }))
    expect(result).toEqual({ accessToken: 'syt-1', userId: '@alice:example.org', deviceId: 'DEV' })
    expect(sentPath).toBe('https://matrix.example.org/_matrix/client/v3/login')
    expect(sentBody).toMatchObject({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: '@alice:example.org' },
      password: 'secret',
      initial_device_display_name: 'CrossGram relay',
    })
  })

  it('logs in with an SSO verification token and rejects mixed credentials', async () => {
    const fetch = homeserverFetch(() =>
      Response.json({ user_id: '@bob:example.org', access_token: 'syt-2', device_id: 'DEV2' }))
    await expect(matrixLogin({ homeserver: 'https://matrix.example.org', loginToken: 'one-time' }, fetch))
      .resolves.toMatchObject({ accessToken: 'syt-2', userId: '@bob:example.org' })
    await expect(matrixLogin({
      homeserver: 'https://matrix.example.org', loginToken: 'one-time', password: 'x',
    }, fetch)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' })
  })

  it('maps homeserver failures to UI-actionable errors without inventing detail', async () => {
    const fetch = homeserverFetch(() =>
      Response.json({ errcode: 'M_FORBIDDEN', error: 'Invalid username or password' }, { status: 403 }))
    await expect(matrixLogin({
      homeserver: 'https://matrix.example.org', userId: '@a:example.org', password: 'bad',
    }, fetch)).rejects.toMatchObject({ status: 401, code: 'M_FORBIDDEN' })
    expect(matrixLogin).toBeDefined()
    const unreachable = (async () => Response.json({}, { status: 599 })) as typeof globalThis.fetch
    await expect(matrixLogin({
      homeserver: 'https://matrix.example.org', userId: '@a:example.org', password: 'x',
    }, unreachable)).rejects.toMatchObject({ status: 502 })
  })

  it('rejects malformed user IDs and incomplete homeserver responses', async () => {
    await expect(matrixLogin({
      homeserver: 'https://matrix.example.org', userId: 'alice', password: 'x',
    }, homeserverFetch(() => Response.json({})))).rejects.toMatchObject({ code: 'INVALID_USER_ID' })
    const incomplete = homeserverFetch(() => Response.json({ access_token: 'only-token' }))
    await expect(matrixLogin({
      homeserver: 'https://matrix.example.org', userId: '@a:example.org', password: 'x',
    }, incomplete)).rejects.toMatchObject({ code: 'LOGIN_FAILED' })
  })

  it('reads bounded JSON bodies from the server request', async () => {
    const request = await readMatrixLoginRequest(fakeRequest({ homeserver: 'https://matrix.example.org' }))
    expect(request.homeserver).toBe('https://matrix.example.org')
    const oversized = fakeRequest({ homeserver: 'https://' + 'a'.repeat(9_000) + '.org' })
    await expect(readMatrixLoginRequest(oversized)).rejects.toMatchObject({ status: 413 })
    expect((oversized as { body: ReadableStream }).body.locked).toBe(true)
  })

  it('rate limits repeated attempts per client address', async () => {
    const handler = vi.fn(async () => Response.json({ errcode: 'M_FORBIDDEN', error: 'no' }, { status: 403 }))
    const routes = new Map<string, (req: ServerRequest, res: ServerResponse) => Promise<void>>()
    registerMatrixLoginRoute(
      { server: { post(path, postHandler) { routes.set(path, postHandler) } } } as never,
      '/api',
      homeserverFetch(handler),
    )
    const login = routes.get('/api/matrix/login')!
    const results: Array<PromiseSettledResult<unknown>> = []
    for (let attempt = 0; attempt < 14; attempt++) {
      const response = fakeResponse()
      try {
        await login(fakeRequest({
          homeserver: 'https://matrix.example.org', userId: '@a:example.org', password: 'x',
        }) as never, response as never)
        results.push({ status: 'fulfilled', value: response.body })
      } catch (reason) {
        results.push({ status: 'rejected', reason })
      }
    }
    const limited = results.filter(item => item.status === 'fulfilled'
      && (item.value as { error?: string }).error === 'TOO_MANY_ATTEMPTS')
    expect(limited.length).toBeGreaterThan(0)
    expect(handler.mock.calls.length).toBeLessThan(14)
  })

  it('exposes the route with a bounded JSON handler and error mapping', async () => {
    const routes = new Map<string, (req: ServerRequest, res: ServerResponse) => Promise<void>>()
    const ctx = { server: { post(path: string, handler: never) { routes.set(path, handler) } } }
    const fetch = homeserverFetch(() =>
      Response.json({ user_id: '@alice:example.org', access_token: 'syt-route', device_id: 'DEV' }))
    registerMatrixLoginRoute(ctx as never, '/api', fetch)
    const handler = routes.get('/api/matrix/login')!
    expect(handler).toBeTypeOf('function')

    const good = fakeResponse()
    await handler(fakeRequest({
      homeserver: 'https://matrix.example.org', userId: '@alice:example.org', password: 'pw',
    }) as never, good as never)
    expect(good.statusCode).toBe(200)
    expect((good.body as { accessToken?: string }).accessToken).toBe('syt-route')

    const bad = fakeResponse()
    await handler(fakeRequest({ homeserver: 'https://matrix.example.org', password: 'pw' }) as never, bad as never)
    expect(bad.statusCode).toBe(400)
    expect(bad.body).toMatchObject({ error: 'INVALID_REQUEST' })
  })

  it('buckets client addresses behind proxy headers and compares states in constant time', () => {
    const forwarded = clientAddress(fakeRequest({}, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }))
    expect(forwarded).toBe('198.51.100.9')
    expect(clientAddress(fakeRequest({}))).toBe('203.0.113.7')
    expect(sameState('abc', 'abc')).toBe(true)
    expect(sameState('abc', 'abd')).toBe(false)
    expect(sameState('abc', 'abcd')).toBe(false)
  })
})
