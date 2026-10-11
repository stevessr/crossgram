import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ServerTransportSocket } from './server-socket.js'

/**
 * Bridges one WebSocket connection into the `Duplex` byte stream the MTProto
 * transport stack expects. Binary frames carry the same obfuscated/abridged
 * byte stream a TCP socket would; frame boundaries are meaningless, the
 * receive buffer reassembles MTProto packets across them.
 */
export class WebSocketBridge extends Duplex implements ServerTransportSocket {
  readonly remoteAddress: string | undefined
  readonly remotePort: number | undefined
  private _ended = false

  constructor(
    private readonly _ws: WebSocket,
    request: IncomingMessage,
  ) {
    super()
    this.remoteAddress = request.socket.remoteAddress
    this.remotePort = request.socket.remotePort
    this._ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this._ended || !isBinary) return
      // ws reuses the buffer after the listener returns; copy for async decode.
      // Some runtimes (notably Bun's Node-compatible HTTP upgrade path) expose
      // a WebSocket without ws's pause()/resume() flow-control helpers. The
      // stream remains usable without those optional backpressure controls.
      if (!this.push(new Uint8Array(data))) this._ws.pause?.()
    })
    this._ws.on('close', () => this._endStream())
    this._ws.on('error', () => this._endStream())
  }

  private _endStream(): void {
    if (this._ended) return
    this._ended = true
    this.push(null)
    this.destroy()
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this._ws.send(chunk, { binary: true }, (error) => callback(error ?? null))
  }

  override _final(callback: (error?: Error | null) => void): void {
    this._ws.close()
    callback()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this._ws.terminate()
    callback(error)
  }

  override _read(): void {
    this._ws.resume?.()
  }

  // TCP-only tunables; WebSocket framing has no equivalent.
  setNoDelay(): void {}
  setKeepAlive(): void {}
  // ponytail: no idle-timeout over WS, add a bridge-side timer if WS leaks
  // idle connections in production.
  setTimeout(): void {}
}

export interface WebSocketServerHandle {
  /** The actually bound port (useful when configured with port 0). */
  port: number
  close(): Promise<void>
}

/**
 * Listen for MTProto-over-WebSocket connections. Any request path is accepted
 * (clients differ: mtcute uses `/`, Telegram Web uses `/apiws`); non-WebSocket
 * HTTP requests get a bare 426.
 */
export async function listenWebSocketServer(
  options: { host: string, port: number },
  onConnection: (socket: ServerTransportSocket) => void,
): Promise<WebSocketServerHandle> {
  const httpServer: HttpServer = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('WebSocket required')
  })
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, request) => onConnection(new WebSocketBridge(ws, request)))

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    httpServer.once('error', onError)
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  return {
    port: address && typeof address === 'object' ? address.port : options.port,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    },
  }
}
