import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch, ProxyAgent as UndiciProxyAgent } from 'undici'
import type {
  MatrixDirectAccountData, MatrixEvent, MatrixEventContextResponse, MatrixJoinedRoomsResponse, MatrixMembersResponse,
  MatrixMessagesResponse, MatrixRelationsResponse, MatrixProfile, MatrixRoomEventFilter, MatrixSearchResponse, MatrixSyncResponse, MatrixWhoAmI,
} from './types.js'

export interface MatrixClientOptions {
  homeserver: string
  accessToken: string
  proxy?: string
  requestTimeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export class MatrixHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'MatrixHttpError'
  }
}

export class MatrixClient {
  readonly homeserver: string
  private readonly accessToken: string
  private readonly requestTimeoutMs: number
  private readonly fetch: typeof globalThis.fetch
  private readonly proxyDispatcher?: UndiciProxyAgent

  constructor(options: MatrixClientOptions) {
    this.homeserver = options.homeserver.replace(/\/+$/, '')
    this.accessToken = options.accessToken
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    const proxy = normalizeHttpProxy(options.proxy)
    if (options.fetch) {
      this.fetch = options.fetch
    } else if (proxy) {
      this.proxyDispatcher = new UndiciProxyAgent(proxy)
      this.fetch = ((input, init) => undiciFetch(input as string | URL, {
        ...(init as import('undici').RequestInit),
        dispatcher: this.proxyDispatcher,
      }) as unknown as Promise<Response>) as typeof globalThis.fetch
    } else {
      this.fetch = globalThis.fetch
    }
  }

  async close(): Promise<void> {
    await this.proxyDispatcher?.close()
  }

  whoAmI(): Promise<MatrixWhoAmI> {
    return this.request('/_matrix/client/v3/account/whoami')
  }

  getProfile(userId: string): Promise<MatrixProfile> {
    return this.request(`/_matrix/client/v3/profile/${segment(userId)}`)
  }

  getJoinedRooms(): Promise<MatrixJoinedRoomsResponse> {
    return this.request('/_matrix/client/v3/joined_rooms')
  }

  getDirectRooms(userId: string): Promise<MatrixDirectAccountData> {
    return this.request(`/_matrix/client/v3/user/${segment(userId)}/account_data/m.direct`)
  }

