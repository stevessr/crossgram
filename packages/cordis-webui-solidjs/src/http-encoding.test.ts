import { describe, expect, it } from 'vitest'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import type { Request, Response } from '@cordisjs/plugin-server'
import { applyResponseEncoding, selectEncoding } from './http-encoding.js'

function mock(payload: string, accept = 'gzip') {
  const req = { method: 'GET', headers: new Headers({ 'accept-encoding': accept }) } as Request
  const state = {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    _bodyInit: payload as unknown,
  }
  const res = {
    get status() { return state.status },
    headers: state.headers,
    get body() { return state._bodyInit },
    set body(value: unknown) { state._bodyInit = value },
    get _bodyInit() { return state._bodyInit },
  } as unknown as Response
  return { req, res, state }
}

describe('HTTP response content encoding', () => {
  it('honors quality weights, wildcard, identity and exclusions', () => {
    expect(selectEncoding(null)).toBe(null)
    expect(selectEncoding('gzip')).toBe('gzip')
    expect(selectEncoding('br;q=0.7,gzip;q=1')).toBe('gzip')
    expect(selectEncoding('gzip;q=0,*;q=0.5', ['gzip', 'br'])).toBe('br')
    expect(selectEncoding('br;q=0,gzip;q=0')).toBe(null)
    expect(selectEncoding('gzip;q=2')).toBe(null)
  })
  it('compresses gzip JSON and maintains cache safety', () => {
    const { req, res, state } = mock(JSON.stringify({ data: 'repeat'.repeat(3000) }))
    res.headers.set('etag', '"raw"')
    res.headers.set('vary', 'Origin')
    applyResponseEncoding(req, res)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('Origin, Accept-Encoding')
    expect(res.headers.get('etag')).toBe(null)
    expect(JSON.parse(gunzipSync(state._bodyInit as Uint8Array).toString())).toHaveProperty('data')
  })
  it('supports Brotli and does not encode SSE or already encoded content', () => {
    const a = mock('a'.repeat(10_000), 'br')
    applyResponseEncoding(a.req, a.res)
    expect(a.res.headers.get('content-encoding')).toBe('br')
    expect(brotliDecompressSync(a.state._bodyInit as Uint8Array).toString()).toHaveLength(10_000)
    const b = mock('a'.repeat(10_000), 'gzip')
    b.res.headers.set('content-type', 'text/event-stream')
    applyResponseEncoding(b.req, b.res)
    expect(b.res.headers.get('content-encoding')).toBe(null)
    const c = mock('a'.repeat(10_000), 'gzip')
    c.res.headers.set('content-encoding', 'br')
    applyResponseEncoding(c.req, c.res)
    expect(c.res.headers.get('content-encoding')).toBe('br')
  })
  it('skips tiny and non-compressible responses', () => {
    const a = mock('tiny')
    applyResponseEncoding(a.req, a.res)
    expect(a.res.headers.get('content-encoding')).toBe(null)
    const b = mock('x'.repeat(10_000))
    b.res.headers.set('content-type', 'image/webp')
    applyResponseEncoding(b.req, b.res)
    expect(b.res.headers.get('content-encoding')).toBe(null)
  })
})
