/** @jsxImportSource solid-js */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
} from 'solid-js'
import type {
  PlatformAccountDashboardData,
  PlatformAccountView,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ActionError,
  EmptyState,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'
import { sessionToken } from 'cordis-webui-solidjs/session'
import AddAccount from './add-account.js'
import { cameraErrorMessage, screenErrorMessage, startQrCamera, startQrScreen } from './qr-camera.js'
import {
  copyText,
  formatPhone,
  parseTelegramLoginUrl,
  remainingSeconds,
  safeImageURL,
  sameOriginPath,
} from './bridge-model.js'
export default function AccountsPage(props: PageProps) {
  const rpc = useRpc<PlatformAccountDashboardData>(props.entryId),
    action = useAction()
  const [now, setNow] = createSignal(Date.now()),
    [qr, setQr] = createSignal(false),
    [adding, setAdding] = createSignal(false),
    [copied, setCopied] = createSignal(false)
  const tick = () => {
      if (!document.hidden) setNow(Date.now())
    },
    timer = setInterval(tick, 1000)
  document.addEventListener('visibilitychange', tick)
  onCleanup(() => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', tick)
  })
  const accounts = createMemo(
    () =>
      new Map(
        (rpc.data.accounts ?? []).map((account) => [
          account.platformId,
          account,
        ]),
      ),
  )
  const ids = createMemo(() => [...accounts().keys()])
  const configuration = createMemo(() =>
    JSON.stringify(rpc.data.serverConfig, null, 2),
  )
  const [search, setSearch] = createSignal(''),
    [limit, setLimit] = createSignal(24)
  const filtered = createMemo(() =>
    ids().filter((id) => {
      const account = accounts().get(id)!
      return (account.displayName + ' ' + id + ' ' + account.username)
        .toLowerCase()
        .includes(search().toLowerCase())
    }),
  )
  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="Your connected identities. Ready for Telegram."
        actions={
          <>
            <button
              class="button filled"
              disabled={!rpc.ready}
              onClick={() => setAdding(true)}
            >
              添加账号
            </button>
            <button
              class="button outlined"
              disabled={action.busy() || !rpc.ready}
              onClick={() => void action.run(() => rpc.data.refresh())}
            >
              Refresh accounts
            </button>
            <button
              class="button filled"
              disabled={!rpc.ready}
              onClick={() => setQr(true)}
            >
              Approve QR login
            </button>
          </>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <section class="panel connection-config">
          <div>
            <span class="eyebrow">CONNECT YOUR CLIENT</span>
            <h2>One configuration. Your whole workspace.</h2>
            <p>
              Import this server configuration into a patched Crossgram client.
            </p>
          </div>
          <button
            class="button tonal"
            disabled={!rpc.ready || !rpc.data.serverConfig}
            onClick={() =>
              void action.run(async () => {
                await copyText(configuration()!)
                setCopied(true)
              })
            }
          >
            {copied() ? 'Configuration copied' : 'Copy server configuration'}
          </button>
          <details>
            <summary>View server configuration</summary>
            <pre aria-label="Server configuration">{configuration()}</pre>
          </details>
        </section>
        <div class="section-heading">
          <h2>Your identities</h2>
          <span class="muted">{ids().length} accounts</span>
        </div>
        <label class="field account-search">
          <span class="sr-only">Find an account</span>
          <input
            type="search"
            placeholder="Find an account…"
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value)
              setLimit(24)
            }}
          />
        </label>
        <div class="platform-account-grid">
          <For each={filtered().slice(0, limit())}>
            {(id) => (
              <AccountCard
                account={accounts().get(id)!}
                now={now()}
                connected={rpc.ready}
                onDemandLoginCodes={rpc.data.onDemandLoginCodes ?? true}
                loginCodeTtlSeconds={rpc.data.loginCodeTtlSeconds ?? 300}
                requestCode={() => rpc.data.requestLoginCode(id)}
                setPassword={(password) => rpc.data.setLoginPassword(id, password)}
              />
            )}
          </For>
        </div>
        <Show when={!filtered().length}>
          <section class="panel empty-state">
            <h2>
              {ids().length
                ? 'No matching accounts'
                : 'No platform accounts yet'}
            </h2>
            <p>
              点击右上角「添加账号」，配置 QQ、Discord、Matrix、微信或 Telegram 适配器。
            </p>
          </section>
        </Show>
        <Show when={filtered().length > limit()}>
          <button
            class="button outlined"
            onClick={() => setLimit(limit() + 24)}
          >
            Show more accounts
          </button>
        </Show>
      </LiveContent>
      <Show when={adding()}>
        <AddAccount
          onClose={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false)
            await action.run(() => rpc.data.refresh())
          }}
        />
      </Show>
      <Show when={qr()}>
        <QrLogin
          data={rpc.data}
          connected={rpc.ready}
          onClose={() => setQr(false)}
        />
      </Show>
    </>
  )
}
export function AccountCard(props: {
  account: PlatformAccountView
  now: number
  connected: boolean
  onDemandLoginCodes: boolean
  loginCodeTtlSeconds: number
  requestCode: () => Promise<void>
  setPassword: (password: string | null) => Promise<void>
}) {
  const [failedAvatar, setFailedAvatar] = createSignal(false),
    [copied, setCopied] = createSignal(''),
    [passwordOpen, setPasswordOpen] = createSignal(false),
    action = useAction()
  const avatar = createMemo(() => safeImageURL(props.account.avatarUrl))
  createEffect(() => {
    avatar()
    setFailedAvatar(false)
  })
  const remaining = () => remainingSeconds(props.account.validUntil, props.now)
  const initials = () =>
    (props.account.displayName || props.account.platformId)
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
  const code = () =>
    props.connected && remaining() > 0 ? (props.account.loginCode ?? '') : ''
  const copy = (kind: string, value: string) =>
    void action.run(async () => {
      await copyText(value)
      setCopied(kind)
    })
  return (
    <article
      class="panel identity-card"
      data-platform={props.account.platformId}
    >
      <header>
        <div class="identity-avatar">
          <Show
            when={avatar() && !failedAvatar()}
            fallback={<span>{initials()}</span>}
          >
            <img
              src={avatar()}
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              onError={() => setFailedAvatar(true)}
            />
          </Show>
        </div>
        <div class="identity-heading">
          <h2>{props.account.displayName || props.account.platformId}</h2>
          <p>
            {props.account.username
              ? '@' + props.account.username
              : props.account.platformKind}
          </p>
        </div>
        <span class="chip">{props.account.platformKind}</span>
      </header>
      <dl class="identity-meta">
        <div>
          <dt>Platform</dt>
          <dd>{props.account.platformId}</dd>
        </div>
        <div>
          <dt>User ID</dt>
          <dd>{props.account.userId ?? '—'}</dd>
        </div>
      </dl>
      <Show
        when={props.account.status === 'ready'}
        fallback={
          <div class="identity-status" role="status">
            <strong>
              {props.account.status === 'loading'
                ? 'Connecting to your platform'
                : props.account.status === 'unsupported'
                  ? 'Account information unavailable'
                  : 'Account needs attention'}
            </strong>
            <p>
              {props.account.error ||
                'Details will update when the platform becomes available.'}
            </p>
          </div>
        }
      >
        <div class="phone-row">
          <div>
            <span class="eyebrow">VIRTUAL PHONE</span>
            <code>{formatPhone(props.account.virtualPhone)}</code>
          </div>
          <button
            class="button outlined"
            aria-label={'Copy phone for ' + props.account.platformId}
            disabled={!props.account.virtualPhone}
            onClick={() => copy('phone', props.account.virtualPhone!)}
          >
            {copied() === 'phone' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div class="otp-panel">
          <div class="toolbar">
            <span class="eyebrow">TELEGRAM LOGIN CODE</span>
            <span class="otp-expiry">
              {code()
                ? remaining() + 's remaining'
                : props.connected
                  ? props.onDemandLoginCodes
                    ? '等待登录请求 / Waiting for login request'
                    : 'Waiting for a fresh code'
                  : 'Reconnecting…'}
            </span>
          </div>
          <button
            class="otp-digits"
            aria-label={'Copy login code for ' + props.account.platformId}
            disabled={!code()}
            onClick={() => copy('code', code())}
          >
            <Index each={[...(code() || '------')]}>
              {(digit) => <span>{digit()}</span>}
            </Index>
          </button>
          <div
            class="otp-progress"
            role="progressbar"
            aria-label="Login code validity"
            aria-valuenow={remaining()}
            aria-valuemin={0}
            aria-valuemax={props.loginCodeTtlSeconds}
          >
            <span
              style={{ width: Math.min(100, (remaining() / props.loginCodeTtlSeconds) * 100) + '%' }}
            />
          </div>
          <Show when={props.onDemandLoginCodes}>
            <button
              class="button outlined"
              aria-label={'Generate login code for ' + props.account.platformId}
              disabled={!props.connected || action.busy()}
              onClick={() => void action.run(() => props.requestCode())}
            >
              生成 / Generate code
            </button>
          </Show>
          <small>
            {copied() === 'code'
              ? 'Code copied'
              : props.onDemandLoginCodes
                ? 'Telegram 请求登录时会自动生成；也可在此手动生成，有效期 5 分钟。'
                : 'Enter this phone number and code in your Telegram client.'}
          </small>
        </div>
        <div class="phone-row">
          <div>
            <span class="eyebrow">TWO-STEP VERIFICATION</span>
            <code>
              {props.account.hasPassword
                ? 'Password enabled (all-zero code)'
                : 'Disabled'}
            </code>
          </div>
          <button
            class="button outlined"
            disabled={!props.connected}
            onClick={() => setPasswordOpen(true)}
          >
            {props.account.hasPassword ? 'Change' : 'Set password'}
          </button>
        </div>
        <Show when={props.account.hasPassword}>
          <button
            class="button outlined"
            disabled={!props.connected}
            onClick={() =>
              void action.run(async () => {
                await props.setPassword(null)
                setPasswordOpen(false)
              })
            }
          >
            Remove password
          </button>
        </Show>
      </Show>
      <Show when={passwordOpen()}>
        <PasswordModal
          hasPassword={props.account.hasPassword ?? false}
          onClose={() => setPasswordOpen(false)}
          onSubmit={async (password) => {
            await props.setPassword(password)
            setPasswordOpen(false)
          }}
        />
      </Show>
      <ActionError error={action.error()} />
    </article>
  )
}

function PasswordModal(props: {
  hasPassword: boolean
  onClose: () => void
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = createSignal(''),
    [confirm, setConfirm] = createSignal(''),
    action = useAction()
  const mismatch = () =>
    password() !== confirm() ? 'Passwords do not match.' : undefined
  const weak = () =>
    password().length < 1 ? 'Password must not be empty.' : undefined
  const problem = () => mismatch() ?? weak()
  return (
    <Modal
      title={props.hasPassword ? 'Change login password' : 'Set login password'}
      onClose={props.onClose}
    >
      <p>
        With a password set, entering an all-zero code (<code>000000</code>, or{' '}
        <code>00000</code> when the client asks for five digits) switches to
        password login; any other valid login code signs in directly.
      </p>
      <label class="field">
        <span>Password</span>
        <input
          type="password"
          autocomplete="new-password"
          value={password()}
          disabled={action.busy()}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span>Confirm password</span>
        <input
          type="password"
          autocomplete="new-password"
          value={confirm()}
          disabled={action.busy()}
          onInput={(event) => setConfirm(event.currentTarget.value)}
        />
      </label>
      <Show when={problem()}>
        <p class="notice error" role="alert">{problem()}</p>
      </Show>
      <ActionError error={action.error()} />
      <button
        class="button filled"
        disabled={action.busy() || Boolean(problem())}
        onClick={() => void action.run(() => props.onSubmit(password()))}
      >
        {action.busy() ? 'Saving…' : 'Save password'}
      </button>
    </Modal>
  )
}
function QrLogin(props: {
  data: PlatformAccountDashboardData
  connected: boolean
  onClose: () => void
}) {
  const [input, setInput] = createSignal(''),
    [account, setAccount] = createSignal(''),
    [approved, setApproved] = createSignal(false),
    [cameraState, setCameraState] = createSignal<'idle' | 'starting' | 'scanning'>('idle'),
    [captureSource, setCaptureSource] = createSignal<'camera' | 'screen' | null>(null),
    [dragging, setDragging] = createSignal(false),
    [cameraMessage, setCameraMessage] = createSignal('')
  const scan = useAction(),
    approve = useAction(),
    controller = new AbortController()
  let videoElement: HTMLVideoElement | undefined
  let cameraController: AbortController | undefined
  let cameraStop: (() => void) | undefined
  const stopCapture = () => {
    cameraController?.abort()
    cameraStop?.()
    cameraController = undefined
    cameraStop = undefined
    setCameraState('idle')
    setCaptureSource(null)
  }
  const startCapture = (source: 'camera' | 'screen') => {
    if (cameraState() !== 'idle' || !videoElement || scan.busy() || approve.busy()) return
    const current = new AbortController()
    cameraController = current
    setCaptureSource(source)
    setCameraMessage('')
    setCameraState('starting')
    const start = source === 'screen' ? startQrScreen : startQrCamera
    void start(videoElement, current.signal, (value) => {
      const parsed = parseTelegramLoginUrl(value)
      if (!parsed) {
        setCameraMessage('识别到二维码，但不是有效的 Telegram 登录码。')
        return false
      }
      stopCapture()
      setInput(parsed)
      setApproved(false)
      setCameraMessage('二维码已识别。请选择目标账号，再手动批准登录。')
      return true
    }, (error) => {
      if (cameraController !== current) return
      stopCapture()
      setCameraMessage(source === 'screen' ? screenErrorMessage(error) : cameraErrorMessage(error))
    }).then((stop) => {
      if (cameraController !== current) {
        stop()
        return
      }
      cameraStop = stop
      setCameraState('scanning')
    }).catch((error) => {
      if (cameraController !== current) return
      stopCapture()
      if ((error as Error)?.name !== 'AbortError')
        setCameraMessage(source === 'screen' ? screenErrorMessage(error) : cameraErrorMessage(error))
    })
  }
  const token = createMemo(() => parseTelegramLoginUrl(input().trim()))
  const readyAccounts = () =>
    (props.data.accounts ?? []).filter((account) => account.status === 'ready')
  createEffect(() => {
    if (!readyAccounts().some((value) => value.platformId === account()))
      setAccount(readyAccounts()[0]?.platformId ?? '')
  })
  const scanQrFile = async (file: File) => {
    stopCapture()
    setInput('')
    setApproved(false)
    setCameraMessage('')
    const { decodeQrImage } = await import('./qr.js')
    const result = await decodeQrImage(file, controller.signal)
    const parsed = parseTelegramLoginUrl(result)
    if (!parsed) throw new Error('图片中的二维码不是有效的 Telegram 登录码')
    setInput(parsed)
    setCameraMessage('二维码已识别。请选择目标账号，再手动批准登录。')
  }
  const decode = (file?: File) => {
    if (!file || scan.busy() || approve.busy()) return
    void scan.run(() => scanQrFile(file))
  }
  const paste = (event: ClipboardEvent) => {
    const item = Array.from(event.clipboardData?.items ?? [])
      .find((value) => value.type.startsWith('image/'))
    const file = item?.getAsFile() ?? Array.from(event.clipboardData?.files ?? [])
      .find((value) => value.type.startsWith('image/'))
    if (file && !scan.busy() && !approve.busy()) {
      event.preventDefault()
      decode(file)
    }
  }
  const readClipboard = () => {
    if (scan.busy() || approve.busy()) return
    if (!navigator.clipboard?.read) {
      setCameraMessage('浏览器不支持直接读取剪贴板，请在此弹窗按 Ctrl+V（Mac 为 ⌘V）。')
      return
    }
    void scan.run(async () => {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((value) => value.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        await scanQrFile(new File([blob], 'clipboard-qr', { type: blob.type || type }))
        return
      }
      throw new Error('剪贴板中没有图片，请先复制 Telegram 二维码截图')
    })
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (scan.busy() || approve.busy()) return
    decode(Array.from(event.dataTransfer?.files ?? []).find((file) => file.type.startsWith('image/'))
      ?? event.dataTransfer?.files[0])
  }
  const onVisibilityChange = () => {
    // Screen capture must continue when the Telegram application takes focus.
    if (document.hidden && captureSource() === 'camera') {
      stopCapture()
      setCameraMessage('页面切换到后台，已自动关闭摄像头。')
    }
  }
  window.addEventListener('paste', paste)
  document.addEventListener('visibilitychange', onVisibilityChange)
  onCleanup(() => {
    controller.abort()
    stopCapture()
    window.removeEventListener('paste', paste)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
  return (
    <Modal title="Approve Telegram QR login" onClose={() => { stopCapture(); props.onClose() }}>
      <p>
        可以共享显示 Telegram 登录二维码的应用窗口、使用摄像头扫码，或者上传、拖放、粘贴截图。
        图像只在当前浏览器本地解码，不上传屏幕内容；识别后仍需手动批准登录。
      </p>
      <div class="qr-camera-controls">
        <button
          class="button outlined"
          type="button"
          disabled={scan.busy() || approve.busy() || !props.connected || !readyAccounts().length ||
            (cameraState() !== 'idle' && captureSource() !== 'screen')}
          onClick={() => captureSource() === 'screen' ? stopCapture() : startCapture('screen')}
        >
          {captureSource() === 'screen' ? '停止共享屏幕' : '共享 Telegram 窗口扫码'}
        </button>
        <button
          class="button outlined"
          type="button"
          disabled={scan.busy() || approve.busy() || !props.connected || !readyAccounts().length ||
            (cameraState() !== 'idle' && captureSource() !== 'camera')}
          onClick={() => captureSource() === 'camera' ? stopCapture() : startCapture('camera')}
        >
          {captureSource() === 'camera' ? '停止摄像头' : '使用摄像头扫码'}
        </button>
        <small class="muted">共享时请在浏览器的选择窗口中选择 Telegram 应用，避免共享 WebUI 本身。需要 HTTPS 或 localhost。</small>
      </div>
      <video
        ref={(element) => { videoElement = element }}
        class="qr-camera-video"
        aria-label={captureSource() === 'screen' ? '共享窗口预览' : '摄像头预览'}
        muted
        playsinline
        style={{ display: cameraState() === 'idle' ? 'none' : 'block' }}
      />
      <Show when={cameraState() === 'starting'}>
        <p role="status">正在等待{captureSource() === 'screen' ? '屏幕共享权限' : '摄像头画面'}…</p>
      </Show>
      <Show when={cameraState() === 'scanning'}>
        <p role="status">{captureSource() === 'screen'
          ? '正在扫描共享窗口中的 Telegram 登录二维码，切换到 Telegram 也可继续。'
          : '将 Telegram 登录二维码放入摄像头画面中。'}</p>
      </Show>
      <Show when={cameraMessage()}>
        <p class="notice" role="status">{cameraMessage()}</p>
      </Show>
      <div
        class="qr-upload-zone"
        classList={{ dragging: dragging() }}
        aria-label="二维码图片上传、拖放或粘贴区域"
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <label class="field">
          <span>QR image · 上传二维码图片</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
            disabled={scan.busy() || approve.busy()}
            onChange={(event) => {
              decode(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
        </label>
        <div class="qr-upload-actions">
          <button class="button outlined" type="button" disabled={scan.busy() || approve.busy()}
            onClick={readClipboard}>粘贴剪贴板图片</button>
          <small class="muted">也可拖入截图，或在弹窗内按 Ctrl+V / ⌘V；最大 8 MiB。</small>
        </div>
      </div>
      <Show when={scan.busy()}>
        <p role="status">正在本地识别 QR 图片…</p>
      </Show>
      <label class="field">
        <span>Telegram login link</span>
        <textarea
          value={input()}
          placeholder="tg://login?token=…"
          disabled={approve.busy()}
          onInput={(event) => {
            stopCapture()
            setCameraMessage('')
            setInput(event.currentTarget.value)
            setApproved(false)
          }}
        />
      </label>
      <label class="field">
        <span>Sign in as</span>
        <select
          aria-label="Sign in as"
          value={account()}
          disabled={approve.busy()}
          onChange={(event) => setAccount(event.currentTarget.value)}
        >
          <For each={readyAccounts()}>
            {(value) => (
              <option value={value.platformId}>
                {value.displayName || value.platformId} · {value.platformKind}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={input() && !token()}>
        <p class="notice error" role="alert">
          Enter a valid Telegram login link containing a 32-byte token.
        </p>
      </Show>
      <ActionError error={scan.error() || approve.error()} />
      <Show when={approved()}>
        <p class="notice" role="status">
          Login approved. Continue in your Telegram client.
        </p>
      </Show>
      <button
        class="button filled"
        disabled={
          !token() ||
          !account() ||
          !props.connected ||
          scan.busy() ||
          approve.busy() ||
          approved()
        }
        onClick={() =>
          void approve.run(async () => {
            const address = sameOriginPath(
              props.data.loginTokenApprovalUrl.replace(/\/$/, '') +
                '/' +
                encodeURIComponent(account()) +
                '/approve',
            )
            const headers = new Headers({ 'content-type': 'application/json' })
            if (sessionToken())
              headers.set('authorization', 'Bearer ' + sessionToken())
            const response = await fetch(address, {
              method: 'POST',
              headers,
              body: JSON.stringify({ token: token() }),
              credentials: 'same-origin',
              signal: controller.signal,
            })
            if (!response.ok) {
              let message = 'Login approval failed: HTTP ' + response.status
              try {
                message = (await response.json()).error ?? message
              } catch {}
              throw new Error(message)
            }
            setApproved(true)
          })
        }
      >
        {approve.busy() ? 'Approving…' : 'Approve login'}
      </button>
      <small class="muted">
        Approving grants the requesting Telegram client access to the selected
        platform account.
      </small>
    </Modal>
  )
}