  getRoomState(roomId: string): Promise<MatrixEvent[]> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/state`)
  }

  getMembers(roomId: string): Promise<MatrixMembersResponse> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/members`, {
      query: { membership: 'join' },
    })
  }

  getMessages(
    roomId: string,
    options: { from?: string, dir?: 'b' | 'f', limit?: number, filter?: MatrixRoomEventFilter } = {},
  ): Promise<MatrixMessagesResponse> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/messages`, {
      query: {
        from: options.from,
        dir: options.dir ?? 'b',
        limit: options.limit ?? 20,
        filter: options.filter ? JSON.stringify(options.filter) : undefined,
      },
    })
  }

  /** Search text indexed by the homeserver. Media type and time are filtered by the adapter. */
  searchRoomEvents(options: {
    searchTerm: string
    roomId: string
    fromUserId?: string
    limit: number
    nextBatch?: string
  }): Promise<MatrixSearchResponse> {
    return this.request('/_matrix/client/v3/search', {
      method: 'POST',
      query: { next_batch: options.nextBatch },
      body: {
        search_categories: {
          room_events: {
            search_term: options.searchTerm,
            keys: ['content.body'],
            order_by: 'recent',
            filter: {
              rooms: [options.roomId],
              types: ['m.room.message'],
              limit: options.limit,
              ...(options.fromUserId ? { senders: [options.fromUserId] } : {}),
            },
          },
        },
      },
    })
  }

  getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/event/${segment(eventId)}`)
  }

  /** Matrix /relations may be paginated: callers must follow next_batch before allowing a vote. */
  getRelations(roomId: string, eventId: string, options: { from?: string, limit?: number } = {}): Promise<MatrixRelationsResponse> {
    return this.request(`/_matrix/client/v1/rooms/${segment(roomId)}/relations/${segment(eventId)}/m.reference`, {
      query: { from: options.from, limit: options.limit ?? 100 },
    })
  }

  getEventContext(roomId: string, eventId: string): Promise<MatrixEventContextResponse> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/context/${segment(eventId)}`, {
      query: { limit: 0 },
    })
  }

  sync(options: {
    since?: string
    timeout?: number
    fullState?: boolean
    signal?: AbortSignal
  } = {}): Promise<MatrixSyncResponse> {
    return this.request('/_matrix/client/v3/sync', {
      query: {
        since: options.since,
        timeout: options.timeout ?? 0,
        full_state: options.fullState,
      },
      signal: options.signal,
      timeoutMs: (options.timeout ?? 0) + this.requestTimeoutMs,
    })
  }

  /** Accept an invitation to a room using its opaque Matrix room ID. */
  joinRoom(roomId: string): Promise<{ room_id: string }> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/join`, { method: 'POST', body: {} })
  }

  /** Decline an invitation (or leave an already joined room). */
  leaveRoom(roomId: string): Promise<void> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/leave`, { method: 'POST', body: {} })
  }

  async sendEvent(roomId: string, eventType: string, content: unknown, transactionId = randomUUID()): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${segment(roomId)}/send/${segment(eventType)}/${segment(transactionId)}`,
      { method: 'PUT', body: content },
    )
    return response.event_id
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${segment(roomId)}/redact/${segment(eventId)}/${segment(randomUUID())}`,
      { method: 'PUT', body: reason ? { reason } : {} },
    )
    return response.event_id
  }

  async upload(
    source: AsyncIterable<Uint8Array>,
    options: {
      filename?: string
      contentType?: string
      signal?: AbortSignal
      onChunk?: (size: number) => void | Promise<void>
    } = {},
  ): Promise<string> {
    const iterator = source[Symbol.asyncIterator]()
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (options.signal?.aborted) {
          controller.error(options.signal.reason ?? new Error('Matrix upload aborted'))
          return
        }
        try {
          const result = await iterator.next()
          if (result.done) {
            controller.close()
            return
          }
          const chunk = result.value.slice()
          await options.onChunk?.(chunk.length)
          controller.enqueue(chunk)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel: async () => { await iterator.return?.() },
    })
    const response = await this.request<{ content_uri: string }>('/_matrix/media/v3/upload', {
      method: 'POST',
      query: { filename: options.filename },
      headers: options.contentType ? { 'content-type': options.contentType } : undefined,
      binaryBody: body,
      signal: options.signal,
    })
    return response.content_uri
  }

  async download(mxc: string, options: { signal?: AbortSignal, timeoutMs?: number } = {}): Promise<Response> {
    const { serverName, mediaId } = parseMxc(mxc)
    return this.rawRequest(`/_matrix/media/v3/download/${segment(serverName)}/${segment(mediaId)}`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  }

  markRead(roomId: string, eventId: string): Promise<unknown> {
    return this.request(`/_matrix/client/v3/rooms/${segment(roomId)}/read_markers`, {
      method: 'POST',
      body: { 'm.fully_read': eventId, 'm.read': eventId },
    })
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.rawRequest(path, options)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private async rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(path, `${this.homeserver}/`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const headers = new Headers(options.headers)
    headers.set('authorization', `Bearer ${this.accessToken}`)
    let body: BodyInit | undefined
    if (options.binaryBody !== undefined) {
      body = options.binaryBody
    } else if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.body)
    }
    const init: RequestInit & { duplex?: 'half' } = { method: options.method ?? 'GET', headers, body, signal }
    if (body instanceof ReadableStream) init.duplex = 'half'
    const response = await this.fetch(url, init)
    if (response.ok) return response
    const error = await response.json().catch(() => ({})) as { errcode?: string, error?: string }
    throw new MatrixHttpError(
      response.status,
      error.errcode,
      error.error ?? `Matrix request failed with HTTP ${response.status}`,
    )
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  query?: Record<string, string | number | boolean | undefined>
  headers?: HeadersInit
  body?: unknown
  binaryBody?: BodyInit
  signal?: AbortSignal
  timeoutMs?: number
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

function normalizeHttpProxy(input?: string): string | undefined {
  if (!input?.trim()) return undefined
  const url = new URL(input.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Matrix proxy must use http:// or https://: ${url.protocol}`)
  }
  return url.toString()
}

export function parseMxc(value: string): { serverName: string, mediaId: string } {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(value)
  if (!match) throw new Error(`invalid Matrix content URI: ${value}`)
  return { serverName: match[1]!, mediaId: match[2]! }
}
