import { EventEmitter } from 'node:events'
import type { Request, Response } from '@cordisjs/plugin-server'
import { describe, expect, it } from 'vitest'
import { SseHub } from './sse.js'

function subscribe(hub: SseHub, cursor?: string, entries = 'alpha') {
  const res = {
    _res: new EventEmitter(),
    headers: new Headers(),
    status: 200,
    body: null as ReadableStream<Uint8Array> | null,
    json(_value: unknown) { /* not needed by valid subscription paths */ },
  } as unknown as Response
  const req = {
    query: new URLSearchParams(entries.split(',').map(entry => ['entry', entry])),
    headers: new Headers(cursor === undefined ? {} : { 'last-event-id': cursor }),
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
    const stale = subscribe(hub, '1')
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
    const reader = subscribe(hub, '1')
    try {
      expect(await text(reader)).toContain('entry:init')
      expect(await text(reader)).toContain('event: entry:snapshot')
    } finally {
      await reader.cancel()
      hub.dispose()
    }
  })
  it('replays more than 16 events without resetting client state or dropping a fast reader', async () => {
    const hub = new SseHub({ alpha: { snapshot: () => ({ id: 'alpha', data: {} }) } }, () => ({ reset: true }))
    const first = subscribe(hub)
    try {
      await text(first)
      await text(first)
      hub.publish('entry:delta', { id: 'alpha', value: 0 })
      const frame = await text(first)
      const cursor = /^id: ([^\n]+)/m.exec(frame)?.[1]
      expect(cursor).toMatch(/^[a-f0-9]{24}:1$/)
      await first.cancel()
      for (let n = 1; n <= 40; n++) hub.publish('entry:delta', { id: 'alpha', value: n })
      const resumed = subscribe(hub, cursor)
      try {
        expect(JSON.parse(/^data: (.+)$/m.exec(await text(resumed))![1]).reset).toBe(false)
        for (let n = 1; n <= 40; n++) {
          const chunk = await text(resumed)
          expect(chunk).toContain('event: entry:delta')
          expect(chunk).toContain('"value":' + n)
        }
        expect(hub.activeClients).toBe(1)
      } finally {
        await resumed.cancel()
      }
    } finally {
      hub.dispose()
    }
  })
  it('uses snapshots when a Last-Event-ID belongs to an earlier process', async () => {
    const older = new SseHub({ alpha: { snapshot: () => ({ id: 'alpha', data: {} }) } }, () => ({}))
    const reader = subscribe(older)
    await text(reader)
    await text(reader)
    older.publish('entry:delta', { id: 'alpha', value: 1 })
    const cursor = /^id: ([^\n]+)/m.exec(await text(reader))?.[1]
    await reader.cancel()
    older.dispose()
    const current = new SseHub({ alpha: { snapshot: () => ({ id: 'alpha', data: { current: true } }) } }, () => ({}))
    current.publish('entry:delta', { id: 'alpha', value: 'new' })
    const resumed = subscribe(current, cursor)
    try {
      expect(JSON.parse(/^data: (.+)$/m.exec(await text(resumed))![1]).reset).toBe(true)
      expect(await text(resumed)).toContain('entry:snapshot')
    } finally {
      await resumed.cancel()
      current.dispose()
    }
  })
  it('supports all 32 bootstrap subscriptions without closing the stream', async () => {
    const ids = Array.from({ length: 32 }, (_, i) => 'entry' + i)
    const entries = Object.fromEntries(ids.map(id => [id, { snapshot: () => ({ id, data: {} }) }]))
    const hub = new SseHub(entries, () => ({}))
    const reader = subscribe(hub, undefined, ids.join(','))
    try {
      expect(await text(reader)).toContain('entry:init')
      for (const id of ids) expect(await text(reader)).toContain('"id":"' + id + '"')
      expect(hub.activeClients).toBe(1)
    } finally {
      await reader.cancel()
      hub.dispose()
    }
  })
  it('disconnects a persistently slow reader instead of retaining unbounded events', async () => {
    const hub = new SseHub({ alpha: { snapshot: () => ({ id: 'alpha', data: {} }) } }, () => ({}))
    const reader = subscribe(hub)
    for (let n = 0; n < 600; n++) hub.publish('entry:delta', { id: 'alpha', n })
    expect(hub.activeClients).toBe(0)
    await reader.cancel().catch(() => {})
    hub.dispose()
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
      expect(first).toMatch(/id: [0-9a-f]{24}:1/)
      expect(second).toMatch(/id: [0-9a-f]{24}:1/)
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
