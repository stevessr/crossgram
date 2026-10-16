import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { openPage, waitForConnection } from './browser-test-utils.js'
import type { PlatformAccountDashboardData } from '../../bridge/src/dashboard-types.js'
import SolidWebUI from './index.js'

describe('online platform account onboarding', () => {
  it('creates and enables a Matrix account through the real browser RPC channel without leaking its token', { timeout: 90_000 }, async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(SolidWebUI),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() => expect(fibers.every((fiber) => fiber.state === 2)).toBe(true))
      const ui = ctx.get('webui') as unknown as SolidWebUI
      const created: unknown[] = []
      const updated: unknown[] = []
      const loaderData = {
        async createConfig(options: unknown) {
          created.push(options)
          return 'accounts/new-matrix'
        },
        async updateConfig(options: unknown) {
          updated.push(options)
        },
      }
      const loader = ui.addEntry<typeof loaderData>({
        baseUrl: import.meta.url,
        client: 'loader',
        routes: ['/plugins'],
      }, loaderData)
      const data: PlatformAccountDashboardData = {
        accounts: [],
        serverConfig: {
          name: 'CrossGram', enable_special_config: false,
          host: '127.0.0.1', port: 4430, rsa_key: 'TEST_PUBLIC_KEY', dcs: [],
        },
        loginTokenApprovalUrl: '/api/login-tokens',
        onDemandLoginCodes: true,
        loginCodeTtlSeconds: 300,
        async requestLoginCode() {},
        updatedAt: Date.now(),
        async refresh() {},
        async setLoginPassword() {},
      }
      const accounts = ui.addEntry({
        baseUrl: new URL('../../bridge/src/index.ts', import.meta.url).href,
        manifest: '../dist/manifest.json',
        routes: ['/platform-accounts'],
      }, data)
      await Promise.all([loader.ready, accounts.ready])
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(ctx.server.baseUrl)
      await waitForConnection(page)
      await openPage(page, 'Platform accounts')
      await page.getByRole('button', { name: '添加账号' }).click()
      await page.getByLabel('平台类型').selectOption('matrix')
      await page.getByLabel('Matrix Homeserver').fill('https://matrix.example.org')
      // The default method is the token field; keep this flow on paste-token.
      await page.getByRole('button', { name: '粘贴访问令牌' }).click()
      await page.getByLabel('Matrix Access Token').fill('private-matrix-token')
      await page.getByLabel('账号备注名称（可选）').fill('家庭 Matrix')
      await page.getByRole('button', { name: '添加并启用' }).click()
      await vi.waitFor(() => {
        expect(created).toEqual([{
          name: '@mtproto-relay/platform-matrix',
          label: '家庭 Matrix',
          config: { homeserver: 'https://matrix.example.org', accessToken: 'private-matrix-token' },
          disabled: true,
        }])
        expect(updated).toEqual([{ id: 'accounts/new-matrix', disabled: false }])
      })
      await page.getByRole('heading', { name: '在线添加平台账号' }).waitFor({ state: 'detached' })
      expect(await page.locator('body').textContent()).not.toContain('private-matrix-token')
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      await Promise.all(fibers.reverse().map((fiber) => Promise.resolve(fiber.dispose())))
    }
  })

  it('signs a Matrix account in with the account password through the relay proxy', { timeout: 90_000 }, async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(SolidWebUI),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() => expect(fibers.every((fiber) => fiber.state === 2)).toBe(true))
      const ui = ctx.get('webui') as unknown as SolidWebUI
      const created: unknown[] = []
      const updated: unknown[] = []
      const loaderData = {
        async createConfig(options: unknown) {
          created.push(options)
          return 'accounts/new-matrix'
        },
        async updateConfig(options: unknown) {
          updated.push(options)
        },
      }
      const loader = ui.addEntry<typeof loaderData>({
        baseUrl: import.meta.url,
        client: 'loader',
        routes: ['/plugins'],
      }, loaderData)
      const data: PlatformAccountDashboardData = {
        accounts: [],
        serverConfig: {
          name: 'CrossGram', enable_special_config: false,
          host: '127.0.0.1', port: 4430, rsa_key: 'TEST_PUBLIC_KEY', dcs: [],
        },
        loginTokenApprovalUrl: '/api/login-tokens',
        onDemandLoginCodes: true,
        loginCodeTtlSeconds: 300,
        async requestLoginCode() {},
        updatedAt: Date.now(),
        async refresh() {},
        async setLoginPassword() {},
      }
      const accounts = ui.addEntry({
        baseUrl: new URL('../../bridge/src/index.ts', import.meta.url).href,
        manifest: '../dist/manifest.json',
        routes: ['/platform-accounts'],
      }, data)
      await Promise.all([loader.ready, accounts.ready])
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      // Intercept the relay login proxy: the browser must send exactly one
      // bounded request, and the token it receives must reach the loader RPC.
      const loginRequests: unknown[] = []
      await page.route('**/api/matrix/login', async (route) => {
        loginRequests.push(route.request().postDataJSON())
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ accessToken: 'syt-e2e', userId: '@alice:example.org', deviceId: 'DEV1' }),
        })
      })
      await page.goto(ctx.server.baseUrl)
      await waitForConnection(page)
      await openPage(page, 'Platform accounts')
      await page.getByRole('button', { name: '添加账号' }).click()
      await page.getByLabel('平台类型').selectOption('matrix')
      await page.getByLabel('Matrix Homeserver').fill('https://matrix.example.org')
      const methods = page.getByRole('radiogroup', { name: 'Matrix 登录方式' })
      if (await methods.count() === 0) {
        console.log('DEBUG modal:', (await page.locator('.modal, [role=dialog], form').first().textContent().catch(() => 'no modal'))?.slice(0, 800))
        throw new Error('Matrix 登录方式 radiogroup 未渲染')
      }
      await page.getByRole('button', { name: '账号密码登录' }).click()
      await page.getByLabel('Matrix 用户名').fill('@alice:example.org')
      await page.getByLabel('Matrix 密码').fill('correct-horse')
      await page.getByRole('button', { name: '登录并获取令牌' }).click()
      await page.getByText('登录成功，已获取访问令牌。').waitFor()
      expect(loginRequests).toEqual([{
        homeserver: 'https://matrix.example.org',
        userId: '@alice:example.org',
        password: 'correct-horse',
      }])
      await page.getByRole('button', { name: '添加并启用' }).click()
      await vi.waitFor(() => {
        expect(created).toEqual([{
          name: '@mtproto-relay/platform-matrix',
          label: 'Matrix',
          config: {
            homeserver: 'https://matrix.example.org',
            accessToken: 'syt-e2e',
            userId: '@alice:example.org',
          },
          disabled: true,
        }])
        expect(updated).toEqual([{ id: 'accounts/new-matrix', disabled: false }])
      })
      await page.getByRole('heading', { name: '在线添加平台账号' }).waitFor({ state: 'detached' })
      // The minted token must not linger in the page after the modal closes.
      expect(await page.locator('body').textContent()).not.toContain('syt-e2e')
      expect(await page.locator('body').textContent()).not.toContain('correct-horse')
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      await Promise.all(fibers.reverse().map((fiber) => Promise.resolve(fiber.dispose())))
    }
  })
})
