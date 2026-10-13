import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import SolidWebUI, { escapeScriptJSON, normalizePath } from './index.js'
import {
  expectReconnectWithoutReload,
  waitForConnection,
} from './browser-test-utils.js'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { safeAsset } from './entry.js'
import { decodeFrame, encodeFrame, unpackFrame } from './wire.js'

async function start(uiPath = '') {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(SolidWebUI, { uiPath }),
  ]
  await Promise.all(fibers)
  await vi.waitFor(() =>
    expect(fibers.map((fiber) => fiber.state)).toEqual([2, 2]),
  )
  const ui = ctx.get('webui') as unknown as SolidWebUI
  return {
    ctx,
    ui,
    url: ctx.server.baseUrl,
    stop: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}
async function connect(url: string) {
  const frames: any[] = []
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api')
  socket.addEventListener('message', (event) =>
    frames.push(JSON.parse(String(event.data))),
  )
  await vi.waitFor(() => expect(frames[0]?.type).toBe('entry:init'))
  return {
    socket,
    frames,
    send: (type: string, body: unknown) =>
      socket.send(JSON.stringify({ type, body })),
  }
}
describe('Solid WebUI production service', () => {
  it('escapes embedded settings and rejects unsafe paths', () => {
    expect(escapeScriptJSON({ title: '</script>\u2028' })).not.toContain('<')
    expect(JSON.parse(escapeScriptJSON({ title: '</script>' })).title).toBe(
      '</script>',
    )
    for (const value of [
      '/../private',
      '/bad path',
      '/a?b',
      '/a\\b',
      'relative',
    ])
      expect(() => normalizePath(value)).toThrow()
    for (const value of ['../private', '/abs', 'C:/secret', 'a\\b', 'a/../b'])
      expect(safeAsset(value)).toBe(false)
    expect(normalizePath('/console///')).toBe('/console')
  })
  it('serves a diagnosable page instead of crash-looping when the bundle is absent', async () => {
    class MissingBundle extends SolidWebUI {
      override root = resolve(import.meta.dirname, '../dist/__missing__')
    }
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(MissingBundle),
    ]
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.map((fiber) => fiber.state)).toEqual([2, 2]),
      )
      const response = await fetch(ctx.server.baseUrl + '/', {
        headers: { accept: 'text/html' },
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('yarn build:webui')
    } finally {
      for (const fiber of fibers.reverse())
        await Promise.resolve((fiber as any).dispose?.())
    }
  })
  it('serves exact manifests under a prefix without exposing arbitrary files', async () => {
    const app = await start('/console')
    try {
      const home = await fetch(app.url + '/console', {
        headers: { accept: 'text/html' },
      })
      expect(home.status).toBe(200)
      expect(home.headers.get('cache-control')).toBe('no-store')
      const html = await home.text()
      expect(html).toContain('window.SOLID_WEBUI_CONFIG')
      const asset = /src="([^"]+\.js)"/.exec(html)![1]
      expect(asset).toMatch(/^\/console\/assets\//)
      const js = await fetch(app.url + asset)
      expect(js.status).toBe(200)
      expect(js.headers.get('cache-control')).toContain('immutable')
      for (const route of [
        '/console/assets/missing.js',
        '/console/-/modules/missing/private',
        '/console/package.json',
      ]) {
        expect((await fetch(app.url + route)).status).toBe(404)
      }
      expect(
        (
          await fetch(app.url + '/console/not-a-page', {
            headers: { accept: 'text/html' },
          })
        ).status,
      ).toBe(404)
    } finally {
      await app.stop()
    }
  })
  it('scopes entries to plugin lifetime and streams Muon only to subscribed clients', async () => {
    const app = await start()
    let entry: ReturnType<SolidWebUI['addEntry']> | undefined
    const plugin = app.ctx.plugin({
      name: 'test-entry',
      inject: ['webui'],
      apply(ctx: Context) {
        entry = (ctx.get('webui') as unknown as SolidWebUI).addEntry<any>(
          { baseUrl: import.meta.url, client: 'loader', routes: ['/capture'] },
          {
            count: 0,
            large: 'x'.repeat(100_000),
            increment() {
              entry!.mutate((data: any) => data.count++)
            },
          },
        ) as any
      },
    })
    let a: Awaited<ReturnType<typeof connect>> | undefined, b: typeof a
    try {
      await plugin
      await vi.waitFor(() =>
        expect(Object.keys(app.ui.entries)).toHaveLength(1),
      )
      a = await connect(app.url)
      b = await connect(app.url)
      expect(JSON.stringify(a.frames[0])).not.toContain('large')
      const id = entry!.id
      a.send('entry:subscribe', { id })
      await vi.waitFor(() =>
        expect(a!.frames.some((frame) => frame.type === 'entry:snapshot')).toBe(
          true,
        ),
      )
      a.send('rpc:request', {
        sn: 1,
        entryId: id,
        method: 'increment',
        args: [],
      })
      await vi.waitFor(() =>
        expect(
          a!.frames.some(
            (frame) => frame.type === 'rpc:response' && frame.body.ok,
          ),
        ).toBe(true),
      )
      expect(a.frames.some((frame) => frame.type === 'entry:delta')).toBe(true)
      expect(b.frames.some((frame) => frame.type === 'entry:delta')).toBe(false)
      await plugin.dispose()
      await vi.waitFor(() =>
        expect(a!.frames.at(-1).body.entries[id]).toBe(null),
      )
      expect(app.ui.entries[id]).toBeUndefined()
    } finally {
      a?.socket.close()
      b?.socket.close()
      await plugin.dispose()
      await app.stop()
    }
  })
  it('streams async RPC chunks across a real WebSocket without replacing legacy RPC', async () => {
    const app = await start()
    let entry: ReturnType<SolidWebUI['addEntry']> | undefined
    const plugin = app.ctx.plugin({
      name: 'test-stream',
      inject: ['webui'],
      apply(ctx: Context) {
        entry = (ctx.get('webui') as unknown as SolidWebUI).addEntry<any>(
          { baseUrl: import.meta.url, client: 'loader' },
          {
            async *count() {
              yield { chunk: 1 }
              yield { chunk: 2 }
            },
          },
        )
      },
    })
    let connected: Awaited<ReturnType<typeof connect>> | undefined
    try {
      await plugin
      await vi.waitFor(() => expect(entry?.id && app.ui.entries[entry.id]).toBeDefined())
      connected = await connect(app.url)
      connected.send('rpc:request', {
        sn: 18, entryId: entry!.id, method: 'count', args: [], stream: true,
      })
      await vi.waitFor(() => expect(connected!.frames.some(frame =>
        frame.type === 'rpc:complete' && frame.body.sn === 18)).toBe(true))
      const kinds = connected.frames.filter(frame => frame.body?.sn === 18).map(frame => frame.type)
      expect(kinds).toEqual(['rpc:start', 'rpc:delta', 'rpc:delta', 'rpc:complete'])
    } finally {
      connected?.socket.close()
      await plugin.dispose()
      await app.stop()
    }
  })
  it.each(['text', 'buffer'])('upgrades %s JSON envelopes over real WebSockets and processes binary ping/pong', async (encoding) => {
    const app = await start()
    const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/api')
    socket.binaryType = 'arraybuffer'
    const frames: any[] = []
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') frames.push(JSON.parse(event.data))
      else frames.push(unpackFrame(decodeFrame(event.data as ArrayBuffer)))
    })
    try {
      await vi.waitFor(() =>
        expect(frames[0]?.body?.transport).toBe('protobuf-gzip-v1'),
      )
      const upgrade = JSON.stringify({ type: 'transport:upgrade', body: { version: 1 } })
      socket.send(encoding === 'buffer' ? Buffer.from(upgrade) : upgrade)
      await vi.waitFor(() =>
        expect(frames.some(frame => frame.type === 'transport:ready')).toBe(true),
      )
      socket.send(encodeFrame('ping'))
      await vi.waitFor(() =>
        expect(frames.some(frame => frame.type === 'pong')).toBe(true),
      )
    } finally {
      socket.close()
      await app.stop()
    }
  })
  it('negotiates HTTP compression and safely decodes compressed JSON uploads', async () => {
    const app = await start()
    try {
      app.ctx.server.get('/__compression_probe', async (_req, res) => {
        res.json({ text: 'compressible-payload'.repeat(2000) })
      })
      app.ctx.server.post('/__compression_echo', async (req, res) => {
        res.json({ echo: await req.json() })
      })
      const gzipResponse = await fetch(app.url + '/__compression_probe', {
        headers: { 'accept-encoding': 'gzip' },
      })
      expect(gzipResponse.status).toBe(200)
      expect(gzipResponse.headers.get('content-encoding')).toBe('gzip')
      expect(gzipResponse.headers.get('vary')).toContain('Accept-Encoding')
      expect((await gzipResponse.json() as any).text).toContain('compressible-payload')
      const brResponse = await fetch(app.url + '/__compression_probe', {
        headers: { 'accept-encoding': 'br' },
      })
      expect(brResponse.headers.get('content-encoding')).toBe('br')
      expect((await brResponse.json() as any).text).toContain('compressible-payload')
      const upload = await fetch(app.url + '/__compression_echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gzipSync(JSON.stringify({ valid: true })),
      })
      expect(upload.status).toBe(200)
      expect(await upload.json()).toEqual({ echo: { valid: true } })
      const corrupt = await fetch(app.url + '/__compression_echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: 'broken gzip',
      })
      expect(corrupt.status).toBe(400)
    } finally {
      await app.stop()
    }
  })
  it('delivers incremental SSE events with IDs and skips response compression', async () => {
    const app = await start()
    const controller = new AbortController()
    try {
      const response = await fetch(app.url + '/api/events?entry=demo', {
        headers: { accept: 'text/event-stream', 'accept-encoding': 'gzip' },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.headers.get('content-encoding')).toBe(null)
      const reader = response.body!.getReader()
      const initial = new TextDecoder().decode((await reader.read()).value)
      expect(initial).toContain('event: entry:init')
      app.ui.broadcast('entry:delta', { id: 'demo', patch: 'increment' })
      let received = ''
      for (let i = 0; i < 4 && !received.includes('entry:delta'); i++) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += new TextDecoder().decode(chunk.value)
      }
      expect(received).toContain('event: entry:delta')
      expect(received).toMatch(/id: [0-9a-f]{24}:[0-9]+/)
      controller.abort()
      await vi.waitFor(() => expect(app.ui.sse.activeClients).toBe(0))
    } finally {
      controller.abort()
      await app.stop()
    }
  })
  it('renders the production shell on mobile without overflow or Vue', async () => {
    const app = await start('/console')
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    })
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(app.url + '/console/')
      await page
        .getByRole('heading', { name: 'Overview', exact: true })
        .waitFor()
      await waitForConnection(page)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await expect
        .poll(() => page.locator('.navigation').getAttribute('class'))
        .toContain('open')
      await page
        .getByRole('button', { name: 'Close navigation' })
        // The drawer (z-index 30) overlays the scrim (z-index 25), so click the
        // part of the scrim right of the 300px drawer in the 390px viewport.
        .click({ position: { x: 350, y: 100 } })
      expect(await page.evaluate(() => '__VUE__' in window)).toBe(false)
      await expectReconnectWithoutReload(page, app.ui)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
      await app.stop()
    }
  }, 90_000)
})
