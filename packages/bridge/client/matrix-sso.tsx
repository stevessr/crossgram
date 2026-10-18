/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import {
  consumeMatrixSsoState, matrixAccountLogin, MATRIX_SSO_KEY,
  MATRIX_SSO_TOKEN_KEY, peekMatrixSsoState, updatePlatformPluginConfig,
} from './account-creation-model.js'
import { ActionError, useAction } from 'cordis-webui-solidjs/components'
import { useConnection } from 'cordis-webui-solidjs/client'

/**
 * Matrix SSO landing page.
 *
 * The homeserver redirects here with `?state=…&loginToken=…` after the identity
 * provider signs the user in. This page is self-sufficient: it correlates the
 * state against the flow this browser started, exchanges the one-time login
 * token for an access token through the relay's login proxy, and then either
 * rotates the token on the targeted plugin entry (re-login flow) or parks the
 * credential in sessionStorage for the add-account form to pick up. The
 * initiating tab does not need to still be open.
 */
export default function MatrixSsoPage() {
  const connection = useConnection(),
    action = useAction()
  const [status, setStatus] = createSignal('正在验证登录回调…')
  const [error, setError] = createSignal('')
  const [done, setDone] = createSignal<'entry' | 'draft' | null>(null)
  const cleanup: Array<() => void> = []

  onMount(() => {
    const params = new URLSearchParams(location.search)
    const loginToken = params.get('loginToken')
    const candidateState = params.get('state') ?? undefined
    const pending = peekMatrixSsoState()
    const state = consumeMatrixSsoState(candidateState)

    // Always strip the credentials from the address bar (and history).
    history.replaceState(history.state, '', location.pathname)

    if (pending === 'missing' || state === 'missing') {
      setError('没有找到对应的登录请求。请回到平台账号页面重新发起 Matrix SSO 登录。')
      return
    }
    if (pending === 'expired' || state === 'expired') {
      setError('登录请求已过期或不匹配，请回到平台账号页面重新发起。')
      return
    }
    if (!loginToken) {
      setError('回调缺少一次性登录令牌（loginToken）。请重新发起登录。')
      return
    }

    void action.run(async () => {
      setStatus('正在向 Homeserver 换取访问令牌…')
      const snapshot = { homeserver: pending.homeserver } as Parameters<typeof matrixAccountLogin>[0]
      const result = await matrixAccountLogin(snapshot, 'sso', loginToken)
      // Notify a live opener (the add-account modal still listens); it is
      // optional now — the exchange already succeeded on this page.
      try {
        if (window.opener && window.opener !== window) {
          window.opener.postMessage({
            source: 'crossgram-matrix-sso-result', ok: true,
          }, location.origin)
        }
      } catch {
        // The opener may be gone; the self-sufficient flow continues below.
      }
      if (pending.entryId) {
        setStatus('正在把新令牌写入现有 Matrix 配置…')
        const loaderId = Object.entries(connection.state.entries).find(
          ([, entry]) => entry.module === 'loader'
            && entry.methods.includes('updateConfig')
            && entry.methods.includes('listConfig'),
        )?.[0]
        if (!loaderId) throw new Error('未找到在线插件管理服务，无法写回令牌；请回到平台账号页面用粘贴令牌方式完成。')
        await updatePlatformPluginConfig(
          (id, method, args) => connection.rpc(id, method, args),
          loaderId,
          pending.entryId,
          {
            accessToken: snapshot.accessToken,
            ...(result.userId ? { userId: result.userId } : {}),
          },
        )
        setDone('entry')
        setStatus('登录成功，已更新访问令牌。可以关闭此页并回到平台账号页面查看状态。')
      } else {
        sessionStorage.setItem(MATRIX_SSO_TOKEN_KEY, JSON.stringify({
          accessToken: snapshot.accessToken,
          userId: result.userId,
          homeserver: pending.homeserver,
          state,
          started: Date.now(),
        }))
        setDone('draft')
        setStatus('登录成功。回到平台账号页面的「添加账号」表单即可继续（令牌已在本浏览器暂存，不会发往其它页面）。')
      }
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  })

  onCleanup(() => { for (const dispose of cleanup) dispose() })

  return (
    <main class="matrix-sso-callback" aria-live="polite">
      <h1>Matrix SSO 登录</h1>
      <Show when={!error()} fallback={<p class="notice error" role="alert">{error()}</p>}>
        <Show
          when={done()}
          fallback={<p role="status">{status()}</p>}
        >
          <p class="notice" role="status">{status()}</p>
          <Show when={done() === 'entry'}>
            <button class="button filled" onClick={() => window.close()}>
              关闭此页
            </button>
          </Show>
        </Show>
      </Show>
      <p class="muted">
        {done() === 'draft'
          ? '令牌只保存在本浏览器，直到表单读取或 10 分钟后过期。'
          : '一次性登录令牌只在本页换取访问令牌，CrossGram 不会保存登录凭据。'}
      </p>
    </main>
  )
}
