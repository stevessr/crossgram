import { it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Long from 'long'
import { createHash } from 'node:crypto'
import type { tl } from '@mtcute/core'
import type { ServerRpcContext } from '@mtproto-relay/mtproto'
import { TelegramGateway, normalizeResult, type Upstream } from './gateway.js'
import { RouteStore } from './store.js'

const directories: string[] = []
const gateways: TelegramGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
function rpc(id = 1) { return { authKeyId: Uint8Array.from([id, 2, 3, 4, 5, 6, 7, 8]) } as ServerRpcContext }
function send(phone = '+15551234567'): tl.RpcMethod {
  return { _: 'auth.sendCode', phoneNumber: phone, apiId: 123, apiHash: 'a'.repeat(32), settings: { _: 'codeSettings' } }
}
async function setup(overrides: { limit?: number, local?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-unit-')); directories.push(directory)
  const store = new RouteStore(directory); await store.init()
  const clients: Array<{ call: ReturnType<typeof vi.fn>, destroy: ReturnType<typeof vi.fn>, emit: (u: tl.TypeUpdates) => void }> = []
  const createUpstream = vi.fn(async (_key: string, _record: unknown) => {
    let listener: (update: tl.TypeUpdates) => void = () => {}
    const client = { call: vi.fn(async (request: tl.RpcMethod): Promise<unknown> => request._ === 'users.getUsers' ? [{ _: 'user', id: 42, firstName: 'Owner' }] : request._ === 'auth.importAuthorization' ? { _: 'auth.authorization', user: { _: 'user', id: 42, firstName: 'Owner' } } : request._ === 'auth.exportAuthorization' ? { _: 'auth.exportedAuthorization', id: Long.fromNumber(42), bytes: Uint8Array.of(1, 2, 3) } : ({ _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: 'upstream' })), destroy: vi.fn(async () => {}),
      exportSession: async () => 'private-upstream-session', primaryDcId: async () => 1,
      onUpdate: (handler: (u: tl.TypeUpdates) => void) => { listener = handler; return () => { listener = () => {} } },
      emit: (update: tl.TypeUpdates) => listener(update),
    }
    clients.push(client)
    return client as Upstream
  })
  const dependencies = {
    store, createUpstream,
    isVirtualPhone: vi.fn(async (phone: string) => phone === '888123456789'),
    isLocalKey: vi.fn(async (_key: string) => overrides.local ?? false),
    push: vi.fn(),
  }
  const options = { allowedPhones: ['+15551234567', '+15557654321'], maxSessions: overrides.limit ?? 20, sendCodeIntervalMs: 60000 }
  const gateway = new TelegramGateway(options, dependencies); gateways.push(gateway)
  return { gateway, dependencies, options, clients, store }
}

it('leaves virtual accounts and existing local keys entirely local', async () => {
  const { gateway, dependencies } = await setup()
  expect(await gateway.route(rpc(), send('+888123456789'))).toBeUndefined()
  expect(dependencies.createUpstream).not.toHaveBeenCalled()
  dependencies.isLocalKey.mockResolvedValue(true)
  expect(await gateway.route(rpc(2), send())).toBeUndefined()
  expect(dependencies.createUpstream).not.toHaveBeenCalled()
})
it('forwards login and SRP unchanged, normalizes Bool/vector, hides arbitrary upstream errors', async () => {
  const { gateway, clients } = await setup()
  expect(await gateway.route(rpc(), send())).toMatchObject({ phoneCodeHash: 'upstream' })
  const password = { _: 'auth.checkPassword', password: { _: 'inputCheckPasswordEmpty' } } as tl.RpcMethod
  clients[0].call.mockResolvedValueOnce(true)
  expect(await gateway.route(rpc(), password)).toEqual({ _: 'boolTrue' })
  expect(clients[0].call).toHaveBeenLastCalledWith(password)
  clients[0].call.mockRejectedValueOnce({ code: 400, errorMessage: 'SESSION_PASSWORD_NEEDED' })
  await expect(gateway.route(rpc(), password)).rejects.toMatchObject({ code: 400, text: 'SESSION_PASSWORD_NEEDED' })
  clients[0].call.mockRejectedValueOnce(new Error('secret-code-and-hash'))
  await expect(gateway.route(rpc(), password)).rejects.toMatchObject({ text: 'GATEWAY_UPSTREAM_UNAVAILABLE' })
  expect(normalizeResult([{ _: 'userEmpty', id: 1 }])).toMatchObject({ _: 'vector', items: [{ id: 1 }] })
})
it('isolates downstream keys, pushes only to the matching key and restores sticky routes after restart', async () => {
  const { gateway, dependencies, options, clients, store } = await setup()
  await gateway.route(rpc(), send())
  await gateway.route(rpc(2), send('+15557654321'))
  expect(clients).toHaveLength(2)
  clients[0].emit({ _: 'updatesTooLong' })
  expect(dependencies.push).toHaveBeenCalledWith(rpc().authKeyId, { _: 'updatesTooLong' })
  await gateway.stop()
  const restored = new TelegramGateway(options, dependencies); gateways.push(restored)
  await restored.route(rpc(), { _: 'updates.getState' })
  expect(clients).toHaveLength(3)
  const key = createHash('sha256').update(rpc().authKeyId!).digest('hex')
  expect((await store.load(key))?.phone).toBe('15551234567')
  if (process.platform !== 'win32') {
    expect((await stat(join(store.directory, `${key}.json`))).mode & 0o777).toBe(0o600)
  }
})
it('rejects non-allowlisted numbers, cross-account switching, migration/QR and repeated code requests', async () => {
  const { gateway, dependencies } = await setup()
  await expect(gateway.route(rpc(), send('+15550000000'))).rejects.toMatchObject({ text: 'GATEWAY_PHONE_NOT_ALLOWED' })
  await gateway.route(rpc(), send())
  await expect(gateway.route(rpc(), send())).rejects.toMatchObject({ code: 420 })
  await expect(gateway.route(rpc(), send('+15557654321'))).rejects.toMatchObject({ text: 'AUTH_RESTART' })
  await expect(gateway.route(rpc(), { _: 'auth.exportLoginToken', apiId: 123, apiHash: 'a'.repeat(32), exceptIds: [] })).rejects.toMatchObject({ text: 'GATEWAY_DC_OR_QR_NOT_SUPPORTED' })
  expect(await gateway.route(rpc(), { _: 'help.getConfig' })).toMatchObject({ phoneCodeHash: 'upstream' })
  expect(await gateway.route(rpc(), { _: 'auth.bindTempAuthKey' } as tl.RpcMethod)).toBeUndefined()
})
it('caps upstream sessions without rejecting virtual logins and deletes state on logout', async () => {
  const { gateway, clients, store } = await setup({ limit: 1 })
  await gateway.route(rpc(), send())
  await expect(gateway.route(rpc(2), send('+15557654321'))).rejects.toMatchObject({ text: 'GATEWAY_SESSION_LIMIT' })
  expect(await gateway.route(rpc(3), send('+888123456789'))).toBeUndefined()
  clients[0].call.mockResolvedValueOnce({ _: 'auth.loggedOut' })
  await gateway.route(rpc(), { _: 'auth.logOut' })
  expect(clients[0].destroy).toHaveBeenCalledOnce()
  const key = createHash('sha256').update(rpc().authKeyId!).digest('hex')
  expect(await store.load(key)).toBeUndefined()
})
it('coalesces concurrent selection for one key and refuses unsafe storage', async () => {
  const { gateway, dependencies, store } = await setup()
  await Promise.allSettled([gateway.route(rpc(), send()), gateway.route(rpc(), send())])
  expect(dependencies.createUpstream).toHaveBeenCalledOnce()
  if (process.platform !== 'win32') {
    await chmod(store.directory, 0o755)
    await expect(store.init()).rejects.toThrow('0700')
  }
})

it('issues opaque single-use DC tickets, imports real authorization and rejects replay/wrong DC', async () => {
  const { gateway, clients, dependencies } = await setup()
  await gateway.route(rpc(), send())
  const exported = await gateway.route(rpc(), { _: 'auth.exportAuthorization', dcId: 2 }) as { id: Long, bytes: Uint8Array }
  expect(exported.bytes).toHaveLength(32)
  expect(Buffer.from(exported.bytes)).not.toEqual(Buffer.from([1, 2, 3]))
  await expect(gateway.route({ ...rpc(3), dcId: 3 }, { _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes })).rejects.toMatchObject({ text: 'AUTH_BYTES_INVALID' })
  expect(await gateway.route({ ...rpc(2), dcId: 2 }, { _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes })).toMatchObject({ _: 'auth.authorization' })
  expect(clients[1].call).toHaveBeenCalledWith({ _: 'auth.importAuthorization', id: Long.fromNumber(42), bytes: Buffer.from([1, 2, 3]) })
  await expect(gateway.route({ ...rpc(4), dcId: 2 }, { _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes })).rejects.toMatchObject({ text: 'AUTH_BYTES_INVALID' })
  expect(dependencies.createUpstream.mock.calls[1][1]).toMatchObject({ dcId: 2, phone: '15551234567' })
})
it('supports same-upstream-DC logical migration without exporting auth to its own DC', async () => {
  const { gateway, clients, dependencies } = await setup()
  await gateway.route(rpc(), send())
  const exported = await gateway.route(rpc(), { _: 'auth.exportAuthorization', dcId: 1 }) as { id: Long, bytes: Uint8Array }
  expect(clients[0].call).not.toHaveBeenCalledWith({ _: 'auth.exportAuthorization', dcId: 1 })
  expect(await gateway.route({ ...rpc(2), dcId: 1 }, { _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes })).toMatchObject({ _: 'auth.authorization' })
  expect(dependencies.createUpstream.mock.calls[1][1]).toMatchObject({ seedSession: 'private-upstream-session' })
})

it('fails closed when a persisted upstream session loses its route metadata', async () => {
  const { gateway, store, dependencies } = await setup()
  const key = createHash('sha256').update(rpc().authKeyId!).digest('hex')
  const path = await store.sessionPath(key)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, 'previous-account-session')
  await expect(gateway.route(rpc(), send())).rejects.toMatchObject({ text: 'GATEWAY_STATE_INCONSISTENT' })
  expect(dependencies.createUpstream).not.toHaveBeenCalled()
})

it('retries phone selection after a concurrent unselected help request', async () => {
  const { gateway, dependencies } = await setup()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  dependencies.isLocalKey.mockImplementationOnce(async () => { await pending; return false })
  const help = gateway.route(rpc(), { _: 'help.getNearestDc' })
  const login = gateway.route(rpc(), send())
  release()
  expect(await help).toBeUndefined()
  expect(await login).toMatchObject({ phoneCodeHash: 'upstream' })
  expect(dependencies.createUpstream).toHaveBeenCalledTimes(1)
})

it('logs out imported descendants and removes their private state without affecting another account', async () => {
  const { gateway, store, clients } = await setup()
  await gateway.route(rpc(), send())
  const exported = await gateway.route(rpc(), { _: 'auth.exportAuthorization', dcId: 2 }) as { id: Long, bytes: Uint8Array }
  await gateway.route({ ...rpc(2), dcId: 2 }, { _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes })
  await gateway.route(rpc(3), send('+15557654321'))
  clients[0].call.mockResolvedValueOnce({ _: 'auth.loggedOut' })
  expect(await gateway.route(rpc(), { _: 'auth.logOut' })).toMatchObject({ _: 'auth.loggedOut' })
  expect(clients[0].destroy).toHaveBeenCalledTimes(1)
  expect(clients[1].destroy).toHaveBeenCalledTimes(1)
  expect(clients[2].destroy).not.toHaveBeenCalled()
  for (const id of [1, 2]) expect(await store.load(createHash('sha256').update(rpc(id).authKeyId!).digest('hex'))).toBeUndefined()
  expect(await store.load(createHash('sha256').update(rpc(3).authKeyId!).digest('hex'))).toBeDefined()
})
