/**
 * Incremental SSE view of the existing WebUI entry-init / Muon-delta bus.
 * This is a read-only alternative to WebSocket and never dispatches RPC.
 */
import type { Request, Response } from '@cordisjs/plugin-server'

export interface SseEntry {
  snapshot(): unknown
}
interface EventRecord {
  id: number
  type: string
  body: unknown
}
interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>
  subscriptions: Set<string>
  heartbeat: ReturnType<typeof setInterval>
  closed: boolean
  dispose: () => void
}
const encoder = new TextEncoder()
const MAX_SUBSCRIPTIONS = 32
const MAX_REPLAY_EVENTS = 512
const MAX_PENDING_EVENTS = 16

export function sseFrame(type: string, body: unknown, id?: number): Uint8Array {
  // JSON.stringify encodes newlines inside payloads, so one SSE data line is safe.
  return encoder.encode((id === undefined ? '' : 'id: ' + id + '\n') +
    'event: ' + type + '\n' + 'data: ' + JSON.stringify(body) + '\n\n')
}

export class SseHub {
  private sequence = 0
  private history: EventRecord[] = []
  private clients = new Set<Subscriber>()
  private closed = false

  constructor(
    readonly entries: Record<string, SseEntry>,
    readonly initialize: () => unknown,
  ) {}

  get activeClients(): number {
    return this.clients.size
  }

  publish(type: string, body: unknown) {
    if (this.closed) return
    const record: EventRecord = { id: ++this.sequence, type, body }
    this.history.push(record)
    if (this.history.length > MAX_REPLAY_EVENTS) this.history.shift()
    for (const client of this.clients) {
      if (this.visibleTo(client, record)) this.send(client, sseFrame(type, body, record.id))
    }
  }

  private visibleTo(client: Subscriber, event: EventRecord): boolean {
    if (event.type === 'entry:delta' || event.type === 'entry:snapshot' || event.type === 'entry:missing') {
      const id = (event.body as { id?: unknown } | null)?.id
      return typeof id === 'string' && client.subscriptions.has(id)
    }
    return true
  }

  accept(req: Request, res: Response) {
    const entryIds = req.query.getAll('entry').flatMap(x => x.split(',')).filter(Boolean)
    if (entryIds.length > MAX_SUBSCRIPTIONS || entryIds.some(x => x.length > 128)) {
      res.status = 400
      res.json({ error: 'Invalid SSE entry subscriptions' })
      return
    }
    const subscriptions = new Set(entryIds)
    const cursor = req.headers.get('last-event-id') ?? req.query.get('lastEventId')
    const lastId = cursor && /^(0|[1-9]\d{0,15})$/.test(cursor) ? Number(cursor) : NaN
    const oldest = this.history[0]?.id ?? this.sequence + 1
    const resumable = Number.isSafeInteger(lastId) && lastId <= this.sequence && lastId >= oldest - 1

    res.status = 200
    res.headers.set('content-type', 'text/event-stream; charset=utf-8')
    res.headers.set('cache-control', 'no-cache, no-transform')
    res.headers.set('x-accel-buffering', 'no')
    res.headers.set('x-content-type-options', 'nosniff')

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let subscriber: Subscriber
        const dispose = () => {
          if (subscriber.closed) return
          subscriber.closed = true
          clearInterval(subscriber.heartbeat)
          this.clients.delete(subscriber)
          res._res.off('close', dispose)
          try { controller.close() } catch { /* already canceled */ }
        }
        subscriber = {
          controller, subscriptions, closed: false, dispose,
          heartbeat: setInterval(() => {
            this.send(subscriber, encoder.encode(': heartbeat\n\n'))
          }, 15_000),
        }
        subscriber.heartbeat.unref?.()
        res._res.on('close', dispose)
        // An init frame has no replay cursor: only published updates advance it.
        this.send(subscriber, sseFrame('entry:init', this.initialize()))
        if (resumable) {
          for (const event of this.history) {
            if (event.id > lastId && this.visibleTo(subscriber, event))
              this.send(subscriber, sseFrame(event.type, event.body, event.id))
          }
        } else {
          for (const id of subscriptions) {
            const entry = this.entries[id]
            this.send(subscriber, entry
              ? sseFrame('entry:snapshot', entry.snapshot())
              : sseFrame('entry:missing', { id }))
          }
        }
        if (!subscriber.closed) this.clients.add(subscriber)
      },
      cancel: () => {
        // Called by the underlying HTTP stream when the client disconnects.
        for (const subscriber of this.clients) {
          if (subscriber.controller === controllerRef) subscriber.dispose()
        }
      },
    }, { highWaterMark: MAX_PENDING_EVENTS })
    // Keep a reference so stream cancellation can find the matching subscriber.
    const controllerRef = undefined as unknown as ReadableStreamDefaultController<Uint8Array>
    res.body = stream
  }

  private send(client: Subscriber, frame: Uint8Array) {
    if (client.closed) return
    // A slow SSE reader must not accumulate unbounded state snapshots/deltas.
    if ((client.controller.desiredSize ?? 0) <= 0) {
      client.dispose()
      return
    }
    try { client.controller.enqueue(frame) }
    catch { client.dispose() }
  }

  dispose() {
    this.closed = true
    for (const client of [...this.clients]) client.dispose()
    this.history = []
  }
}
