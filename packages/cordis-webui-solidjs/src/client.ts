import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { decodeFrame, encodeFrame, PROTO_TRANSPORT, supportsProtoType, unpackFrame } from './wire.js'
import type WebUI from './index.js'

const SERVER_PING_INTERVAL = 25_000
const SERVER_PONG_TIMEOUT = 90_000
import {
  MAX_PENDING_RPC,
  MAX_REQUEST_BYTES,
  MAX_SOCKET_BUFFER,
} from './protocol.js'

export interface Socket {
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  terminate?(): void
  /** Native ws control frames keep reverse proxies alive even for suspended tabs. */
  ping?(): void
  on?(event: string, listener: () => void): void
  off?(event: string, listener: () => void): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}
// Low-CPU compression for state snapshots and large deltas. Small frames do
// not pay a gzip penalty, and compression is skipped unless it saves >= 12.5%.
export function fastGzip(data: Uint8Array): Uint8Array {
  return gzipSync(data, { level: 1 })
}
export class Client {
  readonly id = randomUUID()
  readonly subscriptions = new Set<string>()
  protobuf = false
  private active = true
  private inFlight = new Set<number>()
  private readonly streams = new Map<number, {
    cancelled: boolean
    iterator?: AsyncIterator<unknown>
  }>()
  private pingTimer?: ReturnType<typeof setInterval>
  private awaitingPongSince = 0
  private receivedPong = () => { this.awaitingPongSince = 0 }
  constructor(
    readonly webui: WebUI,
    readonly socket: Socket,
  ) {
    socket.addEventListener('message', this.receive)
    socket.addEventListener('close', this.dispose)
    this.send({
      type: 'entry:init',
      body: {
        version: webui.version,
        buildId: webui.buildId,
        transport: PROTO_TRANSPORT,
        features: { rpcStream: true },
        reset: true,
        entries: Object.fromEntries(
          Object.values(webui.entries).map((entry) => [
            entry.id,
            entry.toJSON(),
          ]),
        ),
      },
    })
    this.startKeepAlive()
  }
  private startKeepAlive() {
    const socket = this.socket
    // Cordis uses the Node 'ws' transport. Native ping/pong frames are handled
    // by browsers without depending on setInterval in a background tab.
    if (!socket.ping || !socket.on || !socket.off) return
    socket.on('pong', this.receivedPong)
    this.pingTimer = setInterval(() => {
      if (!this.active) return
      if (socket.readyState !== 1) {
        this.dispose()
        return
      }
      if (this.awaitingPongSince) {
        if (Date.now() - this.awaitingPongSince < SERVER_PONG_TIMEOUT) return
        this.dispose()
        if (socket.terminate) socket.terminate()
        else socket.close(1013, 'WebUI keepalive timeout')
        return
      }
      try {
        this.awaitingPongSince = Date.now()
        socket.ping!()
      } catch {
        this.dispose()
        if (socket.terminate) socket.terminate()
        else socket.close()
      }
    }, SERVER_PING_INTERVAL)
    this.pingTimer.unref?.()
  }
  get ctx() {
    return this.webui.ctx
  }
  send(payload: { type: string; body?: unknown }): boolean {
    if (!this.active || this.socket.readyState !== 1) return false
    if (this.protobuf && supportsProtoType(payload.type)) {
      try {
        return this.sendData(encodeFrame(payload.type, payload.body, fastGzip))
      } catch {
        this.dispose()
        this.socket.close(1011, 'WebUI serialization failed')
        return false
      }
    }
    return this.sendData(JSON.stringify(payload))
  }
  sendRaw(payload: string, preparedProto?: Uint8Array): boolean {
    if (!this.active || this.socket.readyState !== 1) return false
    if (this.protobuf) {
      try {
        if (preparedProto) return this.sendData(preparedProto)
        const message = JSON.parse(payload)
        if (supportsProtoType(message.type))
          return this.sendData(encodeFrame(message.type, message.body, fastGzip))
      } catch {
        this.dispose()
        this.socket.close(1011, 'WebUI serialization failed')
        return false
      }
    }
    return this.sendData(payload)
  }
  private sendData(payload: string | Uint8Array): boolean {
    if (!this.active || this.socket.readyState !== 1) return false
    if (
      !Number.isFinite(this.socket.bufferedAmount) ||
      this.socket.bufferedAmount + Buffer.byteLength(payload) >
        MAX_SOCKET_BUFFER
    ) {
      this.dispose()
      if (this.socket.terminate) this.socket.terminate()
      else this.socket.close(1013, 'WebUI client is too slow')
      return false
    }
    try {
      this.socket.send(payload)
      return true
    } catch {
      this.dispose()
      this.socket.close()
      return false
    }
  }
  dispose = () => {
    if (!this.active) return
    this.active = false
    clearInterval(this.pingTimer)
    this.socket.off?.('pong', this.receivedPong)
    this.subscriptions.clear()
    this.inFlight.clear()
    for (const state of this.streams.values()) {
      state.cancelled = true
      if (state.iterator?.return) void Promise.resolve(state.iterator.return()).catch(() => {})
    }
    this.streams.clear()
    this.socket.removeEventListener('message', this.receive)
    this.socket.removeEventListener('close', this.dispose)
    delete this.webui.clients[this.id]
    this.webui.connectionChanged(this)
  }
  receive = async (event: { data: string | Uint8Array | ArrayBuffer }) => {
    if (!this.active) return
    try {
      const raw = event.data
      if ((typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength) > MAX_REQUEST_BYTES) {
        this.socket.close(1009, 'Request too large')
        return
      }
      let message: { type: string; body?: any }
      if (typeof raw === 'string') {
        message = JSON.parse(raw)
      } else {
        const frame = decodeFrame(raw)
        const payload = frame.gzip
          ? gunzipSync(frame.payload, { maxOutputLength: MAX_REQUEST_BYTES })
          : frame.payload
        if (payload.byteLength > MAX_REQUEST_BYTES) {
          this.socket.close(1009, 'Request too large')
          return
        }
        message = unpackFrame(frame, payload)
      }
      if (!message || typeof message !== 'object')
        throw new Error('Expected message')
      const { type, body } = message
      if (type === 'transport:upgrade') {
        // Send JSON acknowledgement before changing the encoding to make the
        // transition safe for old browsers and messages already in flight.
        if (!this.protobuf && body?.version === 1) {
          this.send({ type: 'transport:ready', body: { version: 1 } })
          this.protobuf = true
        }
        return
      }
      if (type === 'ping') {
        this.send({ type: 'pong' })
        return
      }
      if (type === 'entry:subscribe') {
        if (typeof body?.id !== 'string') throw new Error('Expected entry ID')
        const entry = this.webui.entries[body.id]
        if (!entry) {
          this.send({ type: 'entry:missing', body: { id: body.id } })
          return
        }
        this.subscriptions.add(entry.id)
        this.send({ type: 'entry:snapshot', body: entry.snapshot() })
        return
      }
      if (type === 'entry:unsubscribe') {
        this.subscriptions.delete(body?.id)
        return
      }
      if (type === 'rpc:cancel') {
        if (!Number.isSafeInteger(body?.sn) || body.sn < 0)
          throw new Error('Invalid RPC cancel request')
        const state = this.streams.get(body.sn)
        if (state) {
          state.cancelled = true
          if (state.iterator?.return) void Promise.resolve(state.iterator.return()).catch(() => {})
        }
        return
      }
      if (type !== 'rpc:request') return
      if (
        !Number.isSafeInteger(body?.sn) ||
        body.sn < 0 ||
        typeof body.entryId !== 'string' ||
        typeof body.method !== 'string' ||
        !Array.isArray(body.args)
      )
        throw new Error('Invalid RPC request')
      const { sn, entryId, method, args } = body
      if (this.inFlight.has(sn)) throw new Error('Duplicate RPC serial')
      if (this.inFlight.size >= MAX_PENDING_RPC) {
        this.send({
          type: 'rpc:response',
          body: { sn, ok: false, message: 'Too many pending requests' },
        })
        return
      }
      const entry = this.webui.entries[entryId]
      // Only explicitly exposed own methods are callable; never Object.prototype.
      const fn =
        entry && Object.hasOwn(entry.data ?? {}, method) && entry.data[method]
      if (typeof fn !== 'function') {
        this.send({
          type: 'rpc:response',
          body: { sn, ok: false, message: 'No such method: ' + method },
        })
        return
      }
      this.inFlight.add(sn)
      const streaming = body.stream === true
      const state = { cancelled: false, iterator: undefined as AsyncIterator<unknown> | undefined }
      if (streaming) {
        this.streams.set(sn, state)
        this.send({ type: 'rpc:start', body: { sn } })
      }
      try {
        const value = await Reflect.apply(fn, entry, args)
        if (!streaming) {
          this.send({ type: 'rpc:response', body: { sn, ok: true, value } })
        } else if (!state.cancelled) {
          if (value && typeof value[Symbol.asyncIterator] === 'function') {
            state.iterator = value[Symbol.asyncIterator]()
            while (!state.cancelled) {
              const next = await state.iterator.next()
              if (next.done) break
              if (!this.send({ type: 'rpc:delta', body: { sn, value: next.value } })) break
            }
          } else {
            this.send({ type: 'rpc:delta', body: { sn, value } })
          }
          if (!state.cancelled) this.send({ type: 'rpc:complete', body: { sn } })
        }
      } catch (error) {
        if (streaming) {
          if (!state.cancelled) this.send({
            type: 'rpc:error',
            body: { sn, message: error instanceof Error ? error.message : String(error) },
          })
        } else {
          this.send({
            type: 'rpc:response',
            body: {
              sn,
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      } finally {
        this.inFlight.delete(sn)
        if (streaming) this.streams.delete(sn)
      }
    } catch {
      this.socket.close(1007, 'Invalid WebUI message')
    }
  }
}
