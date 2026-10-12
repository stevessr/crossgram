/**
 * HTTP Content-Encoding for the Cordis server used by CrossGram's WebUI/API.
 *
 * This is deliberately independent of WebSocket's protobuf-gzip framing.
 * Only fully materialized responses are compressed; streaming responses such
 * as SSE and media keep their original incremental delivery semantics.
 */
import type { Request, Response } from '@cordisjs/plugin-server'
import { gunzipSync, gzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import * as zlib from 'node:zlib'

export type Encoding = 'gzip' | 'br' | 'zstd'
export interface HttpEncodingOptions {
  minBytes?: number
  maxResponseBytes?: number
  maxEncodedRequestBytes?: number
  maxDecodedRequestBytes?: number
  enabled?: boolean
}

const order: readonly Encoding[] = ['zstd', 'br', 'gzip']
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|[^;\s+]+\+json|javascript|xml|[^;\s+]+\+xml|x-www-form-urlencoded|graphql-response\+json)|image\/svg\+xml)(?:;|$)/i
const REQUEST_BODY = /^(?:application\/(?:json|[^;\s+]+\+json|x-www-form-urlencoded)|text\/)/i
const zstd = zlib as typeof zlib & {
  zstdCompressSync?: (buffer: Uint8Array, options?: object) => Buffer
  zstdDecompressSync?: (buffer: Uint8Array, options?: object) => Buffer
}
function isAvailable(encoding: Encoding): boolean {
  return encoding !== 'zstd' || Boolean(zstd.zstdCompressSync && zstd.zstdDecompressSync)
}

export function selectEncoding(header: string | null, available: readonly Encoding[] = order): Encoding | null {
  if (!header) return null
  const preferences = new Map<string, number>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    let quality = 1
    for (const param of params) {
      const match = /^q\s*=\s*(\d+(?:\.\d+)?)$/.exec(param.trim())
      if (match) quality = Number(match[1])
      else if (param.trim().startsWith('q=')) quality = 0
    }
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) quality = 0
    preferences.set(name, quality)
  }
  let best: Encoding | null = null, bestQuality = 0
  for (const encoding of available) {
    if (!isAvailable(encoding)) continue
    const quality = preferences.get(encoding) ?? preferences.get('*') ?? 0
    if (quality > bestQuality) {
      best = encoding
      bestQuality = quality
    }
  }
  return best
}

function compress(data: Buffer, encoding: Encoding): Buffer {
  switch (encoding) {
    case 'gzip': return gzipSync(data, { level: 1 })
    case 'br': return brotliCompressSync(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    })
    case 'zstd': return zstd.zstdCompressSync!(data)
  }
}

function decompress(data: Buffer, encoding: Encoding, maxBytes: number): Buffer {
  const options = { maxOutputLength: maxBytes + 1 }
  switch (encoding) {
    case 'gzip': return gunzipSync(data, options)
    case 'br': return brotliDecompressSync(data, options)
    case 'zstd': return zstd.zstdDecompressSync!(data, options)
  }
}

function rawBuffer(res: Response): Buffer | null {
  // Cordis 1.7 stores an unmaterialized BodyInit until the request is ended.
  // Never call res.body for a stream: doing so tees it and can buffer forever.
  const raw: unknown = (res as unknown as { _bodyInit?: unknown })._bodyInit
  if (typeof raw === 'string') return Buffer.from(raw)
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  return null
}

function varyEncoding(headers: Headers) {
  const vary = headers.get('vary')
  if (!vary) headers.set('vary', 'Accept-Encoding')
  else if (vary !== '*' && !vary.toLowerCase().split(',').some(x => x.trim() === 'accept-encoding'))
    headers.set('vary', vary + ', Accept-Encoding')
}

async function boundedRead(req: Request, maxBytes: number): Promise<Buffer> {
  const reader = req.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const parts: Buffer[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new RangeError('Encoded HTTP request exceeds limit')
      parts.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(parts, length)
}

export async function applyRequestDecoding(req: Request, res: Response, options: HttpEncodingOptions = {}): Promise<boolean> {
  const original = req.headers.get('content-encoding')?.trim().toLowerCase()
  if (!original || original === 'identity') return true
  if (!order.includes(original as Encoding) || !isAvailable(original as Encoding)) {
    res.status = 415
    res.json({ error: 'Unsupported Content-Encoding' })
    return false
  }
  if (!REQUEST_BODY.test(req.headers.get('content-type') ?? '')) {
    res.status = 415
    res.json({ error: 'Compressed request content type not supported' })
    return false
  }
  const maxEncoded = options.maxEncodedRequestBytes ?? 4 * 1024 * 1024
  const maxDecoded = options.maxDecodedRequestBytes ?? 8 * 1024 * 1024
  const length = Number(req.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxEncoded) {
    res.status = 413
    res.json({ error: 'Encoded HTTP request exceeds limit' })
    return false
  }
  try {
    const encoded = await boundedRead(req, maxEncoded)
    const decoded = decompress(encoded, original as Encoding, maxDecoded)
    if (decoded.byteLength > maxDecoded) throw new RangeError('Decoded request exceeds limit')
    const headers = new Headers(req.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    // Cordis Request's public body getter is backed by _bodyImpl. Reset it
    // before route handlers parse JSON/form data, retaining all other headers.
    req.headers.delete('content-encoding')
    req.headers.delete('content-length')
    ;(req as unknown as { _bodyImpl: globalThis.Response })._bodyImpl = new globalThis.Response(decoded, { headers })
    return true
  } catch (error) {
    res.status = error instanceof RangeError || (error as Error).code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400
    res.json({ error: res.status === 413 ? 'Compressed HTTP request exceeds limit' : 'Invalid compressed HTTP request' })
    return false
  }
}

export function applyResponseEncoding(req: Request, res: Response, options: HttpEncodingOptions = {}): void {
  if (options.enabled === false) return
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return
  if (res.status < 200 || res.status === 204 || res.status === 206 || res.status === 304) return
  if (res.headers.has('content-encoding') || res.headers.has('content-range')) return
  if (req.headers.has('range') || /\bno-transform\b/i.test(res.headers.get('cache-control') ?? '')) return
  if (!COMPRESSIBLE.test(res.headers.get('content-type') ?? '')) return
  const data = rawBuffer(res)
  if (!data) return
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024
  if (data.length > maxBytes) return
  varyEncoding(res.headers)
  if (data.length < (options.minBytes ?? 1024)) return
  const encoding = selectEncoding(req.headers.get('accept-encoding'))
  if (!encoding) return
  const result = compress(data, encoding)
  if (result.byteLength >= data.byteLength) return
  res.body = result
  res.headers.set('content-encoding', encoding)
  res.headers.delete('content-length')
  res.headers.delete('content-md5')
  // A strong ETag calculated for the uncompressed representation is invalid
  // for the compressed one. Do not preserve it across content codings.
  const etag = res.headers.get('etag')
  if (etag && !etag.startsWith('W/')) res.headers.delete('etag')
}

export function httpEncodingMiddleware(options: HttpEncodingOptions = {}) {
  return async (req: Request, res: Response, next: () => Promise<void>) => {
    if (!(await applyRequestDecoding(req, res, options))) return
    await next()
    applyResponseEncoding(req, res, options)
  }
}
