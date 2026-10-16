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
  /** Matrix account password, used only to mint an access token; never persisted. */
  matrixPassword: string
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
  matrixPassword: '',
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
      // The token is normally minted by the password/SSO login above, but a
      // manually pasted token from another client is still accepted.
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

/**
 * The relay proxies the homeserver's `/_matrix/client/v3/login`: browsers
 * cannot call it cross-origin. The credentials are forwarded once, and the
 * returned access token fills the draft so the ordinary "create plugin"
 * boundary persists it — this module never stores the token itself.
 */
export async function matrixAccountLogin(
  draft: AccountDraft,
  kind: 'password' | 'sso',
  ssoLoginToken?: string,
): Promise<{ userId: string, deviceId: string }> {
  const homeserver = draft.homeserver.trim()
  if (!homeserver) throw new Error('请先填写 Matrix 服务器地址')
  const body: Record<string, string> = kind === 'sso'
    ? { homeserver, loginToken: ssoLoginToken ?? '' }
    : { homeserver, userId: draft.userId.trim(), password: draft.matrixPassword }
  const response = await fetch('/api/matrix/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  const payload = await response.json().catch(() => ({})) as {
    accessToken?: unknown, userId?: unknown, deviceId?: unknown, message?: unknown, error?: unknown
  }
  if (!response.ok || typeof payload.accessToken !== 'string' || !payload.accessToken) {
    throw new Error(
      typeof payload.message === 'string' && payload.message
        ? payload.message
        : typeof payload.error === 'string' && payload.error
          ? payload.error
          : 'Matrix 登录失败：HTTP ' + response.status,
    )
  }
  setDraftToken(draft, payload.accessToken)
  return {
    userId: typeof payload.userId === 'string' ? payload.userId : '',
    deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : '',
  }
}

/** The draft is a plain object; mutating it here keeps credentials out of this module's scope. */
function setDraftToken(draft: AccountDraft, accessToken: string): void {
  draft.accessToken = accessToken
}

/**
 * The homeserver redirects back to `${location.origin}${uiPath}/matrix-sso?state=…&loginToken=…`
 * (spec: the login token rides in the query; the state protects against CSRF).
 * The callback page forwards it to the opener via postMessage; this helper
 * builds that URL and remembers the expected state.
 */
export function beginMatrixSso(homeserver: string, uiPath = ''): string {
  const state = crypto.randomUUID()
  sessionStorage.setItem(MATRIX_SSO_KEY, JSON.stringify({ state, homeserver, started: Date.now() }))
  const origin = homeserver.trim().replace(/\/+$/, '')
  const redirect = new URL(location.origin + uiPath + '/matrix-sso')
  redirect.searchParams.set('state', state)
  return `${origin}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(redirect.href)}`
}

export const MATRIX_SSO_KEY = 'crossgram:matrix-sso-pending'

export function consumeMatrixSsoState(candidate: string | undefined): string | 'expired' | 'missing' {
  let pending: { state?: unknown, started?: unknown } | undefined
  try {
    pending = JSON.parse(sessionStorage.getItem(MATRIX_SSO_KEY) ?? 'null') ?? undefined
  } catch {
    pending = undefined
  }
  sessionStorage.removeItem(MATRIX_SSO_KEY)
  if (!pending || typeof pending.state !== 'string' || typeof pending.started !== 'number') return 'missing'
  if (!Number.isFinite(pending.started) || Date.now() - pending.started > 10 * 60_000) return 'expired'
  if (typeof candidate !== 'string' || !candidate || !sameStateSafe(candidate, pending.state)) return 'expired'
  return pending.state
}

function sameStateSafe(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < expected.length; index++) {
    mismatch |= candidate.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return mismatch === 0
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
