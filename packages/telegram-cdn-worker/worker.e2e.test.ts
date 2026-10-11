import { describe, expect, it } from 'vitest'
import { createWorker } from './src/index.js'

describe('Worker fetch entrypoint E2E', () => {
  it('executes the Worker fetch handler end-to-end with a request/response stream', async () => {
    const worker = createWorker({ fetchImpl: async upstream => new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upstream-Path': new URL(upstream.url).pathname },
    }) })
    const payload = new Uint8Array([0, 1, 2, 255])
    const response = await worker.fetch(new Request('https://cdn.example.net/files/photo?download=1', { method: 'POST', body: payload }), {
        CROSSGRAM_TELEGRAM_ORIGIN: 'https://telegram.example.com',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream-path')).toBe('/files/photo')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload)
  })
})
