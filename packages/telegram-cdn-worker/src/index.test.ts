import { describe, expect, it, vi } from 'vitest'
import { createWorker } from './index.js'

const env = { CROSSGRAM_TELEGRAM_ORIGIN: 'https://telegram.example.com' }
const request = (path, init = undefined) => new Request(`https://cdn.example.net${path}`, init)

describe('crossgram-telegram CDN front Worker', () => {
  it('proxies path, query, method, body and ordinary headers to the fixed upstream', async () => {
    const fetchImpl = vi.fn(async upstream => new Response('ok', { status: 201 }))
    const app = createWorker({ fetchImpl })
    const response = await app.fetch(request('/api/files?id=1', {
      method: 'POST',
      headers: { Authorization: 'Bearer example', 'Content-Type': 'application/json' },
      body: '{"file":true}',
    }), env)

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('ok')
    const upstream = fetchImpl.mock.calls[0][0]
    expect(upstream.url).toBe('https://telegram.example.com/api/files?id=1')
    expect(upstream.method).toBe('POST')
    expect(upstream.headers.get('authorization')).toBe('Bearer example')
    expect(upstream.headers.get('x-forwarded-host')).toBe('cdn.example.net')
    expect(await upstream.text()).toBe('{"file":true}')
  })

  it('removes hop-by-hop headers, including headers named by Connection', async () => {
    let upstream
    const app = createWorker({ fetchImpl: async request => { upstream = request; return new Response(null) } })
    await app.fetch(request('/media', { headers: { Connection: 'keep-alive, x-private-hop', 'Keep-Alive': 'timeout=5', 'X-Private-Hop': 'secret' } }), env)
    expect(upstream.headers.has('connection')).toBe(false)
    expect(upstream.headers.has('keep-alive')).toBe(false)
    expect(upstream.headers.has('x-private-hop')).toBe(false)
  })

  it('fails closed for invalid/non-HTTPS upstream configuration and blocks TRACE/CONNECT', async () => {
    const fetchImpl = vi.fn()
    const app = createWorker({ fetchImpl })
    expect((await app.fetch(request('/'), { CROSSGRAM_TELEGRAM_ORIGIN: 'http://127.0.0.1' })).status).toBe(500)
    expect((await app.fetch(request('/'), { CROSSGRAM_TELEGRAM_ORIGIN: 'https://user:pass@example.com' })).status).toBe(500)
    expect((await app.fetch({ url: 'https://cdn.example.net/', method: 'TRACE', headers: new Headers() }, env)).status).toBe(405)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not follow upstream redirects, preserves status and adds safe response headers', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/file', Connection: 'keep-alive', 'Keep-Alive': 'timeout=3' } }))
    const testWorker = createWorker({ fetchImpl })
    const proxied = await testWorker.fetch(request('/file'), env)
    expect(proxied.status).toBe(302)
    expect(proxied.headers.get('location')).toBe('https://other.example/file')
    expect(proxied.headers.has('keep-alive')).toBe(false)
    expect(proxied.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('converts upstream transport errors into a bounded 502 response', async () => {
    const app = createWorker({ fetchImpl: async () => { throw new Error('private upstream detail') } })
    const response = await app.fetch(request('/'), env)
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('Upstream unavailable')
  })
})
