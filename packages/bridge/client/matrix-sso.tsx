/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { consumeMatrixSsoState, matrixAccountLogin, MATRIX_SSO_KEY } from './account-creation-model.js'

/**
 * Matrix SSO landing page.
 *
 * The homeserver redirects here with `?state=…&loginToken=…` after the identity
 * provider signs the user in. The page correlates the state against the flow
 * this tab started, forwards the one-time login token to the opener, and either
 * closes itself or shows the result. The token never touches the server: the
 * opener exchanges it for an access token through the relay's login proxy.
 */
export default function MatrixSsoPage() {
  const [status, setStatus] = createSignal('正在验证登录回调…')
  const [error, setError] = createSignal('')
  const cleanup: Array<() => void> = []

  onMount(() => {
    const params = new URLSearchParams(location.search)
    const loginToken = params.get('loginToken')
    const state = consumeMatrixSsoState(params.get('state') ?? undefined)

    // Always strip the credentials from the address bar (and history).
    history.replaceState(history.state, '', location.pathname)

    if (state === 'missing') {
      setError('没有找到对应的登录请求。请回到平台账号页面重新发起 Matrix SSO 登录。')
      return
    }
    if (state === 'expired') {
      setError('登录请求已过期或不匹配，请回到平台账号页面重新发起。')
      return
    }
    if (!loginToken) {
      setError('回调缺少一次性登录令牌（loginToken）。请重新发起登录。')
      return
    }
    if (!window.opener || window.opener === window) {
      setError('请从平台账号页面发起登录；直接打开此链接无法完成登录。')
      return
    }

    const targetOrigin = location.origin
    const deliver = () => {
      window.opener!.postMessage({
        source: 'crossgram-matrix-sso',
        state,
        loginToken,
      }, targetOrigin)
    }
    deliver()
    // The opener may still be booting its message listener; retry briefly.
    const retries = [200, 500, 1000, 2000].map(delay => window.setTimeout(deliver, delay))
    cleanup.push(() => retries.forEach(id => window.clearTimeout(id)))

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== targetOrigin) return
      const data = event.data as { source?: unknown, ok?: unknown, message?: unknown } | undefined
      if (data?.source !== 'crossgram-matrix-sso-result') return
      if (data.ok) {
        setStatus('登录成功，正在返回平台账号页面…')
        window.setTimeout(() => window.close(), 600)
      } else {
        setError(typeof data.message === 'string' && data.message ? data.message : '交换访问令牌失败，请重试。')
      }
    }
    window.addEventListener('message', onMessage)
    cleanup.push(() => window.removeEventListener('message', onMessage))
    setStatus('已收到登录令牌，正在交给 CrossGram 完成登录…')
    window.setTimeout(() => {
      if (!error()) setStatus('如页面未自动关闭，请回到平台账号页面查看结果，并关闭此窗口。')
    }, 5_000)
  })

  onCleanup(() => { for (const dispose of cleanup) dispose() })

  return (
    <main class="matrix-sso-callback" aria-live="polite">
      <h1>Matrix SSO 登录</h1>
      <Show when={!error()} fallback={<p class="notice error" role="alert">{error()}</p>}>
        <p role="status">{status()}</p>
      </Show>
      <p class="muted">
        完成后此页面会自动关闭。一次性登录令牌只交给发起登录的 CrossGram 页面，不会保存到此页面。
      </p>
    </main>
  )
}
