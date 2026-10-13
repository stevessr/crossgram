/**
 * Incremental SSE view of the existing WebUI entry-init / Muon-delta bus.
 * Read-only: mutations and RPC continue to use the authenticated WebSocket.
 */
import { randomBytes } from 'node:crypto'
import type { Request, Response } from '@cordisjs/plugin-server'

export interface SseEntry {
  snapshot(): unknown
}
interface EventRecord {
  id: number
  type: string
  entryId?: string
  frame: Uint8Array
}
interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>
  subscriptions: Set<string>
  heartbeat: ReturnType<typeof setInterval>
  pending: Uint8Array[]
  pendingBytes: number
  closed: boolean
  dispose: () => void
}
const encoder = new TextEncoder()
const HEARTBEAT = encoder.encode(': heartbeat\n\n')
const MAX_SUBSCRIPTIONS = 32
const MAX_REPLAY_EVENTS = 512
const MAX_REPLAY_BYTES = 4 * 1024 * 1024
// The bootstrap may replay the full ring plus one frame per subscription.
const MAX_PENDING_FRAMES = MAX_REPLAY_EVENTS + MAX_SUBSCRIPTIONS + 4
const MAX_PENDING_BYTES = 8 * 1024 * 1024

export function sseFrame(type: string, body: unknown, id?: string | number): Uint8Array {
  // JSON.stringify escapes newlines, so this remains a single SSE data line.
  return encoder.encode((id === undefined ? '' : 'id: ' + id + '\n') +
    'event: ' + type + '\n' + 'data: ' + JSON.stringify(body) + '\n\n')
}

export class SseHub {
  // The epoch prevents Last-Event-ID from a previous server process matching
  // coincidentally reused numeric event IDs after a restart.
  private readonly epoch = randomBytes(12).toString('hex')
  private sequence = 0
  private history: EventRecord[] = []
  private replayBytes = 0
  private replayFloor = 0
  private clients = new Set<Subscriber>()
  private closed = false

  constructor(
    readonly entries: Record<string, SseEntry>,
    readonly initialize: () => unknown,
  ) {}

  get activeClients(): number {
    return this.clients.size
  }

  get bufferedReplayBytes(): number {
    return this.replayBytes
  }

  publish(type: string, body: unknown) {
    if (this.closed) return
    const id = ++this.sequence
    // Serialize once for all subscribers and do not retain the mutable object.
    const frame = sseFrame(type, body, this.epoch + ':' + id)
    const entryId = (body as { id?: unknown } | null)?.id
    const record: EventRecord = {
      id, type, frame,
      entryId: typeof entryId === 'string' ? entryId : undefined,
    }
    if (frame.byteLength > MAX_REPLAY_BYTES) {
      this.history = []
      this.replayBytes = 0
      this.replayFloor = id
    } else {
      while (this.history.length >= MAX_REPLAY_EVENTS ||
          this.replayBytes + frame.byteLength > MAX_REPLAY_BYTES) {
        const removed = this.history.shift()!
        this.replayBytes -= removed.frame.byteLength
      }
      this.history.push(record)
      this.replayBytes += frame.byteLength
    }
    for (const client of this.clients)
      if (this.visibleTo(client, record)) this.enqueue(client, frame)
  }

  private visibleTo(client: Subscriber, event: EventRecord): boolean {
    if (event.type === 'entry:delta' || event.type === 'entry:snapshot' || event.type === 'entry:missing')
      return typeof event.entryId === 'string' && client.subscriptions.has(event.entryId)
    return true
  }

  accept(req: Request, res: Response) {
    if (this.closed) {
      res.status = 503
      res.json({ error: 'SSE service unavailable' })
      return
    }
    const entryIds = req.query.getAll('entry').flatMap(x => x.split(',')).filter(Boolean)
    if (entryIds.length > MAX_SUBSCRIPTIONS || entryIds.some(x => x.length > 128)) {
      res.status = 400
      res.json({ error: 'Invalid SSE entry subscriptions' })
      return
    }
    const subscriptions = new Set(entryIds)
    const cursor = req.headers.get('last-event-id') ?? req.query.get('lastEventId') ?? ''
    const match = /^([0-9a-f]{24}):(0|[1-9]\d{0,14})$/.exec(cursor)
    const lastId = match && match[1] === this.epoch ? Number(match[2]) : NaN
    const oldest = this.history[0]?.id ?? this.sequence + 1
    const resumable = Number.isSafeInteger(lastId) && lastId <= this.sequence &&
      lastId >= Math.max(this.replayFloor, oldest - 1)

    res.status = 200
    res.headers.set('content-type', 'text/event-stream; charset=utf-8')
    res.headers.set('cache-control', 'no-cache, no-transform')
    res.headers.set('x-accel-buffering', 'no')
    res.headers.set('x-content-type-options', 'nosniff')

    let subscriber: Subscriber | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const dispose = () => {
          const current = subscriber
          if (!current || current.closed) return
          current.closed = true
          clearInterval(current.heartbeat)
          current.pending = []
          current.pendingBytes = 0
          this.clients.delete(current)
          res._res.off('close', dispose)
          try { controller.close() } catch { /* already canceled */ }
        }
        subscriber = {
          controller, subscriptions, closed: false, dispose,
          pending: [], pendingBytes: 0,
          heartbeat: setInterval(() => {
            if (subscriber) this.enqueue(subscriber, HEARTBEAT)
          }, 15_000),
        }
        subscriber.heartbeat.unref?.()
        res._res.on('close', dispose)

        // A successfully resumed connection must retain existing client state.
        // Sending reset:true followed by deltas (without snapshots) corrupts it.
        const initial = this.initialize()
        const initBody = initial && typeof initial === 'object'
          ? { ...initial, reset: !resumable }
          : { reset: !resumable }
        this.enqueue(subscriber, sseFrame('entry:init', initBody))
        if (resumable) {
          for (const event of this.history) {
            if (event.id > lastId && this.visibleTo(subscriber, event))
              this.enqueue(subscriber, event.frame)
            if (subscriber.closed) break
          }
        } else {
          for (const id of subscriptions) {
            const entry = this.entries[id]
            this.enqueue(subscriber, entry
              ? sseFrame('entry:snapshot', entry.snapshot())
              : sseFrame('entry:missing', { id }))
            if (subscriber.closed) break
          }
        }
        if (!subscriber.closed) this.clients.add(subscriber)
      },
      pull: () => {
        if (subscriber) this.flush(subscriber)
      },
      cancel: () => {
        subscriber?.dispose()
      },
    }, { highWaterMark: 1 })
    res.body = stream
  }

  private enqueue(client: Subscriber, frame: Uint8Array) {
    if (client.closed) return
    if (client.pending.length >= MAX_PENDING_FRAMES ||
        client.pendingBytes + frame.byteLength > MAX_PENDING_BYTES) {
      client.dispose()
      return
    }
    client.pending.push(frame)
    client.pendingBytes += frame.byteLength
    this.flush(client)
  }

  private flush(client: Subscriber) {
    if (client.closed) return
    try {
      while (client.pending.length && (client.controller.desiredSize ?? 0) > 0) {
        const frame = client.pending.shift()!
        client.pendingBytes -= frame.byteLength
        client.controller.enqueue(frame)
      }
    } catch {
      client.dispose()
    }
  }

  dispose() {
    this.closed = true
    for (const client of [...this.clients]) client.dispose()
    this.history = []
    this.replayBytes = 0
  }
}
