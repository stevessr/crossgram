import { describe, expect, it, vi } from 'vitest'
import {
  buildAccountConfiguration,
  createPlatformPlugin,
  findLoaderEntry,
  initialAccountDraft,
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
})
