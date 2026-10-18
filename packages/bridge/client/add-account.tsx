/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Modal, ActionError, useAction } from 'cordis-webui-solidjs/components'
import { useConnection } from 'cordis-webui-solidjs/client'
import {
  ACCOUNT_PROVIDERS, beginMatrixSso, buildAccountConfiguration,
  createPlatformPlugin, findLoaderEntry, initialAccountDraft, matrixAccountLogin,
  updatePlatformPluginConfig, MATRIX_SSO_TOKEN_KEY,
  type AccountDraft, type AccountPlatform,
} from './account-creation-model.js'

interface FieldProps {
  label: string
  value: string
  onInput: (value: string) => void
  placeholder?: string
  secret?: boolean
  disabled?: boolean
  hint?: string
}

function Field(props: FieldProps) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type={props.secret ? 'password' : 'text'}
        autocomplete="off"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <Show when={props.hint}>
        <small class="muted">{props.hint}</small>
      </Show>
    </label>
  )
}

export default function AddAccount(props: {
  onClose: () => void
  onCreated: () => void | Promise<void>
}) {
  const connection = useConnection(),
    action = useAction()
  const [draft, setDraft] = createSignal<AccountDraft>(initialAccountDraft())
  const [touched, setTouched] = createSignal(false)
  const loaderId = createMemo(() => findLoaderEntry(connection.state.entries))
  const provider = createMemo(() => ACCOUNT_PROVIDERS.find((item) => item.id === draft().platform)!)
  const issue = createMemo(() => {
    try {
      buildAccountConfiguration(draft())
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  const change = (key: keyof AccountDraft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const disabled = () => action.busy()
  const [matrixMethod, setMatrixMethod] = createSignal<'password' | 'sso' | 'token'>('password')
  const [matrixBusy, setMatrixBusy] = createSignal(false)
  const [matrixError, setMatrixError] = createSignal('')
  const [matrixNotice, setMatrixNotice] = createSignal('')
  const matrixStatus = () => matrixError() || matrixNotice()
  const matrixLoginDisabled = () => disabled() || matrixBusy() || !draft().homeserver.trim()
  const resetMatrixMessages = () => {
    setMatrixError('')
    setMatrixNotice('')
  }

  const applyLoginResult = (result: { userId: string, deviceId: string }) => {
    setDraft((current) => ({
      ...current,
      accessToken: current.accessToken,
      userId: result.userId || current.userId,
    }))
    setMatrixNotice('登录成功，已获取访问令牌。')
  }

  const matrixPasswordLogin = async () => {
    resetMatrixMessages()
    if (!draft().userId.trim() || !draft().matrixPassword) {
      setMatrixError('请填写 Matrix 用户名与密码。')
      return
    }
    setMatrixBusy(true)
    try {
      const draftSnapshot = { ...draft() }
      await matrixAccountLogin(draftSnapshot, 'password')
      // The helper wrote the token into its snapshot; carry it over.
      setDraft((current) => ({
        ...current,
        accessToken: draftSnapshot.accessToken,
        userId: draftSnapshot.userId || current.userId,
      }))
      setMatrixNotice('登录成功，已获取访问令牌。')
    } catch (error) {
      setMatrixError(error instanceof Error ? error.message : String(error))
    } finally {
      setMatrixBusy(false)
    }
  }

  const ssoWindow = new AbortController()

  /**
   * The callback page completes the SSO exchange itself and parks the access
   * token in sessionStorage (no opener dependency). Poll for the draft while
   * the popup is open, then adopt it into the add-account form.
   */
  const adoptSsoDraft = (): boolean => {
    let parked: { accessToken?: unknown, userId?: unknown } | undefined
    try {
      parked = JSON.parse(sessionStorage.getItem(MATRIX_SSO_TOKEN_KEY) ?? 'null') ?? undefined
    } catch {
      parked = undefined
    }
    if (!parked || typeof parked.accessToken !== 'string' || !parked.accessToken) return false
    sessionStorage.removeItem(MATRIX_SSO_TOKEN_KEY)
    setDraft((current) => ({
      ...current,
      accessToken: parked.accessToken as string,
      userId: typeof parked.userId === 'string' && parked.userId ? parked.userId : current.userId,
    }))
    setMatrixNotice('SSO 登录成功，已获取访问令牌。')
    return true
  }

  const startMatrixSso = () => {
    resetMatrixMessages()
    if (!draft().homeserver.trim()) {
      setMatrixError('请先填写 Matrix 服务器地址。')
      return
    }
    setMatrixBusy(true)
    setMatrixNotice('已打开登录窗口；完成身份提供方认证后令牌会自动回到本表单。')
    const popup = window.open(
      beginMatrixSso(draft().homeserver, connection.config.uiPath ?? ''),
      'crossgram-matrix-sso',
      'width=520,height=680',
    )
    if (!popup) {
      setMatrixError('浏览器拦截了弹出窗口，请允许弹出后重试。')
      setMatrixBusy(false)
      return
    }
    const watch = window.setInterval(() => {
      if (adoptSsoDraft()) {
        window.clearInterval(watch)
        setMatrixBusy(false)
      } else if (popup.closed) {
        window.clearInterval(watch)
        setMatrixBusy(false)
        if (!draft().accessToken) {
          setMatrixError('登录窗口已关闭，但未完成令牌交换；请重试或改用账号密码登录。')
        }
      }
    }, 500)
    ssoWindow.signal.addEventListener('abort', () => window.clearInterval(watch))
  }

  onCleanup(() => {
    ssoWindow.abort()
  })

  const submit = () => {
    setTouched(true)
    if (issue() || !loaderId()) return
    void action.run(async () => {
      await createPlatformPlugin(
        (id, method, args) => connection.rpc(id, method, args),
        loaderId()!,
        draft(),
      )
      // Unmount on success so the browser does not retain the typed credentials.
      setDraft(initialAccountDraft())
      await props.onCreated()
    })
  }
  return (
    <Modal title="在线添加平台账号" onClose={() => { if (!disabled()) props.onClose() }}>
      <form class="stack" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <p class="muted">选择平台，填写连接信息，创建并启用一个独立适配器实例。添加后账号会自动出现在此页面。</p>
        <label class="field">
          <span>平台类型</span>
          <select
            aria-label="平台类型"
            value={draft().platform}
            disabled={disabled()}
            onChange={(event) => {
              const platform = event.currentTarget.value as AccountPlatform
              setDraft({ ...initialAccountDraft(platform), label: draft().label })
              setTouched(false)
            }}
          >
            <For each={ACCOUNT_PROVIDERS}>
              {(item) => <option value={item.id}>{item.title}</option>}
            </For>
          </select>
        </label>
        <p class="muted" role="note">{provider().description}</p>
        <Field label="账号备注名称（可选）" value={draft().label} disabled={disabled()}
          onInput={(value) => change('label', value)} placeholder="例如：我的工作账号" />
        <Show when={draft().platform === 'qqnt'}>
          <Field label="QQNT HTTP API 地址" value={draft().endpoint} disabled={disabled()}
            onInput={(value) => change('endpoint', value)} />
          <Field label="QQNT WebSocket 地址（可选）" value={draft().webSocketEndpoint} disabled={disabled()}
            onInput={(value) => change('webSocketEndpoint', value)} />
          <Field label="QQNT 访问令牌（可选）" value={draft().token} secret disabled={disabled()}
            onInput={(value) => change('token', value)} />
        </Show>
        <Show when={draft().platform === 'discord'}>
          <Field label="Discord 用户令牌" value={draft().token} secret disabled={disabled()}
            onInput={(value) => change('token', value)}
            hint="请不要使用公开分享的令牌。Discord 的自动化用户账号可能违反服务条款。" />
          <Field label="HTTP(S) 代理地址（可选）" value={draft().proxy} disabled={disabled()}
            onInput={(value) => change('proxy', value)} placeholder="http://127.0.0.1:7890" />
        </Show>
        <Show when={draft().platform === 'matrix'}>
          <Field label="Matrix Homeserver" value={draft().homeserver} disabled={disabled()}
            onInput={(value) => change('homeserver', value)} placeholder="https://matrix.example.org" />
          <div class="matrix-login-methods" role="radiogroup" aria-label="Matrix 登录方式">
            <button type="button" class="button outlined" disabled={disabled()}
              aria-pressed={matrixMethod() === 'password'}
              onClick={() => setMatrixMethod('password')}>账号密码登录</button>
            <button type="button" class="button outlined" disabled={disabled()}
              aria-pressed={matrixMethod() === 'sso'}
              onClick={() => setMatrixMethod('sso')}>SSO 回调登录</button>
            <button type="button" class="button outlined" disabled={disabled()}
              aria-pressed={matrixMethod() === 'token'}
              onClick={() => setMatrixMethod('token')}>粘贴访问令牌</button>
          </div>
          <Show when={matrixMethod() === 'password'}>
            <Field label="Matrix 用户名" value={draft().userId} disabled={disabled()}
              onInput={(value) => change('userId', value)} placeholder="@alice:example.org"
              hint="完整 Matrix ID，例如 @alice:example.org。" />
            <Field label="Matrix 密码" value={draft().matrixPassword} secret disabled={disabled()}
              onInput={(value) => change('matrixPassword', value)}
              hint="仅用于向 Homeserver 换取访问令牌，CrossGram 不会保存密码。" />
            <button type="button" class="button filled" disabled={matrixLoginDisabled()}
              onClick={() => void matrixPasswordLogin()}>
              {matrixBusy() ? '正在登录…' : '登录并获取令牌'}
            </button>
          </Show>
          <Show when={matrixMethod() === 'sso'}>
            <button type="button" class="button filled" disabled={matrixLoginDisabled()}
              onClick={() => startMatrixSso()}>
              {matrixBusy() ? '等待 SSO 回调…' : '通过 Homeserver 登录（弹出窗口）'}
            </button>
            <p class="muted" role="note">
              弹出身份提供方页面完成登录后，一次性令牌会自动回传并换取访问令牌。
              请允许本站弹出窗口。
            </p>
          </Show>
          <Show when={matrixMethod() === 'token'}>
            <Field label="Matrix Access Token" value={draft().accessToken} secret disabled={disabled()}
              onInput={(value) => change('accessToken', value)}
              hint="来自其它客户端的令牌；更推荐用上面的登录方式自动获取。" />
          </Show>
          <Show when={matrixStatus()}>
            <p class={matrixError() ? 'notice error' : 'notice'} role="status">{matrixStatus()}</p>
          </Show>
          <Show when={draft().accessToken && matrixMethod() !== 'token'}>
            <p class="muted" role="status">已获取访问令牌，可直接添加账号。</p>
          </Show>
          <Field label="Matrix 用户 ID（可选，自动获取）" value={draft().userId} disabled={disabled()}
            onInput={(value) => change('userId', value)} placeholder="@alice:example.org"
            hint={matrixMethod() === 'password' || matrixMethod() === 'sso' ? '登录后自动回填，可留空。' : undefined} />
          <Field label="HTTP(S) 代理地址（可选）" value={draft().proxy} disabled={disabled()}
            onInput={(value) => change('proxy', value)} placeholder="http://127.0.0.1:7890" />
        </Show>
        <Show when={draft().platform === 'wechat'}>
          <Field label="ComWeChat API 地址" value={draft().endpoint} disabled={disabled()}
            onInput={(value) => change('endpoint', value)} placeholder="http://127.0.0.1:18888/api/" />
          <Field label="回调端口（可选）" value={draft().callbackPort} disabled={disabled()}
            onInput={(value) => change('callbackPort', value)} placeholder="23456"
            hint="每个独立的微信适配器需要不同的回调端口。" />
        </Show>
        <Show when={draft().platform === 'telegram'}>
          <p class="notice" role="note">
            Telegram 适配器目前无法在浏览器首次授权。请先在服务器设置 TELEGRAM_API_ID、
            TELEGRAM_API_HASH、TELEGRAM_STORAGE，并运行
            <code> yarn tsx packages/platform-telegram/src/login.ts </code>
            完成验证码和两步验证，然后填写同一会话文件的绝对路径。
          </p>
          <Field label="Telegram API ID" value={draft().apiId} disabled={disabled()}
            onInput={(value) => change('apiId', value)} />
          <Field label="Telegram API Hash" value={draft().apiHash} secret disabled={disabled()}
            onInput={(value) => change('apiHash', value)} />
          <Field label="服务器上的会话文件路径" value={draft().storage} disabled={disabled()}
            onInput={(value) => change('storage', value)} placeholder="/var/lib/crossgram/data/telegram/account-1.session" />
        </Show>
        <Show when={!loaderId()}>
          <p class="notice error" role="alert">
            未找到在线插件管理服务。请先在 WebUI「插件」中启用 @cordisjs/plugin-loader-webui。
          </p>
        </Show>
        <Show when={touched() && issue()}>
          <p class="notice error" role="alert">{issue()}</p>
        </Show>
        <ActionError error={action.error()} />
        <div class="toolbar account-create-actions">
          <button class="button outlined" type="button" disabled={disabled()} onClick={props.onClose}>
            取消
          </button>
          <button class="button filled" type="submit" disabled={
            disabled() || Boolean(issue()) || !loaderId() || connection.state.status !== 'connected'
          }>
            {disabled() ? '正在添加…' : '添加并启用'}
          </button>
        </div>
        <small class="muted">
          凭据会保存至服务器的插件配置中；请仅在受信任的管理 WebUI 中操作。账号状态将在适配器成功登录后显示为就绪。
        </small>
      </form>
    </Modal>
  )
}

/**
 * Re-login an existing Matrix platform whose stored access token was rejected
 * (M_UNKNOWN_TOKEN). Performs the same password/SSO/token flows as the add
 * page, then patches the existing plugin entry's `accessToken` (and `userId`
 * when known) through the loader's update boundary — the plugin hot-reloads
 * with the new token, no recreate or restart needed.
 */
export function MatrixReloginModal(props: {
  entryId: string
  homeserver?: string
  onClose: () => void
  onRelogged: () => void | Promise<void>
}) {
  const connection = useConnection(),
    action = useAction()
  const loaderId = createMemo(() => findLoaderEntry(connection.state.entries))
  const draft = (): AccountDraft => ({
    ...initialAccountDraft('matrix'),
    homeserver: props.homeserver ?? '',
  })
  const [method, setMethod] = createSignal<'password' | 'sso' | 'token'>('password')
  const [userId, setUserId] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [accessToken, setAccessToken] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [notice, setNotice] = createSignal('')
  const status = () => error() || notice()
  const resetMessages = () => { setError(''); setNotice('') }
  const ssoWindow = new AbortController()

  const persist = async (token: string, knownUserId?: string) => {
    const patch: Record<string, unknown> = { accessToken: token }
    if (knownUserId) patch.userId = knownUserId
    await updatePlatformPluginConfig(
      (id, rpcMethod, args) => connection.rpc(id, rpcMethod, args),
      loaderId()!,
      props.entryId,
      patch,
    )
    setUserId('')
    setPassword('')
    setAccessToken('')
    await props.onRelogged()
  }

  const passwordLogin = async () => {
    resetMessages()
    if (!userId().trim() || !password()) {
      setError('请填写 Matrix 用户名与密码。')
      return
    }
    setBusy(true)
    try {
      const snapshot = { ...draft(), userId: userId(), matrixPassword: password() }
      const result = await matrixAccountLogin(snapshot, 'password')
      await persist(snapshot.accessToken, result.userId || userId().trim())
      setNotice('登录成功，已更新访问令牌。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const startSso = () => {
    resetMessages()
    if (!props.homeserver) {
      setError('无法确定 Homeserver 地址，请使用粘贴令牌方式。')
      return
    }
    // The callback page completes the exchange itself and rotates the token
    // on this entry; the popup closing is all we wait for. Poll the entry
    // config as a light completion signal through the onRelogged callback
    // the parent passes on modal close — or refresh on visibility.
    setBusy(true)
    setNotice('已打开登录窗口；完成身份提供方认证后令牌会自动写回本账号。')
    const popup = window.open(
      beginMatrixSso(props.homeserver, connection.config.uiPath ?? '', props.entryId),
      'crossgram-matrix-sso',
      'width=520,height=680',
    )
    if (!popup) {
      setError('浏览器拦截了弹出窗口，请允许弹出后重试。')
      setBusy(false)
      return
    }
    // The callback page rotates the token itself; when the popup closes the
    // flow is finished (or failed there). Refresh so the parent sees the
    // ready account.
    const watch = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(watch)
        setBusy(false)
        void props.onRelogged()
      }
    }, 500)
    ssoWindow.signal.addEventListener('abort', () => window.clearInterval(watch))
  }

  const tokenSubmit = async () => {
    resetMessages()
    if (!accessToken().trim()) {
      setError('请粘贴访问令牌。')
      return
    }
    setBusy(true)
    try {
      await persist(accessToken().trim())
      setNotice('已更新访问令牌。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  onCleanup(() => {
    ssoWindow.abort()
  })

  const disabled = () => busy() || !loaderId()
  return (
    <Modal title="重新登录 Matrix" onClose={() => { if (!busy()) props.onClose() }}>
      <form class="stack" onSubmit={(event) => { event.preventDefault(); if (method() === 'password') void passwordLogin() }}>
        <p class="muted" role="note">
          当前访问令牌已被 Homeserver 拒绝（M_UNKNOWN_TOKEN）。重新登录后会把新令牌写入现有
          Matrix 配置并立即生效，无需重建账号。
        </p>
        <p class="muted" role="note">Homeserver：{props.homeserver || '未知（可使用粘贴令牌）'}</p>
        <div class="matrix-login-methods" role="radiogroup" aria-label="Matrix 登录方式">
          <button type="button" class="button outlined" disabled={disabled()}
            aria-pressed={method() === 'password'}
            onClick={() => { resetMessages(); setMethod('password') }}>账号密码登录</button>
          <button type="button" class="button outlined" disabled={disabled()}
            aria-pressed={method() === 'sso'}
            onClick={() => { resetMessages(); setMethod('sso') }}>SSO 回调登录</button>
          <button type="button" class="button outlined" disabled={disabled()}
            aria-pressed={method() === 'token'}
            onClick={() => { resetMessages(); setMethod('token') }}>粘贴访问令牌</button>
        </div>
        <Show when={method() === 'password'}>
          <label class="field">
            <span>Matrix 用户名</span>
            <input type="text" autocomplete="off" value={userId()} placeholder="@alice:example.org"
              disabled={disabled()} onInput={(event) => setUserId(event.currentTarget.value)} />
            <small class="muted">完整 Matrix ID，例如 @alice:example.org。</small>
          </label>
          <label class="field">
            <span>Matrix 密码</span>
            <input type="password" autocomplete="off" value={password()}
              disabled={disabled()} onInput={(event) => setPassword(event.currentTarget.value)} />
            <small class="muted">仅用于向 Homeserver 换取访问令牌，CrossGram 不会保存密码。</small>
          </label>
          <button type="submit" class="button filled" disabled={disabled()}>
            {busy() ? '正在登录…' : '登录并更新令牌'}
          </button>
        </Show>
        <Show when={method() === 'sso'}>
          <button type="button" class="button filled" disabled={disabled()} onClick={startSso}>
            {busy() ? '等待 SSO 回调…' : '通过 Homeserver 登录（弹出窗口）'}
          </button>
          <p class="muted" role="note">
            弹出身份提供方页面完成登录后，一次性令牌会自动回传并换取访问令牌。
            请允许本站弹出窗口。
          </p>
        </Show>
        <Show when={method() === 'token'}>
          <label class="field">
            <span>Matrix Access Token</span>
            <input type="password" autocomplete="off" value={accessToken()}
              disabled={disabled()} onInput={(event) => setAccessToken(event.currentTarget.value)} />
            <small class="muted">来自其它客户端的令牌；更推荐用上面的登录方式自动获取。</small>
          </label>
          <button type="button" class="button filled" disabled={disabled()} onClick={() => void tokenSubmit()}>
            {busy() ? '正在保存…' : '保存令牌'}
          </button>
        </Show>
        <Show when={!loaderId()}>
          <p class="notice error" role="alert">
            未找到在线插件管理服务。请先在 WebUI「插件」中启用 @cordisjs/plugin-loader-webui。
          </p>
        </Show>
        <Show when={status()}>
          <p class={error() ? 'notice error' : 'notice'} role="status">{status()}</p>
        </Show>
      </form>
    </Modal>
  )
}
