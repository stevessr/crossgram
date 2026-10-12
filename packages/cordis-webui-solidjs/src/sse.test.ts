import { EventEmitter } from 'node:events'
import type { Request, Response } from '@cordisjs/plugin-server'
import { describe, expect, it } from 'vitest'
import { SseHub } from './sse.js'

function subscribe(hub: SseHub, cursor?: number) {
  const res = {
    _res: new EventEmitter(),
    headers: new Headers(),
    status: 200,
    body: null as ReadableStream<Uint8Array> | null,
    json(_value: unknown) { /* not needed by valid subscription paths */ },
  } as unknown as Response
  const req = {
    query: new URLSearchParams('entry=alpha'),
    headers: new Headers(cursor === undefined ? {} : { 'last-event-id': String(cursor) }),
  } as Request
  hub.accept(req, res)
  return (res.body as ReadableStream<Uint8Array>).getReader()
}
const text = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  new TextDecoder().decode((await reader.read()).value)

describe('bounded SSE replay', () => {
  it('enforces a 4 MiB replay memory ceiling and snapshots stale cursors', async () => {
    const hub = new SseHub({
      alpha: { snapshot: () => ({ id: 'alpha', data: { latest: true } }) },
    }, () => ({ reset: true }))
    for (let i = 0; i < 8; i++) hub.publish('entry:delta', { id: 'alpha', payload: 'x'.repeat(750_000), i })
    expect(hub.bufferedReplayBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    const stale = subscribe(hub, 1)
    try {
      expect(await text(stale)).toContain('event: entry:init')
      expect(await text(stale)).toContain('event: entry:snapshot')
    } finally {
      await stale.cancel()
      hub.dispose()
    }
  })
  it('invalidates older replay cursors after an oversized event', async () => {
    const hub = new SseHub({
      alpha: { snapshot: () => ({ id: 'alpha', data: { recovered: true } }) },
    }, () => ({}))
    hub.publish('entry:delta', { id: 'alpha', value: 1 })
    hub.publish('entry:delta', { id: 'alpha', tooLarge: 'x'.repeat(4 * 1024 * 1024) })
    expect(hub.bufferedReplayBytes).toBe(0)
    hub.publish('entry:delta', { id: 'alpha', value: 3 })
    const reader = subscribe(hub, 1)
    try {
      expect(await text(reader)).toContain('entry:init')
      expect(await text(reader)).toContain('event: entry:snapshot')
    } finally {
      await reader.cancel()
      hub.dispose()
    }
  })
  it('retains ordered event IDs and encodes one broadcast for multiple readers', async () => {
    const hub = new SseHub({ alpha: { snapshot: () => ({ id: 'alpha', data: {} }) } }, () => ({}))
    const a = subscribe(hub)
    const b = subscribe(hub)
    try {
      expect(await text(a)).toContain('entry:init')
      expect(await text(b)).toContain('entry:init')
      // Each fresh subscription receives its own initial snapshot.
      await text(a)
      await text(b)
      let encoded = 0
      hub.publish('entry:delta', {
        id: 'alpha',
        toJSON() {
          encoded++
          return { id: 'alpha', value: 42 }
        },
      })
      const first = await text(a)
      const second = await text(b)
      expect(first).toContain('id: 1')
      expect(second).toContain('id: 1')
      expect(encoded).toBe(1)
      expect(hub.activeClients).toBe(2)
    } finally {
      await a.cancel()
      await b.cancel()
      expect(hub.activeClients).toBe(0)
      hub.dispose()
    }
  })
})
