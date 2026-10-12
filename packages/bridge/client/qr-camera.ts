/**
 * Scans camera frames locally; no image data is sent to the server.
 * The caller decides whether a decoded QR is acceptable and must explicitly
 * approve the login afterwards.
 */
export async function startQrCamera(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onScan: (value: string) => boolean,
  onError: (error: unknown) => void,
): Promise<() => void> {
  signal.throwIfAborted()
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access requires HTTPS (or localhost) and a supported browser.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  })
  let stopped = false
  let frame = 0
  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    signal.removeEventListener('abort', stop)
    for (const track of stream.getTracks()) track.stop()
    if (video.srcObject === stream) {
      video.pause()
      video.srcObject = null
    }
  }
  signal.addEventListener('abort', stop, { once: true })

  try {
    // getUserMedia cannot be cancelled directly. If the dialog was closed
    // while permission was pending, release the stream as soon as it arrives.
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
    if (!context) throw new Error('The browser cannot decode camera frames')

    let lastSample = -250
    const scan = (timestamp: number) => {
      if (stopped) return
      frame = requestAnimationFrame(scan)
      // 4 scans/second and a 960 px bound prevent excessive CPU on mobile.
      if (timestamp - lastSample < 250 || video.readyState < video.HAVE_CURRENT_DATA)
        return
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) return
      lastSample = timestamp
      const scale = Math.min(1, 960 / Math.max(width, height))
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
    frame = requestAnimationFrame(scan)
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
