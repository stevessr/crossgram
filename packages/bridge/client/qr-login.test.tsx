/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QrLogin } from './accounts.js'
import { decodeQrImage } from './qr.js'
import { startQrScreen } from './qr-camera.js'

vi.mock('./qr.js', () => ({ decodeQrImage: vi.fn() }))
vi.mock('./qr-camera.js', () => ({
  startQrCamera: vi.fn(async () => () => {}),
  startQrScreen: vi.fn(async () => () => {}),
  cameraErrorMessage: (error: Error) => error.message,
  screenErrorMessage: (error: Error) => error.message,
}))

const validToken = btoa('x'.repeat(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const loginLink = 'tg://login?token=' + validToken
const data = {
  loginTokenApprovalUrl: '/api/telegram-login',
  accounts: [{
    platformId: 'telegram-account',
    platformKind: 'telegram',
    displayName: 'My Telegram',
    status: 'ready',
  }],
}

let root: HTMLElement
let dispose: () => void
function mount() {
  root = document.createElement('div')
  document.body.append(root)
  dispose = render(() => (
    <QrLogin data={data as any} connected onClose={vi.fn()} />
  ), root)
  return root
}
beforeEach(() => {
  vi.mocked(decodeQrImage).mockReset().mockResolvedValue(loginLink)
  vi.mocked(startQrScreen).mockClear()
  if (!HTMLDialogElement.prototype.showModal)
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  if (!HTMLDialogElement.prototype.close)
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => {
  dispose?.()
  root?.remove()
  vi.restoreAllMocks()
})

describe('Telegram QR login inputs', () => {
  it('exposes screen sharing and keeps manual approval separate from decoding', async () => {
    const host = mount()
    const share = Array.from(host.querySelectorAll('button'))
      .find((node) => node.textContent?.includes('共享 Telegram 窗口扫码'))!
    expect(share).toBeDefined()
    share.click()
    await vi.waitFor(() => expect(startQrScreen).toHaveBeenCalledOnce())
    expect(host.textContent).toContain('停止共享屏幕')
    expect(host.textContent).toContain('Approve login')
  })

  it('decodes pasted images and does not automatically approve the Telegram login', async () => {
    const host = mount()
    const file = new File(['png'], 'screenshot.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: {
      items: [{ type: 'image/png', getAsFile: () => file }],
    } })
    window.dispatchEvent(paste)
    await vi.waitFor(() => expect(decodeQrImage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(host.querySelector('textarea')?.value).toBe(loginLink))
    expect(paste.defaultPrevented).toBe(true)
    expect(host.textContent).toContain('Approve login')
    expect(host.textContent).not.toContain('Login approved.')
  })

  it('accepts dropped screenshots and clears the file picker to permit reselecting the same image', async () => {
    const host = mount()
    const file = new File(['png'], 'qr.png', { type: 'image/png' })
    const zone = host.querySelector('.qr-upload-zone')!
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    zone.dispatchEvent(drop)
    await vi.waitFor(() => expect(decodeQrImage).toHaveBeenCalledOnce())
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(decodeQrImage).toHaveBeenCalledTimes(2))
    expect(picker.value).toBe('')
  })

  it('reads clipboard images through the explicit paste button', async () => {
    const host = mount()
    const file = new Blob(['png'], { type: 'image/png' })
    const read = vi.fn(async () => [{ types: ['image/png'], getType: async () => file }])
    vi.stubGlobal('navigator', { clipboard: { read } })
    const pasteButton = Array.from(host.querySelectorAll('button'))
      .find((node) => node.textContent?.includes('粘贴剪贴板图片'))!
    pasteButton.click()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(decodeQrImage).toHaveBeenCalledOnce())
    vi.unstubAllGlobals()
  })
})
