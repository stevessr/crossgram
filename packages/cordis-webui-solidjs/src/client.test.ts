import { describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { Client, type Socket } from './client.js'
import {
  MAX_PENDING_RPC,
  MAX_REQUEST_BYTES,
  MAX_SOCKET_BUFFER,
} from './protocol.js'
import type WebUI from './index.js'
import { decodeFrame, encodeFrame, unpackFrame } from './wire.js'

class FakeSocket implements Socket {
  bufferedAmount = 0
  readyState = 1
  frames: any[] = []
  binaryFrames: Uint8Array[] = []
  listeners = new Map<string, Set<Function>>()
  send = vi.fn((value: string | Uint8Array) => {
    if (typeof value === 'string') {
      this.frames.push(JSON.parse(value))
    } else {
      this.binaryFrames.push(value)
      const frame = decodeFrame(value)
      this.frames.push(unpackFrame(frame, frame.gzip ? gunzipSync(frame.payload) : frame.payload))
    }
  })
  close = vi.fn((code?: number) => {
    this.readyState = 3
    for (const fn of this.listeners.get('close') ?? []) fn({ code })
  })
  terminate = vi.fn(() => this.close(1013))
  ping?: () => void
  on?: (event: string, listener: () => void) => void
  off?: (event: string, listener: () => void) => void
  addEventListener(type: string, fn: Function) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: Function) {
    this.listeners.get(type)?.delete(fn)
  }
}
function setup(data: Record<string, any> = { count: 0, increment: () => 42 }, keepAlive = false) {
  const entry = {
    id: 'entry',
    data,
    toJSON: () => ({
      module: 'debug',
      methods: ['increment'],
      files: [],
      routes: [],
    }),
    snapshot: () => ({ id: 'entry', data, cursor: {} }),
  }
  const webui = {
    version: 'solid-1',
    entries: { entry },
    clients: {},
    connectionChanged: vi.fn(),
    ctx: {},
  } as unknown as WebUI
  const socket = new FakeSocket()
  if (keepAlive) {
    socket.ping = vi.fn()
    socket.on = (event, listener) => socket.addEventListener(event, listener)
    socket.off = (event, listener) => socket.removeEventListener(event, listener)
  }
  const client = new Client(webui, socket)
  webui.clients[client.id] = client
  const request = (type: string, body?: unknown) =>
    client.receive({ data: JSON.stringify({ type, body }) })
  return { socket, client, webui, entry, request }
}
describe('bounded subscription/RPC transport', () => {
  it('sends metadata without eagerly serializing large or sensitive entry state', () => {
    const { socket } = setup({
      secret: 'never in metadata',
      history: 'x'.repeat(10_000_000),
    })
    expect(socket.frames).toHaveLength(1)
    expect(JSON.stringify(socket.frames)).not.toContain('secret')
    expect(socket.terminate).not.toHaveBeenCalled()
  })
  it('negotiates protobuf without breaking the JSON bootstrap and receives binary commands', async () => {
    const { socket, request, client } = setup()
    expect(socket.frames[0].body.transport).toBe('protobuf-gzip-v1')
    await request('transport:upgrade', { version: 1 })
    expect(socket.frames.at(-1)).toEqual({ type: 'transport:ready', body: { version: 1 } })
    expect(client.protobuf).toBe(true)
    await client.receive({ data: encodeFrame('entry:subscribe', { id: 'entry' }) })
    expect(socket.binaryFrames.length).toBeGreaterThan(0)
    expect(socket.frames.at(-1).type).toBe('entry:snapshot')
    await client.receive({ data: encodeFrame('ping') })
    expect(socket.frames.at(-1).type).toBe('pong')
  })
  it('compresses large snapshots after upgrade and preserves the original payload', async () => {
    const data = { large: 'a'.repeat(100_000) }
    const { socket, request, client } = setup(data)
    await request('transport:upgrade', { version: 1 })
    await request('entry:subscribe', { id: 'entry' })
    const frame = decodeFrame(socket.binaryFrames.at(-1)!)
    expect(frame.gzip).toBe(true)
    expect(socket.binaryFrames.at(-1)!.length).toBeLessThan(1000)
    expect(unpackFrame(frame, gunzipSync(frame.payload)).body.data.large).toHaveLength(100_000)
    client.dispose()
  })
  it('subscribes with a complete snapshot, unsubscribes, and answers heartbeat', async () => {
    const { request, client, socket } = setup()
    await request('entry:subscribe', { id: 'entry' })
    expect(client.subscriptions.has('entry')).toBe(true)
    expect(socket.frames.at(-1).type).toBe('entry:snapshot')
    await request('entry:unsubscribe', { id: 'entry' })
    expect(client.subscriptions.size).toBe(0)
    await request('ping')
    expect(socket.frames.at(-1).type).toBe('pong')
    await request('entry:subscribe', { id: 'missing' })
    expect(socket.frames.at(-1)).toEqual({
      type: 'entry:missing',
      body: { id: 'missing' },
    })
  })
  it('calls only exposed own methods and binds this to the entry', async () => {
    const { request, socket, entry } = setup({
      increment(this: any, amount: number) {
        return this.id + ':' + amount
      },
      explode() {
        throw Error('failure')
      },
    })
    await request('rpc:request', {
      sn: 1,
      entryId: entry.id,
      method: 'increment',
      args: [3],
    })
    expect(socket.frames.at(-1).body).toEqual({
      sn: 1,
      ok: true,
      value: 'entry:3',
    })
    for (const method of ['constructor', 'toString', '__proto__', 'absent']) {
      await request('rpc:request', {
        sn: 2,
        entryId: 'entry',
        method,
        args: [],
      })
      expect(socket.frames.at(-1).body.ok).toBe(false)
    }
    await request('rpc:request', {
      sn: 3,
      entryId: 'entry',
      method: 'explode',
      args: [],
    })
    expect(socket.frames.at(-1).body).toEqual({
      sn: 3,
      ok: false,
      message: 'failure',
    })
  })
  it('closes malformed, oversized and duplicate requests instead of throwing unhandled rejections', async () => {
    for (const data of [
      '{',
      'null',
      JSON.stringify({ type: 'rpc:request', body: { sn: -1 } }),
    ]) {
      const { client, socket } = setup()
      await client.receive({ data })
      expect(socket.close).toHaveBeenCalledWith(1007, expect.any(String))
    }
    const { client, socket } = setup()
    await client.receive({ data: 'x'.repeat(MAX_REQUEST_BYTES + 1) })
    expect(socket.close).toHaveBeenCalledWith(1009, expect.any(String))
    const pending = setup({ wait: () => new Promise(() => {}) })
    void pending.request('rpc:request', {
      sn: 1,
      entryId: 'entry',
      method: 'wait',
      args: [],
    })
    await pending.request('rpc:request', {
      sn: 1,
      entryId: 'entry',
      method: 'wait',
      args: [],
    })
    expect(pending.socket.close).toHaveBeenCalledWith(1007, expect.any(String))
  })
  it('bounds concurrent RPC calls', async () => {
    const { request, socket, client } = setup({
      wait: () => new Promise(() => {}),
    })
    for (let sn = 0; sn < MAX_PENDING_RPC; sn++)
      void request('rpc:request', {
        sn,
        entryId: 'entry',
        method: 'wait',
        args: [],
      })
    await request('rpc:request', {
      sn: MAX_PENDING_RPC,
      entryId: 'entry',
      method: 'wait',
      args: [],
    })
    expect(socket.frames.at(-1).body.message).toBe('Too many pending requests')
    client.dispose()
  })
  it('streams an async iterable with start/delta/complete and keeps legacy RPC intact', async () => {
    const { socket, request } = setup({
      async *events() {
        yield { index: 1 }
        yield { index: 2 }
      },
    })
    await request('rpc:request', {
      sn: 7, entryId: 'entry', method: 'events', args: [], stream: true,
    })
    expect(socket.frames.filter(frame => frame.body?.sn === 7).map(frame => frame.type))
      .toEqual(['rpc:start', 'rpc:delta', 'rpc:delta', 'rpc:complete'])
    expect(socket.frames.filter(frame => frame.type === 'rpc:delta').map(frame => frame.body.value.index))
      .toEqual([1, 2])
    expect(socket.frames.some(frame => frame.type === 'rpc:response' && frame.body?.sn === 7)).toBe(false)
  })
  it('cancels an in-flight stream and never sends a late completion', async () => {
    let resume!: () => void
    const block = new Promise<void>(resolve => { resume = resolve })
    const { socket, request, client } = setup({
      async *events() {
        yield 'first'
        await block
        yield 'second'
      },
    })
    const pending = request('rpc:request', {
      sn: 8, entryId: 'entry', method: 'events', args: [], stream: true,
    })
    await vi.waitFor(() => expect(socket.frames.some(frame => frame.type === 'rpc:delta' && frame.body.sn === 8)).toBe(true))
    await request('rpc:cancel', { sn: 8 })
    resume()
    await pending
    expect(socket.frames.filter(frame => frame.body?.sn === 8).map(frame => frame.type))
      .toEqual(['rpc:start', 'rpc:delta'])
    client.dispose()
  })
  it('emits a terminal rpc:error rather than closing WS on stream failure', async () => {
    const { request, socket } = setup({
      async *events() {
        yield 'before-error'
        throw new Error('stream broke')
      },
    })
    await request('rpc:request', {
      sn: 9, entryId: 'entry', method: 'events', args: [], stream: true,
    })
    expect(socket.frames.at(-1)).toEqual({
      type: 'rpc:error', body: { sn: 9, message: 'stream broke' },
    })
  })
  it('uses native WS control pings and releases the timer/listener on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { socket, client } = setup(undefined, true)
      await vi.advanceTimersByTimeAsync(25_000)
      expect(socket.ping).toHaveBeenCalledTimes(1)
      for (const listener of socket.listeners.get('pong') ?? []) listener()
      await vi.advanceTimersByTimeAsync(25_000)
      expect(socket.ping).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(100_000)
      expect(socket.terminate).toHaveBeenCalledTimes(1)
      expect(socket.listeners.get('pong')?.size).toBe(0)
      expect(client.subscriptions.size).toBe(0)
      await vi.advanceTimersByTimeAsync(100_000)
      expect(socket.ping).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('terminates a slow socket once, releases listeners and stops future sends', () => {
    const { client, socket, webui } = setup()
    socket.bufferedAmount = MAX_SOCKET_BUFFER
    expect(client.send({ type: 'test' })).toBe(false)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(webui.clients).toEqual({})
    expect(socket.listeners.get('message')?.size).toBe(0)
    client.send({ type: 'again' })
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })
})
