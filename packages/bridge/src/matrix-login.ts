import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** Minimal structural types so this module works against the server plugin's Request/Response. */
export interface ServerRequest {
  _req: IncomingMessage
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array> | null
}

export interface ServerResponse {
  status: number
  headers: Headers
  json(data: unknown): unknown
}

/** The plugin-server concrete classes (kept structural for tests). */
export type ConcreteRequest = ServerRequest & { _res: IncomingMessage }

/** Best-effort client address for rate bucketing; proxy headers first. */
export function clientAddress(req: ServerRequest): string {
  return (req.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim()
    || req._req.socket.remoteAddress
    || 'unknown'
}

/**
 * A deliberately thin Matrix login proxy for the WebUI.
 *
 * The browser cannot talk to the homeserver directly: browsers enforce CORS on
 * `/_matrix/client/v3/login`, so the SSO and password flows have to run through
 * the relay. This module forwards exactly one login request at a time, never
 * logs credentials, and never stores the returned access token server-side —
 * the browser writes it into the platform plugin configuration through the
 * existing loader management boundary.
 */

export interface MatrixLoginRequest {
  homeserver?: unknown
  userId?: unknown
  password?: unknown
  loginToken?: unknown
}

export interface MatrixLoginResult {
  accessToken: string
  userId: string
  deviceId: string
  /** Milliseconds until the token expires, for soft-logout servers. */
  expiresAfterMs?: number
}

const MAX_BODY_BYTES = 8 * 1024
const MAX_HOMESERVER_LENGTH = 2_048
const MAX_USER_ID_LENGTH = 255
const MAX_PASSWORD_LENGTH = 1_024
const MAX_LOGIN_TOKEN_LENGTH = 4_096
const REQUEST_TIMEOUT_MS = 30_000
const RATE_WINDOW_MS = 10 * 60_000
const RATE_WINDOW_LIMIT = 12
/** Sliding-window buckets keyed by a hashed client address. */
const rateBuckets = new Map<number, number[]>()

/** Test hook: clear all rate buckets (production rate state is per-process). */
export function resetRateLimits(): void {
  rateBuckets.clear()
}

const MATRIX_USER_ID = /^@[^:\s]+:[^:\s]+$/

/** Bad credentials must not be distinguishable from unknown users. */
export class MatrixLoginError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MatrixLoginError'
  }
}

function rateKey(req: ServerRequest): number {
  const address = clientAddress(req)
  // Hash so raw client addresses never persist in a module-level map.
  return createHmac('sha256', 'crossgram-matrix-login-rate').update(address).digest().readUInt32BE(0)
}

function rateLimited(req: ServerRequest, now = Date.now()): number | undefined {
  const key = rateKey(req)
  const windowStart = now - RATE_WINDOW_MS
  const hits = (rateBuckets.get(key) ?? []).filter(time => time > windowStart)
  if (hits.length >= RATE_WINDOW_LIMIT) return Math.ceil((hits[0]! + RATE_WINDOW_MS - now) / 1_000)
  hits.push(now)
  rateBuckets.set(key, hits)
  if (rateBuckets.size > 1_024) {
    for (const [bucket, times] of rateBuckets) {
      if (!times.some(time => time > windowStart)) rateBuckets.delete(bucket)
    }
  }
  return undefined
}

/** Accept only http(s) origins without embedded credentials. */
export function normalizeHomeserver(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new MatrixLoginError(400, 'INVALID_HOMESERVER', 'Homeserver 必须是有效的 URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new MatrixLoginError(400, 'INVALID_HOMESERVER', 'Homeserver 必须使用 http(s)://')
  }
  if (url.username || url.password || url.hash) {
    throw new MatrixLoginError(400, 'INVALID_HOMESERVER', 'Homeserver 地址不能包含用户信息或锚点')
  }
  return url.origin
}

function requireText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new MatrixLoginError(400, 'INVALID_REQUEST', '请求字段类型不正确')
  const text = value.trim()
  if (!text) return undefined
  if (text.length > max) throw new MatrixLoginError(400, 'INVALID_REQUEST', '请求字段过长')
  return text
}

