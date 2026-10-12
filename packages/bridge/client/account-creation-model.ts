/** Browser-only account setup helpers. Never publish credentials in a dashboard snapshot. */

export type AccountPlatform = 'qqnt' | 'discord' | 'matrix' | 'wechat' | 'telegram'

export interface AccountDraft {
  platform: AccountPlatform
  label: string
  endpoint: string
  webSocketEndpoint: string
  token: string
  homeserver: string
  accessToken: string
  userId: string
  proxy: string
  callbackPort: string
  apiId: string
  apiHash: string
  storage: string
}

export const ACCOUNT_PROVIDERS: ReadonlyArray<{
  id: AccountPlatform
  title: string
  packageName: string
  description: string
}> = [
  { id: 'qqnt', title: 'QQ / QQNT', packageName: '@mtproto-relay/platform-qqnt',
    description: '连接已登录的 QQNT Bridge。每个 QQ 账号需独立的桥接实例或端点。' },
  { id: 'discord', title: 'Discord', packageName: '@mtproto-relay/platform-discord',
    description: '使用已有 Discord 用户令牌连接。注意 Discord 对自动化用户账号的服务条款限制。' },
  { id: 'matrix', title: 'Matrix', packageName: '@mtproto-relay/platform-matrix',
    description: '使用 Matrix 服务器地址和已有账号的访问令牌。' },
  { id: 'wechat', title: '微信 / ComWeChat', packageName: '@mtproto-relay/platform-wechat',
    description: '连接已登录的 ComWeChat 实例；此操作不负责微信扫码登录。' },
  { id: 'telegram', title: 'Telegram', packageName: '@mtproto-relay/platform-telegram',
    description: '使用预先授权的服务器端会话文件；首次短信验证码登录仍需在服务器完成。' },
]

export const initialAccountDraft = (platform: AccountPlatform = 'qqnt'): AccountDraft => ({
  platform,
  label: '',
  endpoint: platform === 'wechat' ? 'http://127.0.0.1:18888/api/' : 'http://127.0.0.1:18767/v1',
  webSocketEndpoint: platform === 'qqnt' ? 'ws://127.0.0.1:18767/v1/events/ws' : '',
  token: '',
  homeserver: '',
  accessToken: '',
  userId: '',
  proxy: '',
  callbackPort: '',
  apiId: '',
  apiHash: '',
  storage: '',
})

function validUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value)
    return protocols.includes(url.protocol) && Boolean(url.hostname)
      && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

export function buildAccountConfiguration(draft: AccountDraft): {
  name: string
  label: string
  config: Record<string, string | number>
} {
  const provider = ACCOUNT_PROVIDERS.find((item) => item.id === draft.platform)
  if (!provider) throw new Error('不支持的账号平台')
  const label = draft.label.trim()
  if (label.length > 100) throw new Error('账号名称不能超过 100 个字符')
  const config: Record<string, string | number> = {}
  const requireText = (text: string, name: string, max = 8192) => {
    const value = text.trim()
    if (!value || value.length > max) throw new Error('请填写有效的' + name)
    return value
  }
  const optionalProxy = () => {
    const proxy = draft.proxy.trim()
    if (!proxy) return
    if (!validUrl(proxy, ['http:', 'https:']))
      throw new Error('代理必须是有效的 HTTP(S) 地址，且不能包含 URL 用户信息')
    config.proxy = proxy
  }
  switch (draft.platform) {
    case 'qqnt':
      if (!validUrl(draft.endpoint.trim(), ['http:', 'https:']))
        throw new Error('QQNT API 地址必须是有效的 HTTP(S) URL')
      config.endpoint = draft.endpoint.trim().replace(/\/+$/, '')
      if (draft.webSocketEndpoint.trim()) {
        if (!validUrl(draft.webSocketEndpoint.trim(), ['ws:', 'wss:']))
          throw new Error('QQNT WebSocket 地址必须是有效的 WS(S) URL')
        config.webSocketEndpoint = draft.webSocketEndpoint.trim()
      }
      if (draft.token.trim()) config.token = requireText(draft.token, 'QQNT Token')
      break
    case 'discord':
      config.token = requireText(draft.token, 'Discord 用户令牌')
      optionalProxy()
      break
    case 'matrix': {
      const homeserver = requireText(draft.homeserver, 'Matrix 服务器地址', 2048)
      if (!validUrl(homeserver, ['http:', 'https:']))
        throw new Error('Matrix 服务器地址必须是有效的 HTTP(S) URL')
      const parsed = new URL(homeserver)
      // MatrixClient appends /_matrix/client/... itself.
      if (parsed.pathname !== '/' || parsed.search)
        throw new Error('Matrix 服务器地址请使用根地址，例如 https://matrix.example.org')
      config.homeserver = parsed.origin
      config.accessToken = requireText(draft.accessToken, 'Matrix Access Token')
      if (draft.userId.trim()) config.userId = requireText(draft.userId, 'Matrix User ID', 255)
      optionalProxy()
      break
    }
    case 'wechat':
      if (!validUrl(draft.endpoint.trim(), ['http:', 'https:']))
        throw new Error('ComWeChat API 地址必须是有效的 HTTP(S) URL')
      config.endpoint = draft.endpoint.trim()
      if (draft.callbackPort.trim()) {
        const port = Number(draft.callbackPort.trim())
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error('回调端口必须在 1 至 65535 之间')
        config.callbackPort = port
      }
      break
    case 'telegram': {
      const apiId = Number(draft.apiId.trim())
      if (!Number.isSafeInteger(apiId) || apiId < 1)
        throw new Error('Telegram API ID 必须是正整数')
      config.apiId = apiId
      config.apiHash = requireText(draft.apiHash, 'Telegram API Hash')
      config.storage = requireText(draft.storage, 'Telegram 会话文件路径', 2048)
      if (!config.storage.toString().startsWith('/'))
        throw new Error('Telegram 会话文件路径必须是服务器上的绝对路径')
      break
    }
  }
  return { name: provider.packageName, label: label || provider.title, config }
}

/** The loader RPC is the same management boundary used by the Plugins page. */
export function findLoaderEntry(entries: Record<string, { module: string; methods: string[] }>): string | undefined {
  return Object.entries(entries).find(([, entry]) =>
    entry.module === 'loader'
    && ['createConfig', 'updateConfig'].every((method) => entry.methods.includes(method)),
  )?.[0]
}

/**
 * Create with credentials while disabled, then enable. If enabling fails, leave
 * the configured plugin disabled for manual recovery rather than deleting secrets
 * or risking a double creation after a network timeout.
 */
export async function createPlatformPlugin(
  rpc: (id: string, method: string, args: unknown[]) => Promise<unknown>,
  loaderEntryId: string,
  draft: AccountDraft,
): Promise<string> {
  const setup = buildAccountConfiguration(draft)
  const result = await rpc(loaderEntryId, 'createConfig', [{
    ...setup,
    disabled: true,
  }])
  if (typeof result !== 'string' || !result)
    throw new Error('插件管理器没有返回有效的配置 ID')
  try {
    await rpc(loaderEntryId, 'updateConfig', [{ id: result, disabled: false }])
  } catch (error) {
    throw new Error(
      '账号配置已保存为禁用状态，但自动启用失败；请在「插件」页面检查后手动启用。原因：'
      + String(error instanceof Error ? error.message : error),
    )
  }
  return result
}
