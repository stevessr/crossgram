import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jsQR from 'jsqr'
import { cameraErrorMessage, screenErrorMessage, startQrCamera, startQrScreen } from './qr-camera.js'

vi.mock('jsqr', () => ({ default: vi.fn() }))

const makeVideo = () => ({
  srcObject: null as MediaStream | null,
  muted: false,
  playsInline: false,
  videoWidth: 1280,
  videoHeight: 720,
  readyState: 2,
  HAVE_CURRENT_DATA: 2,
  play: vi.fn(async () => {}),
  pause: vi.fn(),
}) as unknown as HTMLVideoElement

describe('local Telegram camera QR scanning', () => {
  let nextFrame: FrameRequestCallback | undefined
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(960 * 540 * 4) })),
  }

  beforeEach(() => {
    track.stop.mockClear()
    context.drawImage.mockClear()
    context.getImageData.mockClear()
    vi.mocked(jsQR).mockReset()
    nextFrame = undefined
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(document, 'createElement').mockReturnValue({
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('requests a back camera and scans a bounded frame at a limited rate without uploading it', async () => {
    const video = makeVideo()
    const onScan = vi.fn(() => false)
    vi.mocked(jsQR).mockReturnValue({ data: 'https://example.invalid/' } as ReturnType<typeof jsQR>)
    const stop = await startQrCamera(video, new AbortController().signal, onScan, vi.fn())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    expect(video.srcObject).toBe(stream)
    nextFrame?.(250)
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 960, 540)
    expect(onScan).toHaveBeenCalledWith('https://example.invalid/')
    nextFrame?.(350)
    expect(onScan).toHaveBeenCalledTimes(1)
    stop()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    expect(video.pause).toHaveBeenCalledOnce()
    stop()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('keeps scanning invalid QR data and stops only after the caller accepts the token', async () => {
    const onScan = vi.fn((value: string) => value.startsWith('tg://login?'))
    vi.mocked(jsQR)
      .mockReturnValueOnce({ data: 'https://example.invalid/' } as ReturnType<typeof jsQR>)
      .mockReturnValueOnce({ data: 'tg://login?token=approved' } as ReturnType<typeof jsQR>)
    const video = makeVideo()
    const stop = await startQrCamera(video, new AbortController().signal, onScan, vi.fn())
    nextFrame?.(250)
    expect(track.stop).not.toHaveBeenCalled()
    nextFrame?.(500)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(onScan).toHaveBeenCalledTimes(2)
    stop()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('releases a stream acquired after a pending camera permission was cancelled', async () => {
    let resolve!: (stream: MediaStream) => void
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>((r) => { resolve = r }) },
    })
    const controller = new AbortController()
    const video = makeVideo()
    const pending = startQrCamera(video, controller.signal, vi.fn(), vi.fn())
    controller.abort()
    resolve(stream)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(track.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
  })

  it('closes the camera on a decoder error and gives permission-specific guidance', async () => {
    const error = new Error('Bad camera frame')
    vi.mocked(jsQR).mockImplementation(() => { throw error })
    const failure = vi.fn()
    const stop = await startQrCamera(makeVideo(), new AbortController().signal, vi.fn(), failure)
    nextFrame?.(250)
    expect(failure).toHaveBeenCalledWith(error)
    expect(track.stop).toHaveBeenCalledOnce()
    stop()
    expect(cameraErrorMessage(new DOMException('denied', 'NotAllowedError'))).toContain('权限')
    expect(cameraErrorMessage(new DOMException('missing', 'NotFoundError'))).toContain('未检测')
    expect(cameraErrorMessage(new DOMException('busy', 'NotReadableError'))).toContain('占用')
  })

  it('shares a selected Telegram window without capturing audio and scans while the page is backgrounded', async () => {
    let timer: (() => void) | undefined
    const clear = vi.fn()
    const open = vi.fn(async () => stream)
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: open } })
    vi.stubGlobal('setInterval', vi.fn((fn: () => void) => { timer = fn; return 5 }))
    vi.stubGlobal('clearInterval', clear)
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    vi.mocked(jsQR).mockReturnValue({ data: 'tg://login?token=sample' } as ReturnType<typeof jsQR>)
    const onScan = vi.fn(() => true)
    const video = makeVideo()
    const stop = await startQrScreen(video, new AbortController().signal, onScan, vi.fn())
    expect(open).toHaveBeenCalledWith({ video: true, audio: false })
    expect(video.srcObject).toBe(stream)
    timer?.()
    expect(onScan).toHaveBeenCalledWith('tg://login?token=sample')
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledWith(5)
    stop()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('stops when the user ends screen sharing through browser UI', async () => {
    let ended: (() => void) | undefined
    const screenTrack = {
      stop: vi.fn(),
      addEventListener: vi.fn((_event: string, fn: () => void) => { ended = fn }),
      removeEventListener: vi.fn(),
    }
    const shared = {
      getVideoTracks: () => [screenTrack],
      getTracks: () => [screenTrack],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(async () => shared) } })
    vi.stubGlobal('setInterval', vi.fn(() => 5))
    vi.stubGlobal('clearInterval', vi.fn())
    const onError = vi.fn()
    const video = makeVideo()
    const stop = await startQrScreen(video, new AbortController().signal, vi.fn(() => false), onError)
    ended?.()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '屏幕共享已结束。' }))
    expect(screenTrack.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    stop()
    expect(screenTrack.stop).toHaveBeenCalledOnce()
  })

  it('releases a shared stream if permission resolves after cancellation', async () => {
    let resolve!: (stream: MediaStream) => void
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: () => new Promise<MediaStream>((r) => { resolve = r }) },
    })
    const controller = new AbortController()
    const pending = startQrScreen(makeVideo(), controller.signal, vi.fn(), vi.fn())
    controller.abort()
    resolve(stream)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('explains screen sharing permissions and unsupported browsers', async () => {
    vi.stubGlobal('navigator', {})
    await expect(startQrScreen(makeVideo(), new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toThrow('HTTPS')
    expect(screenErrorMessage(new DOMException('denied', 'NotAllowedError'))).toContain('权限')
    expect(screenErrorMessage(new DOMException('unavailable', 'NotReadableError'))).toContain('无法捕获')
  })

  it('keeps upload and paste available when the camera API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(
      startQrCamera(makeVideo(), new AbortController().signal, vi.fn(), vi.fn()),
    ).rejects.toThrow('HTTPS')
    expect(track.stop).not.toHaveBeenCalled()
  })
})
