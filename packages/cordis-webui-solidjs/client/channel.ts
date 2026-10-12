import { batch } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { apply, DeltaState } from '@cordisjs/muon'
import { decodeFrame, decompressBrowser, encodeFrame, PROTO_TRANSPORT, supportsProtoType, unpackFrame } from '../src/wire.js'
import type {
  EntryMeta,
  EntryDelta,
  Snapshot,
  RpcResponse,
} from '../src/protocol.js'

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
export interface ClientConfig {
  buildId?: string
  endpoint: string
  uiPath: string
  title: string
  heartbeatInterval?: number
  heartbeatTimeout?: number
}
interface PendingStream {
  queue: unknown[]
  done: boolean
  error?: Error
  notify?: () => void
  timer?: ReturnType<typeof setTimeout>
  timeoutMs: number
}
interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
export class Channel<T = any> {
  readonly cursor = new DeltaState()
  readonly state: { value: T; ready: boolean }
  private setState: ReturnType<
    typeof createStore<{ value: T; ready: boolean }>
  >[1]
  users = 0
  constructor(readonly id: string) {
    ;[this.state, this.setState] = createStore<{ value: T; ready: boolean }>({
      value: {} as T,
      ready: false,
    })
  }
  snapshot(snapshot: Snapshot) {
    this.cursor.restore(snapshot.cursor)
    batch(() => {
      this.setState('value', reconcile(snapshot.data as T, { key: null }))
      this.setState('ready', true)
    })
  }
  delta(delta: EntryDelta) {
    if (!this.state.ready) throw new Error('Delta arrived before snapshot')
    const mutation = this.cursor.load(delta)
    this.setState(
      produce((state) => {
        state.value = apply(state.value, mutation)
      }),
    )
  }
  invalidate() {
    this.setState('ready', false)
  }
  clear() {
    this.setState({ value: {} as T, ready: false })
  }
}
export class Connection {
  readonly state: {
    status: ConnectionState
    entries: Record<string, EntryMeta>
    error: string
    updateAvailable: boolean
  }
  private setState: ReturnType<typeof createStore<Connection['state']>>[1]
  private channels = new Map<string, Channel>()
  private pending = new Map<number, Pending>()
  private readonly streams = new Map<number, PendingStream>()
  private supportsStream = false
  private socket?: WebSocket
  private protobuf = false
  private upgradeRequested = false
  private incoming: unknown[] = []
  private draining = false
  private serial = 0
  private retry = 0
  private stopped = true
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private pongTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  constructor(
    readonly config: ClientConfig,
    private makeSocket = (url: string) => new WebSocket(url),
    private baseURL = globalThis.location?.href ?? 'http://localhost/',
  ) {
    ;[this.state, this.setState] = createStore<Connection['state']>({
      status: 'offline',
      entries: {},
      error: '',
      updateAvailable: false,
    })
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }
  private connect() {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.setState('status', this.retry ? 'reconnecting' : 'connecting')
    const url = new URL(this.config.endpoint, this.baseURL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket
    try {
      socket = this.makeSocket(url.href)
    } catch (error) {
      this.disconnected(String(error))
      return
    }
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    // A TCP/WS upgrade can remain pending indefinitely after a proxy or network failure.
    // Require the server's initial snapshot metadata, not merely a successful upgrade.
    this.handshakeTimer = setTimeout(
      () => this.dropSocket(socket, 'WebUI handshake timed out'),
      20_000,
    )
    socket.onmessage = (event) => {
      if (socket !== this.socket) return
      this.incoming.push(event.data)
      if (!this.draining) void this.drain(socket)
    }
    socket.onclose = () => {
      if (socket === this.socket) this.disconnected('Connection lost')
    }
    socket.onerror = () => {
      if (socket === this.socket)
        this.dropSocket(socket, 'WebSocket connection failed')
    }
  }
  private async drain(socket: WebSocket) {
    this.draining = true
    try {
      while (socket === this.socket && this.incoming.length) {
        const raw = this.incoming.shift()
        let message: { type: string; body?: any }
        if (typeof raw === 'string') {
          message = JSON.parse(raw)
        } else {
          const frame = decodeFrame(raw as ArrayBuffer | Uint8Array)
          // Await compressed frames in order: deltas must not overtake snapshots.
          const bytes = frame.gzip ? await decompressBrowser(frame) : frame.payload
          message = unpackFrame(frame, bytes)
        }
        if (socket !== this.socket) return
        this.receive(message)
      }
    } catch {
      if (socket === this.socket) {
        this.setState('error', 'State synchronization failed. Reconnecting…')
        this.dropSocket(socket, 'State synchronization failed')
      }
    } finally {
      if (socket === this.socket) {
        this.draining = false
        if (this.incoming.length) void this.drain(socket)
      }
    }
  }
  private dropSocket(socket: WebSocket, reason: string) {
    if (socket !== this.socket) return
    // Do not depend on a close event: a stuck upgrade may never deliver one.
    this.disconnected(reason)
    try {
      socket.close()
    } catch {
      /* The browser may already have disposed the socket. */
    }
  }
  private receive({ type, body }: { type: string; body?: any }) {
    if (type === 'transport:ready') {
      if (this.upgradeRequested && body?.version === 1) this.protobuf = true
      return
    }
    if (type === 'pong') {
      clearTimeout(this.pongTimer)
      this.pongTimer = undefined
      return
    }
    if (type === 'entry:init') {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
      if (body.version !== 'solid-1') {
        this.setState(
          'error',
          'Incompatible WebUI protocol. Reload after updating.',
        )
        this.stop()
        return
      }
      if (
        this.config.buildId &&
        body.buildId &&
        this.config.buildId !== body.buildId
      ) {
        this.setState('updateAvailable', true)
        this.setState(
          'error',
          'A new WebUI build is available. Your current page is kept open; reload before making further changes.',
        )
        this.stop()
        return
      }
      if (body.reset) this.supportsStream = body.features?.rpcStream === true
      if (body.transport === PROTO_TRANSPORT && !this.upgradeRequested) {
        this.upgradeRequested = true
        this.send('transport:upgrade', { version: 1 })
      }
      batch(() => {
        if (body.reset) {
          this.setState('entries', reconcile(body.entries, { key: null }))
          for (const channel of this.channels.values()) channel.invalidate()
          this.setState('status', 'connected')
          this.setState('error', '')
          this.retry = 0
          this.startHeartbeat()
          for (const [id, channel] of this.channels)
            if (channel.users && body.entries[id])
              this.send('entry:subscribe', { id })
        } else {
          for (const [id, entry] of Object.entries(body.entries)) {
            if (entry) {
              this.setState('entries', id, entry as EntryMeta)
              if (this.channels.get(id)?.users)
                this.send('entry:subscribe', { id })
            } else {
              this.setState('entries', id, undefined!)
              this.channels.get(id)?.clear()
            }
          }
        }
      })
      return
    }
    if (type === 'entry:snapshot') {
      const channel = this.channels.get(body.id)
      if (channel?.users) channel.snapshot(body)
      return
    }
    if (type === 'entry:delta') {
      const channel = this.channels.get(body.id)
      if (channel?.users) channel.delta(body)
      return
    }
    if (type === 'entry:missing') {
      this.channels.get(body.id)?.clear()
      return
    }
    if (type === 'rpc:start' || type === 'rpc:delta' ||
        type === 'rpc:complete' || type === 'rpc:error') {
      const stream = this.streams.get(body?.sn)
      if (!stream || stream.done) return
      this.armStreamTimer(body.sn, stream)
      if (type === 'rpc:delta') {
        if (stream.queue.length >= 16) {
          stream.error = new Error('RPC stream consumer is too slow')
          stream.done = true
          try { this.send('rpc:cancel', { sn: body.sn }) } catch { /* offline */ }
        } else stream.queue.push(body.value)
      } else if (type === 'rpc:complete') {
        stream.done = true
      } else if (type === 'rpc:error') {
        stream.done = true
        stream.error = new Error(String(body.message ?? 'RPC stream failed'))
      }
      stream.notify?.()
      return
    }
    if (type === 'rpc:response') {
      const result = body as RpcResponse
      const request = this.pending.get(result.sn)
      if (!request) return
      this.pending.delete(result.sn)
      clearTimeout(request.timer)
      if (result.ok) request.resolve(result.value)
      else
        request.reject(
          new Error('message' in result ? result.message : 'Request failed'),
        )
    }
  }
  acquire<T>(id: string): { channel: Channel<T>; release: () => void } {
    let channel = this.channels.get(id)
    if (!channel) {
      channel = new Channel(id)
      this.channels.set(id, channel)
    }
    channel.users++
    if (channel.users === 1 && this.state.status === 'connected')
      this.send('entry:subscribe', { id })
    let released = false
    return {
      channel,
      release: () => {
        if (released) return
        released = true
        if (--channel.users) return
        if (this.state.status === 'connected')
          this.send('entry:unsubscribe', { id })
        channel.clear()
        this.channels.delete(id)
      },
    }
  }
  rpc<T = unknown>(
    entryId: string,
    method: string,
    args: unknown[] = [],
    timeout = 30_000,
  ): Promise<T> {
    if (this.state.status !== 'connected')
      return Promise.reject(
        new Error('Not connected. Try again when the connection returns.'),
      )
    if (!this.state.entries[entryId]?.methods.includes(method))
      return Promise.reject(new Error('Method unavailable: ' + method))
    if (this.pending.size + this.streams.size >= 64)
      return Promise.reject(new Error('Too many pending requests'))
    const sn = ++this.serial
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sn)
        reject(
          new Error(
            'Request timed out. Its server-side outcome is unknown; check before retrying.',
          ),
        )
      }, timeout)
      this.pending.set(sn, { resolve, reject, timer })
      try {
        this.send('rpc:request', { sn, entryId, method, args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(sn)
        reject(error)
      }
    })
  }
  /**
   * Explicit opt-in streaming RPC; legacy Promise RPC remains unchanged.
   * Breaking from the iterator sends rpc:cancel to stop server production.
   */
  async *rpcStream<T = unknown>(
    entryId: string,
    method: string,
    args: unknown[] = [],
    timeoutMs = 30_000,
  ): AsyncGenerator<T> {
    if (this.state.status !== 'connected') throw new Error('Not connected')
    if (!this.supportsStream) throw new Error('Server does not support streaming RPC')
    if (!this.state.entries[entryId]?.methods.includes(method))
      throw new Error('Method unavailable: ' + method)
    if (this.pending.size + this.streams.size >= 64)
      throw new Error('Too many pending requests')
    const sn = ++this.serial
    const stream: PendingStream = { queue: [], done: false, timeoutMs }
    this.streams.set(sn, stream)
    this.armStreamTimer(sn, stream)
    try {
      this.send('rpc:request', { sn, entryId, method, args, stream: true })
      while (true) {
        if (stream.queue.length) {
          yield stream.queue.shift() as T
          continue
        }
        if (stream.error) throw stream.error
        if (stream.done) return
        await new Promise<void>(resolve => { stream.notify = resolve })
        stream.notify = undefined
      }
    } finally {
      const wasOpen = !stream.done
      stream.done = true
      if (stream.timer) clearTimeout(stream.timer)
      this.streams.delete(sn)
      if (wasOpen && this.socket?.readyState === 1) {
        try { this.send('rpc:cancel', { sn }) } catch { /* disconnected */ }
      }
    }
  }
  private armStreamTimer(sn: number, stream: PendingStream) {
    if (stream.timer) clearTimeout(stream.timer)
    if (stream.done) return
    stream.timer = setTimeout(() => {
      stream.done = true
      stream.error = new Error('RPC stream timed out; server outcome may be unknown')
      try { if (this.socket?.readyState === 1) this.send('rpc:cancel', { sn }) } catch { /* offline */ }
      stream.notify?.()
    }, stream.timeoutMs)
  }
  private send(type: string, body?: unknown) {
    if (this.socket?.readyState !== 1) throw new Error('Connection is not open')
    this.socket.send(
      this.protobuf && supportsProtoType(type)
        ? encodeFrame(type, body)
        : JSON.stringify({ type, body }),
    )
  }
  private startHeartbeat() {
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(
      () => this.probeHeartbeat(),
      this.config.heartbeatInterval ?? 30_000,
    )
  }
  private probeHeartbeat() {
    const socket = this.socket
    if (
      this.pongTimer ||
      this.state.status !== 'connected' ||
      socket?.readyState !== 1 ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    ) return
    try {
      this.send('ping')
    } catch {
      this.dropSocket(socket, 'Heartbeat send failed')
      return
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined
      if (socket !== this.socket) return
      // Background tabs have heavily throttled JavaScript timers. The server
      // independently keeps the transport alive with native WS control pings.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        return
      this.dropSocket(socket, 'Heartbeat timed out')
    }, this.config.heartbeatTimeout ?? 15_000)
  }
  /** Recheck an idle tab immediately after it regains visibility or network. */
  wake() {
    if (this.stopped) return
    if (this.state.status === 'connected') {
      this.probeHeartbeat()
    } else if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      this.connect()
    }
  }
  private disconnected(reason: string) {
    this.socket = undefined
    this.protobuf = false
    this.upgradeRequested = false
    this.supportsStream = false
    for (const stream of this.streams.values()) {
      if (stream.timer) clearTimeout(stream.timer)
      stream.done = true
      stream.error = new Error(reason + '. RPC stream interrupted.')
      stream.notify?.()
    }
    this.streams.clear()
    this.incoming = []
    this.draining = false
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    clearInterval(this.pingTimer)
    clearTimeout(this.pongTimer)
    this.pongTimer = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(
        new Error(
          reason + '. The operation may have completed; check before retrying.',
        ),
      )
    }
    this.pending.clear()
    for (const channel of this.channels.values()) channel.invalidate()
    if (this.stopped) return
    this.setState('status', 'reconnecting')
    const delay =
      Math.min(30_000, 500 * 2 ** Math.min(this.retry++, 6)) *
      (0.8 + Math.random() * 0.4)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.disconnected('Connection closed')
    socket?.close()
    this.setState('status', 'offline')
  }
}