export async function readMatrixLoginRequest(req: ServerRequest): Promise<MatrixLoginRequest> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new MatrixLoginError(413, 'REQUEST_TOO_LARGE', '请求过大')
  }
  const reader = req.body?.getReader()
  if (!reader) throw new MatrixLoginError(400, 'INVALID_REQUEST', '请求缺少内容')
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new MatrixLoginError(413, 'REQUEST_TOO_LARGE', '请求过大')
    }
    chunks.push(Buffer.from(value))
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MatrixLoginRequest
    if (!body || typeof body !== 'object') throw new Error('not an object')
    return body
  } catch {
    throw new MatrixLoginError(400, 'INVALID_REQUEST', '请求必须是 JSON 对象')
  }
}

/**
 * Exchange password or SSO login credentials for an access token. The
 * homeserver response is passed through unmodified apart from the picked
 * fields, so errcodes such as M_FORBIDDEN surface verbatim to the UI.
 */
export async function matrixLogin(
  request: MatrixLoginRequest,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<MatrixLoginResult> {
  const homeserver = normalizeHomeserver(requireText(request.homeserver, MAX_HOMESERVER_LENGTH) ?? '')
  const userId = requireText(request.userId, MAX_USER_ID_LENGTH)
  const password = requireText(request.password, MAX_PASSWORD_LENGTH)
  const loginToken = requireText(request.loginToken, MAX_LOGIN_TOKEN_LENGTH)

  let body: Record<string, unknown>
  if (loginToken) {
    if (password || userId) {
      throw new MatrixLoginError(400, 'INVALID_REQUEST', 'SSO 登录只需要一次性令牌')
    }
    body = {
      type: 'm.login.token',
      token: loginToken,
      initial_device_display_name: 'CrossGram relay',
    }
  } else {
    if (!userId || !password) {
      throw new MatrixLoginError(400, 'INVALID_REQUEST', '账号密码登录需要用户名与密码')
    }
    if (!MATRIX_USER_ID.test(userId)) {
      throw new MatrixLoginError(400, 'INVALID_USER_ID', 'Matrix 用户名形如 @user:example.org')
    }
    body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: 'CrossGram relay',
    }
  }

  let response: Response
  try {
    response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') {
      throw new MatrixLoginError(504, 'HOMESERVER_TIMEOUT', 'Homeserver 响应超时')
    }
    throw new MatrixLoginError(502, 'HOMESERVER_UNREACHABLE', '无法连接 Homeserver')
  }
  const payload = await response.json().catch(() => ({})) as {
    user_id?: unknown, access_token?: unknown, device_id?: unknown,
    expires_in_ms?: unknown, errcode?: unknown, error?: unknown,
  }
  if (!response.ok) {
    // Pass the homeserver's own message through: it is the actionable one.
    const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
    const status = response.status === 403 ? 401 : response.status === 429 ? 429 : 502
    throw new MatrixLoginError(status, typeof payload.errcode === 'string' ? payload.errcode : 'LOGIN_FAILED', detail)
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token
    || typeof payload.user_id !== 'string' || !payload.user_id
    || typeof payload.device_id !== 'string' || !payload.device_id) {
    throw new MatrixLoginError(502, 'LOGIN_FAILED', 'Homeserver 返回的登录结果不完整')
  }
  return {
    accessToken: payload.access_token,
    userId: payload.user_id,
    deviceId: payload.device_id,
    expiresAfterMs: typeof payload.expires_in_ms === 'number' && payload.expires_in_ms > 0
      ? payload.expires_in_ms
      : undefined,
  }
}

/** Constant-time state comparison for the SSO callback correlation. */
export function sameState(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function newSsoState(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Attach `POST ${prefix}/matrix/login` to the bridge server. Returns 429 with
 * `retryAfter` while a client exceeds the sliding rate window.
 */
export function registerMatrixLoginRoute(
  ctx: { server: { post(path: string, handler: (req: ServerRequest, res: ServerResponse) => Promise<void>): unknown } },
  prefix: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): unknown {
  return ctx.server.post(`${prefix}/matrix/login`, async (req, res) => {
    const retryAfter = rateLimited(req)
    if (retryAfter !== undefined) {
      res.status = 429
      res.headers.set('retry-after', String(retryAfter))
      res.json({ error: 'TOO_MANY_ATTEMPTS', retryAfter })
      return
    }
    try {
      const request = await readMatrixLoginRequest(req)
      res.json(await matrixLogin(request, fetch))
    } catch (error) {
      if (!(error instanceof MatrixLoginError)) throw error
      res.status = error.status
      res.json({ error: error.code, message: error.message })
    }
  })
}
