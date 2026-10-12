/** Forward WebSocket action/event transport for the OneBot 11 JSON protocol. */
export interface OneBotSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void): void
}

export interface OneBotClientOptions {
  endpoint: string
  accessToken?: string
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  socketFactory?: (url: string) => OneBotSocket
  onWarning?: (message: string) => void
}

type EventHandler = (event: Record<string, unknown>) => void | Promise<void>
interface PendingCall {
  resolve(value: unknown): void
  reject(reason: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export class OneBotClient {
  private socket?: OneBotSocket
  private connecting?: Promise<void>
  private readonly handlers = new Set<EventHandler>()
  private readonly pending = new Map<string, PendingCall>()
  private readonly factory: (url: string) => OneBotSocket
  private readonly timeoutMs: number
  private readonly reconnectDelayMs: number
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private attempt = 0
  private sequence = 0
  private stopped = false

  constructor(private readonly options: OneBotClientOptions) {
    const url = new URL(options.endpoint)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('OneBot endpoint must use ws:// or wss://')
    this.factory = options.socketFactory ?? ((endpoint) => new WebSocket(endpoint))
    this.timeoutMs = options.requestTimeoutMs ?? 15_000
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
  }

  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== 1) throw new Error('OneBot socket is disconnected')
    const echo = `crossgram-${++this.sequence}`
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot action timed out: ${action}`))
      }, this.timeoutMs)
      this.pending.set(echo, { resolve: (value) => resolve(value as T), reject, timeout })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(echo)
        reject(asError(error))
      }
    })
  }

  async subscribe(handler: EventHandler): Promise<() => void> {
    this.handlers.add(handler)
    try {
      await this.connect()
    } catch (error) {
      this.handlers.delete(handler)
      throw error
    }
    return () => {
      this.handlers.delete(handler)
      if (!this.handlers.size) this.closeSocket()
    }
  }

  stop(): void {
    this.stopped = true
    this.handlers.clear()
    this.closeSocket()
  }

  private closeSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.failPending(new Error('OneBot socket disconnected'))
    const socket = this.socket
    this.socket = undefined
    if (socket && socket.readyState < 2) socket.close()
  }

  private async connect(): Promise<void> {
    if (this.stopped) throw new Error('OneBot client has stopped')
    if (this.socket?.readyState === 1) return
    if (this.connecting) return this.connecting
    // OneBot v11 supports access_token as a WS URL parameter. Use WSS over untrusted networks.
    const endpoint = new URL(this.options.endpoint)
    if (this.options.accessToken) endpoint.searchParams.set('access_token', this.options.accessToken)
    const socket = this.factory(endpoint.toString())
    this.socket = socket
    const connection = new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => fail(new Error('OneBot socket connection timed out')), this.timeoutMs)
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
      socket.addEventListener('open', () => {
        if (settled || this.socket !== socket) return
        settled = true
        clearTimeout(timeout)
        this.attempt = 0
        resolve()
      })
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return
        let payload: unknown
        try {
          const raw = event.data
          payload = JSON.parse(typeof raw === 'string' ? raw : String(raw))
        } catch {
          this.options.onWarning?.('OneBot sent invalid JSON; frame ignored')
          return
        }
        if (!isObject(payload)) return
        if (payload.echo !== undefined && payload.echo !== null) {
          const echo = String(payload.echo)
          const call = this.pending.get(echo)
          if (!call) return
          this.pending.delete(echo)
          clearTimeout(call.timeout)
          if (payload.status === 'failed' || (payload.retcode !== undefined && Number(payload.retcode) !== 0)) {
            call.reject(new Error(`OneBot action failed (retcode ${payload.retcode ?? 'unknown'}): ${String(payload.message ?? payload.wording ?? '')}`))
          } else {
            call.resolve(payload.data)
          }
          return
        }
        if (typeof payload.post_type !== 'string') return
        for (const handler of this.handlers) {
          try {
            void Promise.resolve(handler(payload)).catch((error) =>
              this.options.onWarning?.(`OneBot event handler failed: ${asError(error).message}`))
          } catch (error) {
            this.options.onWarning?.(`OneBot event handler failed: ${asError(error).message}`)
          }
        }
      })
      socket.addEventListener('error', () => {
        fail(new Error('OneBot socket connection failed'))
      })
      socket.addEventListener('close', () => {
        fail(new Error('OneBot socket closed during connection'))
        if (this.socket !== socket) return
        this.socket = undefined
        this.failPending(new Error('OneBot socket closed'))
        this.scheduleReconnect()
      })
      if (socket.readyState === 1) {
        settled = true
        clearTimeout(timeout)
        resolve()
      }
    })
    this.connecting = connection
    try {
      await connection
    } catch (error) {
      if (this.socket === socket) {
        this.socket = undefined
        if (socket.readyState < 2) socket.close()
        this.scheduleReconnect()
      }
      throw error
    } finally {
      if (this.connecting === connection) this.connecting = undefined
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.handlers.size || this.reconnectTimer) return
    const wait = Math.min(30_000, this.reconnectDelayMs * 2 ** Math.min(this.attempt++, 5))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch((error) => {
        this.options.onWarning?.(`OneBot reconnect failed: ${asError(error).message}`)
      })
    }, wait)
  }

  private failPending(error: Error): void {
    for (const [echo, call] of this.pending) {
      clearTimeout(call.timeout)
      call.reject(error)
      this.pending.delete(echo)
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
