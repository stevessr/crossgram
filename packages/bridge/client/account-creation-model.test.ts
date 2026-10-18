import { describe, expect, it, vi } from 'vitest'
import {
  beginMatrixSso, buildAccountConfiguration, consumeMatrixSsoState,
  createPlatformPlugin, findLoaderEntry, initialAccountDraft, matrixAccountLogin,
  MATRIX_SSO_KEY, updatePlatformPluginConfig,
} from './account-creation-model.js'

describe('WebUI account onboarding', () => {
  it('only accepts the installed platform adapter allowlist', () => {
    const model = initialAccountDraft()
    expect(buildAccountConfiguration(model)).toEqual({
      name: '@mtproto-relay/platform-qqnt', label: 'QQ / QQNT',
      config: {
        endpoint: 'http://127.0.0.1:18767/v1',
        webSocketEndpoint: 'ws://127.0.0.1:18767/v1/events/ws',
      },
    })
    expect(() => buildAccountConfiguration({ ...model, platform: 'evil' as any }))
      .toThrow('不支持的账号平台')
  })

  it('validates remote platform credentials without leaking them in the error', () => {
    const model = initialAccountDraft()
    const secret = 'a-private-user-access-token'
    const matrix = {
      ...model, platform: 'matrix' as const, homeserver: 'https://example.org/',
      accessToken: secret, userId: '@alice:example.org', proxy: 'http://127.0.0.1:7890',
    }
    expect(buildAccountConfiguration(matrix)).toEqual({
      name: '@mtproto-relay/platform-matrix', label: 'Matrix',
      config: {
        homeserver: 'https://example.org', accessToken: secret,
        userId: '@alice:example.org', proxy: 'http://127.0.0.1:7890',
      },
    })
    expect(() => buildAccountConfiguration({ ...matrix, homeserver: 'https://example.org/_matrix/client/v3' }))
      .toThrow('根地址')
    expect(() => buildAccountConfiguration({ ...matrix, proxy: 'http://user:password@example.org:8888' }))
      .toThrow('代理')
    expect(() => buildAccountConfiguration({ ...matrix, accessToken: '' }))
      .toThrow('Access Token')
    expect(() => buildAccountConfiguration({ ...matrix, homeserver: 'javascript:alert(1)' }))
      .toThrow('HTTP(S)')
  })

  it('validates QQ, Discord, WeChat and already-authorized Telegram sessions', () => {
    const draft = initialAccountDraft()
    expect(() => buildAccountConfiguration({ ...draft, endpoint: 'http://admin:password@localhost:1/' }))
      .toThrow('QQNT API')
    expect(buildAccountConfiguration({ ...draft, platform: 'discord', token: 'USER-TOKEN' }))
      .toEqual({
        name: '@mtproto-relay/platform-discord', label: 'Discord',
        config: { token: 'USER-TOKEN' },
      })
    expect(buildAccountConfiguration({
      ...draft, platform: 'wechat', endpoint: 'http://localhost:18888/api/',
      callbackPort: '23457',
    }).config).toEqual({ endpoint: 'http://localhost:18888/api/', callbackPort: 23457 })
    expect(() => buildAccountConfiguration({ ...draft, platform: 'wechat', callbackPort: '65536' }))
      .toThrow('1 至 65535')
    const telegram = {
      ...draft, platform: 'telegram' as const, apiId: '12345', apiHash: 'HASH',
      storage: '/var/lib/crossgram/accounts/private.session',
    }
    expect(buildAccountConfiguration(telegram).config).toEqual({
      apiId: 12345, apiHash: 'HASH', storage: '/var/lib/crossgram/accounts/private.session',
    })
    expect(() => buildAccountConfiguration({ ...telegram, storage: 'relative/session' }))
      .toThrow('绝对路径')
    expect(() => buildAccountConfiguration({ ...telegram, apiId: 'NaN' }))
      .toThrow('正整数')
  })

  it('discovers the actual loader WebUI RPC entry rather than guessing IDs', () => {
    expect(findLoaderEntry({
      notLoader: { module: 'bridge', methods: ['createConfig', 'updateConfig'] },
      incomplete: { module: 'loader', methods: ['createConfig'] },
      realLoader: { module: 'loader', methods: ['createConfig', 'updateConfig'] },
    })).toBe('realLoader')
    expect(findLoaderEntry({})).toBeUndefined()
  })

  it('creates disabled with credentials and enables only after complete configuration', async () => {
    const rpc = vi.fn(async (_id, method, args) =>
      method === 'createConfig' ? 'workspace/matrix-new' : undefined)
    const draft = {
      ...initialAccountDraft(), platform: 'matrix' as const,
      homeserver: 'https://matrix.org', accessToken: 'SECRET',
    }
    await expect(createPlatformPlugin(rpc, 'loader-id', draft)).resolves.toBe('workspace/matrix-new')
    expect(rpc).toHaveBeenNthCalledWith(1, 'loader-id', 'createConfig', [{
      name: '@mtproto-relay/platform-matrix', label: 'Matrix',
      config: { homeserver: 'https://matrix.org', accessToken: 'SECRET' },
      disabled: true,
    }])
    expect(rpc).toHaveBeenNthCalledWith(2, 'loader-id', 'updateConfig', [{
      id: 'workspace/matrix-new', disabled: false,
    }])
  })

  it('fails closed on invalid configuration and leaves a failed activation recoverable', async () => {
    const rpc = vi.fn(async (_id, method) => {
      if (method === 'createConfig') return 'saved-but-disabled'
      throw new Error('failed to start')
    })
    await expect(createPlatformPlugin(rpc, 'loader', {
      ...initialAccountDraft(), platform: 'discord', token: 'token',
    })).rejects.toThrow('已保存为禁用状态')
    expect(rpc).toHaveBeenCalledTimes(2)
    rpc.mockClear()
    await expect(createPlatformPlugin(rpc, 'loader', {
      ...initialAccountDraft(), platform: 'discord', token: '',
    })).rejects.toThrow('Discord 用户令牌')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('mints a Matrix access token through the relay login proxy and fills the draft', async () => {
    const fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      expect(String(input)).toBe('/api/matrix/login')
      expect(JSON.parse(init?.body ?? '{}')).toMatchObject({
        homeserver: 'https://matrix.example.org',
        userId: '@alice:example.org',
        password: 'pw',
      })
      return Response.json({ accessToken: 'syt-x', userId: '@alice:example.org', deviceId: 'DEV' })
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const draft = {
        ...initialAccountDraft('matrix'),
        homeserver: 'https://matrix.example.org',
        userId: '@alice:example.org',
        matrixPassword: 'pw',
      }
      await expect(matrixAccountLogin(draft, 'password')).resolves.toEqual({
        userId: '@alice:example.org', deviceId: 'DEV',
      })
      expect(draft.accessToken).toBe('syt-x')
      // A token obtained through login satisfies the configuration builder.
      expect(buildAccountConfiguration(draft).config).toMatchObject({ accessToken: 'syt-x' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces relay login failures with the server-provided message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'M_FORBIDDEN', message: 'Invalid username or password' },
      { status: 401 },
    )))
    try {
      const draft = {
        ...initialAccountDraft('matrix'),
        homeserver: 'https://matrix.example.org',
        userId: '@alice:example.org',
        matrixPassword: 'bad',
      }
      await expect(matrixAccountLogin(draft, 'password')).rejects.toThrow('Invalid username or password')
      expect(draft.accessToken).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('correlates Matrix SSO state and rejects unsolicited or stale callbacks', () => {
    const redirect = beginMatrixSso('https://matrix.example.org/', '')
    expect(redirect).toContain('https://matrix.example.org/_matrix/client/v3/login/sso/redirect?redirectUrl=')
    const callback = new URL(decodeURIComponent(redirect.split('redirectUrl=')[1]!))
    expect(callback.pathname).toBe('/matrix-sso')
    // A fresh flow only matches its own state once; wrong states never match.
    beginMatrixSso('https://matrix.example.org/', '')
    const state = new URLSearchParams(sessionStorage.getItem(MATRIX_SSO_KEY) ?? '{}').get('state')!
    expect(consumeMatrixSsoState('wrong-state')).toBe('expired')
    expect(consumeMatrixSsoState(state)).toBe('missing')
    sessionStorage.clear()
    beginMatrixSso('https://matrix.example.org/', '')
    const raw = sessionStorage.getItem(MATRIX_SSO_KEY)
    expect(raw).toBeTruthy()
    const fresh = JSON.parse(raw!).state as string
    expect(consumeMatrixSsoState(fresh)).toBe(fresh)
    expect(consumeMatrixSsoState(fresh)).toBe('missing')
    sessionStorage.clear()
  })

  it('patches a plugin config by merging onto the stored entry, never replacing it', async () => {
    const updates: unknown[] = []
    const rpc = vi.fn(async (_id: string, method: string, args: unknown[]) => {
      if (method === 'listConfig') {
        return [{
          id: 'accounts/matrix-1',
          name: '@mtproto-relay/platform-matrix',
          config: {
            homeserver: 'https://matrix.example.org',
            accessToken: 'stale-token',
            proxy: 'http://127.0.0.1:7890',
          },
        }]
      }
      if (method === 'updateConfig') updates.push(args[0])
      return undefined
    })
    await updatePlatformPluginConfig(rpc, 'loader', 'accounts/matrix-1', {
      accessToken: 'fresh-token',
      userId: '@alice:example.org',
    })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(updates).toEqual([{
      id: 'accounts/matrix-1',
      // homeserver and proxy survive the token rotation; accessToken is replaced.
      config: {
        homeserver: 'https://matrix.example.org',
        accessToken: 'fresh-token',
        proxy: 'http://127.0.0.1:7890',
        userId: '@alice:example.org',
      },
    }])
  })

  it('fails closed when the loader entry to patch has disappeared', async () => {
    const rpc = vi.fn(async (_id: string, method: string) => {
      if (method === 'listConfig') return []
      return undefined
    })
    await expect(updatePlatformPluginConfig(rpc, 'loader', 'accounts/gone', {
      accessToken: 'fresh-token',
    })).rejects.toThrow('未找到该账号的插件配置')
    expect(rpc).not.toHaveBeenCalledWith('loader', 'updateConfig', expect.anything())
  })
})
