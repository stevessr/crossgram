/**
 * Scans locally. Camera and screen frames never leave the browser.
 * A recognized Telegram login token still needs explicit operator approval.
 */
export async function startQrCamera(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onScan: (value: string) => boolean,
  onError: (error: unknown) => void,
): Promise<() => void> {
  signal.throwIfAborted()
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Camera access requires HTTPS (or localhost) and a supported browser.')
  return startQrStream(video, signal, onScan, onError, () =>
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    }), false)
}

/** Share the Telegram window, not the whole desktop where possible. */
export async function startQrScreen(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onScan: (value: string) => boolean,
  onError: (error: unknown) => void,
): Promise<() => void> {
  signal.throwIfAborted()
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new Error('Screen sharing requires HTTPS (or localhost) and a supported browser.')
  // getDisplayMedia must be initiated by a user gesture. Never request audio.
  return startQrStream(video, signal, onScan, onError,
    () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }), true)
}

async function startQrStream(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onScan: (value: string) => boolean,
  onError: (error: unknown) => void,
  open: () => Promise<MediaStream>,
  screen: boolean,
): Promise<() => void> {
  signal.throwIfAborted()
  const stream = await open()
  let stopped = false
  let frame = 0
  let interval: ReturnType<typeof setInterval> | undefined
  const track = stream.getVideoTracks?.()[0] ?? stream.getTracks()[0]
  const onEnded = () => {
    if (stopped) return
    stop()
    onError(new Error('屏幕共享已结束。'))
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    if (interval !== undefined) clearInterval(interval)
    signal.removeEventListener('abort', stop)
    track?.removeEventListener?.('ended', onEnded)
    for (const item of stream.getTracks()) item.stop()
    if (video.srcObject === stream) {
      video.pause()
      video.srcObject = null
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  if (screen) track?.addEventListener?.('ended', onEnded)

  try {
    // The permission prompt itself is not abortable; release late streams.
    signal.throwIfAborted()
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    signal.throwIfAborted()

    const { default: jsQR } = await import('jsqr')
    signal.throwIfAborted()
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('The browser cannot decode captured frames')

    let lastSample = -250
    const scan = (timestamp: number) => {
      if (stopped) return
      if (!screen) frame = requestAnimationFrame(scan)
      // Screen sharing uses a timer because animation frames pause when
      // the user switches to the Telegram application window.
      if (timestamp - lastSample < (screen ? 350 : 250) ||
          video.readyState < video.HAVE_CURRENT_DATA) return
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) return
      lastSample = timestamp
      const scale = Math.min(1, (screen ? 1440 : 960) / Math.max(width, height))
      const scaledWidth = Math.max(1, Math.round(width * scale))
      const scaledHeight = Math.max(1, Math.round(height * scale))
      if (canvas.width !== scaledWidth) canvas.width = scaledWidth
      if (canvas.height !== scaledHeight) canvas.height = scaledHeight
      try {
        context.drawImage(video, 0, 0, scaledWidth, scaledHeight)
        const decoded = jsQR(
          context.getImageData(0, 0, scaledWidth, scaledHeight).data,
          scaledWidth,
          scaledHeight,
          { inversionAttempts: 'attemptBoth' },
        )?.data
        if (decoded && onScan(decoded)) stop()
      } catch (error) {
        stop()
        onError(error)
      }
    }
    if (screen) interval = setInterval(() => scan(performance.now()), 350)
    else frame = requestAnimationFrame(scan)
    return stop
  } catch (error) {
    stop()
    throw error
  }
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError') return '摄像头扫描已取消。'
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return '摄像头权限被拒绝，请在浏览器的网站权限设置中允许访问。'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return '未检测到可用的摄像头。'
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return '摄像头无法启动，可能正被其他应用占用。'
  if (name === 'OverconstrainedError')
    return '摄像头不支持当前拍摄要求。'
  return error instanceof Error ? error.message : '无法启动摄像头，请改用上传图片。'
}

export function screenErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return '屏幕共享已取消或权限被拒绝。'
  if (name === 'NotFoundError') return '没有可共享的窗口或屏幕。'
  if (name === 'NotReadableError') return '无法捕获所选窗口，请改选其他窗口或上传截图。'
  return error instanceof Error ? error.message : '无法共享屏幕，请改用上传或粘贴图片。'
}
