/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import type { ComponentProps, JSX } from 'solid-js'
import { ConnectionContext } from 'cordis-webui-solidjs/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixReloginModal } from './add-account.js'

type Connection = ComponentProps<typeof ConnectionContext.Provider>['value']

const storedMatrixEntry = {
  id: 'accounts/matrix-1',
  name: '@mtproto-relay/platform-matrix',
  config: {
    homeserver: 'https://matrix.example.org',
    accessToken: 'stale-token',
    userId: '@alice:example.org',
    proxy: 'http://127.0.0.1:7890',
  },
}

function makeConnection(rpc: (id: string, method: string, args: unknown[]) => Promise<unknown>): Connection {
  return {
    rpc,
    state: {
      status: 'connected',
      entries: { loader: { module: 'loader', methods: ['createConfig', 'updateConfig', 'listConfig'] } },
      error: '',
      updateAvailable: false,
    },
  } as unknown as Connection
}

const passwordFetch = (userId: string) => vi.fn(async (_input: unknown, init?: { body?: string }) => {
  expect(String(_input)).toBe('/api/matrix/login')
  expect(JSON.parse(init?.body ?? '{}')).toMatchObject({
    homeserver: 'https://matrix.example.org',
    userId,
    password: 'pw',
  })
  return {
    ok: true,
    status: 200,
    json: async () => ({ accessToken: 'fresh-token', userId, deviceId: 'DEV' }),
  }
})

describe('Matrix re-login modal', () => {
  let root: HTMLElement
  let dispose: () => void
  function mount(ui: () => JSX.Element) {
    root = document.createElement('div')
    document.body.append(root)
    dispose = render(ui, root)
    return root
  }
  beforeEach(() => {
    if (!HTMLDialogElement.prototype.showModal)
      HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    if (!HTMLDialogElement.prototype.close)
      HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  })
  afterEach(() => {
    dispose?.()
    root?.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rotates the token with a password login while preserving unrelated config keys', async () => {
    vi.stubGlobal('fetch', passwordFetch('@alice:example.org'))
    const updates: unknown[] = []
    const onRelogged = vi.fn(async () => {})
    mount(() => (
      <ConnectionContext.Provider value={makeConnection(async (_id, method, args) => {
        if (method === 'listConfig') return [storedMatrixEntry]
        if (method === 'updateConfig') updates.push(args[0])
        return undefined
      })}>
        <MatrixReloginModal
          entryId="accounts/matrix-1"
          homeserver="https://matrix.example.org"
          onClose={vi.fn()}
          onRelogged={onRelogged}
        />
      </ConnectionContext.Provider>
    ))
    const dialog = () => root.querySelector('dialog')!
    await vi.waitFor(() => expect(dialog()).toBeDefined())
    const userIdInput = dialog().querySelector<HTMLInputElement>('input[type="text"]')!
    userIdInput.value = '@alice:example.org'
    userIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    const passwordInput = dialog().querySelector<HTMLInputElement>('input[type="password"]')!
    passwordInput.value = 'pw'
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...dialog().querySelectorAll('button')].find((button) =>
      button.textContent?.includes('登录并更新令牌'))!
    submit.click()
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toEqual({
      id: 'accounts/matrix-1',
      config: {
        homeserver: 'https://matrix.example.org',
        accessToken: 'fresh-token',
        userId: '@alice:example.org',
        proxy: 'http://127.0.0.1:7890',
      },
    })
    expect(onRelogged).toHaveBeenCalledOnce()
  })

  it('writes a pasted token without re-running the login proxy', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const updates: unknown[] = []
    mount(() => (
      <ConnectionContext.Provider value={makeConnection(async (_id, method, args) => {
        if (method === 'listConfig') return [storedMatrixEntry]
        if (method === 'updateConfig') updates.push(args[0])
        return undefined
      })}>
        <MatrixReloginModal
          entryId="accounts/matrix-1"
          homeserver="https://matrix.example.org"
          onClose={vi.fn()}
          onRelogged={vi.fn()}
        />
      </ConnectionContext.Provider>
    ))
    const tokenTab = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('粘贴访问令牌'))!
    tokenTab.click()
    await vi.waitFor(() => {
      expect([...root.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('保存令牌'))).toBe(true)
    })
    const tokenInput = [...root.querySelectorAll<HTMLInputElement>('input[type="password"]')]
      .find((input) => input.autocomplete === 'off')!
    tokenInput.value = 'pasted-token'
    tokenInput.dispatchEvent(new Event('input', { bubbles: true }))
    const save = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('保存令牌'))!
    save.click()
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    const written = updates[0] as { config: Record<string, unknown> }
    expect(written.config.accessToken).toBe('pasted-token')
    expect(written.config.homeserver).toBe('https://matrix.example.org')
    expect(written.config.proxy).toBe('http://127.0.0.1:7890')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed with a notice when the plugin entry has disappeared', async () => {
    vi.stubGlobal('fetch', passwordFetch('@alice:example.org'))
    const updates: unknown[] = []
    const onRelogged = vi.fn()
    mount(() => (
      <ConnectionContext.Provider value={makeConnection(async (_id, method, args) => {
        if (method === 'listConfig') return []
        if (method === 'updateConfig') updates.push(args[0])
        return undefined
      })}>
        <MatrixReloginModal
          entryId="accounts/gone"
          homeserver="https://matrix.example.org"
          onClose={vi.fn()}
          onRelogged={onRelogged}
        />
      </ConnectionContext.Provider>
    ))
    const dialog = () => root.querySelector('dialog')!
    await vi.waitFor(() => expect(dialog()).toBeDefined())
    const userIdInput = dialog().querySelector<HTMLInputElement>('input[type="text"]')!
    userIdInput.value = '@alice:example.org'
    userIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    const passwordInput = dialog().querySelector<HTMLInputElement>('input[type="password"]')!
    passwordInput.value = 'pw'
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...dialog().querySelectorAll('button')].find((button) =>
      button.textContent?.includes('登录并更新令牌'))!
    submit.click()
    await vi.waitFor(() => {
      expect(root.querySelector('[role="alert"], [role="status"]')?.textContent)
        .toContain('未找到该账号的插件配置')
    })
    expect(updates).toHaveLength(0)
    expect(onRelogged).not.toHaveBeenCalled()
  })
})
