import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { WebSocketBridge } from './ws-server.js'

describe('WebSocketBridge runtime compatibility', () => {
  it('does not require optional WebSocket pause/resume helpers', () => {
    const socket = Object.assign(new EventEmitter(), {
      send: () => {},
      close: () => {},
      terminate: () => {},
    }) as unknown as WebSocket
    const request = {
      socket: { remoteAddress: '127.0.0.1', remotePort: 12345 },
    } as IncomingMessage
    const bridge = new WebSocketBridge(socket, request)

    expect(() => (bridge as unknown as { _read(): void })._read()).not.toThrow()
    bridge.destroy()
  })

  it('continues receiving binary frames when pause is unavailable', async () => {
    const socket = Object.assign(new EventEmitter(), {
      send: () => {},
      close: () => {},
      terminate: () => {},
    }) as unknown as WebSocket
    const request = {
      socket: { remoteAddress: '127.0.0.1', remotePort: 12345 },
    } as IncomingMessage
    const bridge = new WebSocketBridge(socket, request)
    const received = new Promise<Buffer>((resolve) => {
      bridge.once('data', (chunk: Buffer) => resolve(chunk))
    })

    socket.emit('message', Buffer.from([1, 2, 3]), true)

    await expect(received).resolves.toEqual(Buffer.from([1, 2, 3]))
    bridge.destroy()
  })

  it('does not throw when backpressure requires a missing pause helper', () => {
    const socket = Object.assign(new EventEmitter(), {
      send: () => {},
      close: () => {},
      terminate: () => {},
    }) as unknown as WebSocket
    const request = {
      socket: { remoteAddress: '127.0.0.1', remotePort: 12345 },
    } as IncomingMessage
    const bridge = new WebSocketBridge(socket, request)
    vi.spyOn(bridge, 'push').mockReturnValue(false)

    expect(() => socket.emit('message', Buffer.from([1]), true)).not.toThrow()
    bridge.destroy()
  })
})
