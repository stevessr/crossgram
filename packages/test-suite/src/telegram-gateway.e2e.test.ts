import { it, expect } from 'vitest'
import Long from 'long'
import { randomBytes } from 'node:crypto'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { computeSrpParams } from '@mtcute/core/utils.js'
import { SRP_PRIME_HEX, SrpChallengeStore, generateSrpVerifier, verifySrpChallenge } from '../../bridge/src/login-srp.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TelegramClient, MemoryStorage } from '@mtcute/node'
import { RpcError, type RpcResult } from '@mtproto-relay/mtproto'
import { TelegramGateway, RouteStore, createUpstreamFactory } from '@mtproto-relay/telegram-gateway'
import { startApp } from './harness.js'

it('terminates two independent encrypted MTProto sessions and forwards login, SRP errors and raw RPCs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-double-dh-'))
  const upstream = await startApp()
  const downstream = await startApp()
  const user = { _: 'user' as const, id: 42, firstName: 'Official upstream', self: true }
  const calls: string[] = []
  const verifier = await generateSrpVerifier('gateway-e2e-password')
  const challenges = new SrpChallengeStore()
  let upstreamKey: Uint8Array | null = null
  let downstreamKey: Uint8Array | null = null
  const routes = [
    upstream.ctx.mtproto.register('auth.sendCode', async (rpc, request) => {
      upstreamKey = rpc.authKeyId
      calls.push(request._)
      return { _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: 'real-upstream-hash' }
    }),
    upstream.ctx.mtproto.register('auth.signIn', async (_rpc, request) => {
      calls.push(request._)
      if ((request as { phoneCode?: string }).phoneCode !== '12345') throw new RpcError(400, 'PHONE_CODE_INVALID')
      throw new RpcError(401, 'SESSION_PASSWORD_NEEDED')
    }),
    upstream.ctx.mtproto.register('account.getPassword', async rpc => {
      const challenge = challenges.begin(Buffer.from(rpc.authKeyId!).toString('hex'), verifier)
      return { _: 'account.password', hasPassword: true, currentAlgo: {
        _: 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
        salt1: Buffer.from(verifier.salt1, 'hex'), salt2: Buffer.from(verifier.salt2, 'hex'),
        g: 3, p: Buffer.from(SRP_PRIME_HEX, 'hex'),
      }, srpB: Buffer.from(challenge.B.toString(16).padStart(512, '0'), 'hex'), srpId: challenge.srpId,
      newAlgo: { _: 'passwordKdfAlgoUnknown' }, newSecureAlgo: { _: 'securePasswordKdfAlgoUnknown' }, secureRandom: randomBytes(32) }
    }),
    upstream.ctx.mtproto.register('auth.checkPassword', async (rpc, request) => {
      const challenge = challenges.get(Buffer.from(rpc.authKeyId!).toString('hex'))
      const password = (request as Extract<import('@mtcute/core').tl.RpcMethod, { _: 'auth.checkPassword' }>).password
      if (!challenge || password._ !== 'inputCheckPasswordSRP' || !verifySrpChallenge(challenge, password)) throw new RpcError(400, 'PASSWORD_HASH_INVALID')
      return { _: 'auth.authorization', user }
    }),
    upstream.ctx.mtproto.register('users.getUsers', async () => ({ _: 'vector', items: [user] })),
    upstream.ctx.mtproto.register('updates.getState', async () => ({ _: 'updates.state', pts: 91, qts: 0, date: 1800000000, seq: 3, unreadCount: 0 })),
    upstream.ctx.mtproto.register('account.updateStatus', async () => ({ _: 'boolTrue' })),
  ]
  const store = new RouteStore(join(directory, 'gateway')); await store.init()
  const upstreamDc = { id: 1, ipAddress: '127.0.0.1', port: upstream.port }
  const gateway = new TelegramGateway({ allowedPhones: ['15551234567'] }, {
    store, createUpstream: createUpstreamFactory(store, { defaultDcs: { main: upstreamDc, media: upstreamDc } }),
    isVirtualPhone: async phone => Boolean((await downstream.ctx.database.get('mtproto_auth_session', { virtualPhone: phone })).length),
    isLocalKey: async key => Boolean((await downstream.ctx.database.get('mtproto_auth_binding', { authKeyId: key })).length),
    push: (key, update) => { downstream.ctx.mtproto.sendUpdateToAuthKey(key, update) },
  })
  const middleware = downstream.ctx.on('mtproto/rpc', async function (request, next): Promise<RpcResult | undefined> {
    downstreamKey = this.authKeyId
    const response = await gateway.route(this, request)
    if (response === undefined) return await next() as RpcResult
    return response
  }, { prepend: true })
  const downstreamDc = { id: 1, ipAddress: '127.0.0.1', port: downstream.port }
  const client = new TelegramClient({ apiId: 123, apiHash: 'a'.repeat(32), storage: new MemoryStorage(),
    defaultDcs: { main: downstreamDc, media: downstreamDc }, updates: false, logLevel: 0 })
  try {
    expect(await client.call({ _: 'auth.sendCode', phoneNumber: '+15551234567', apiId: 123, apiHash: 'a'.repeat(32), settings: { _: 'codeSettings' } })).toMatchObject({ phoneCodeHash: 'real-upstream-hash' })
    expect(upstreamKey).not.toBeNull(); expect(downstreamKey).not.toBeNull()
    expect(Buffer.from(upstreamKey!)).not.toEqual(Buffer.from(downstreamKey!))
    await expect(client.call({ _: 'auth.signIn', phoneNumber: '+15551234567', phoneCodeHash: 'real-upstream-hash', phoneCode: '00000' }, { maxRetryCount: 0 })).rejects.toMatchObject({ text: 'PHONE_CODE_INVALID' })
    await expect(client.call({ _: 'auth.signIn', phoneNumber: '+15551234567', phoneCodeHash: 'real-upstream-hash', phoneCode: '12345' }, { maxRetryCount: 0 })).rejects.toMatchObject({ text: 'SESSION_PASSWORD_NEEDED' })
    const passwordInfo = await client.call({ _: 'account.getPassword' })
    const crypto = new NodeCryptoProvider()
    const wrongProof = await computeSrpParams(crypto, passwordInfo, 'wrong-password')
    await expect(client.call({ _: 'auth.checkPassword', password: wrongProof }, { maxRetryCount: 0 })).rejects.toMatchObject({ text: 'PASSWORD_HASH_INVALID' })
    const proof = await computeSrpParams(crypto, passwordInfo, 'gateway-e2e-password')
    expect(await client.call({ _: 'auth.checkPassword', password: proof })).toMatchObject({ _: 'auth.authorization', user: { id: 42 } })
    expect(await client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] })).toMatchObject([{ id: 42 }])
    expect(await client.call({ _: 'updates.getState' })).toMatchObject({ pts: 91 })
    expect(await client.call({ _: 'account.updateStatus', offline: false })).toBe(true)
    const updates: import('@mtcute/core').tl.TypeUpdates[] = []
    const listener = (update: import('@mtcute/core').tl.TypeUpdates) => { updates.push(update) }
    client.onServerUpdate.add(listener)
    upstream.ctx.mtproto.sendUpdateToAuthKey(upstreamKey!, { _: 'updateShort', date: 1800000000,
      update: { _: 'updateUserStatus', userId: 42, status: { _: 'userStatusOnline', expires: 1800000060 } } })
    await expect.poll(() => updates, { timeout: 5000 }).toContainEqual({ _: 'updateShort', date: 1800000000,
      update: { _: 'updateUserStatus', userId: 42, status: { _: 'userStatusOnline', expires: 1800000060 } } })
    client.onServerUpdate.remove(listener)
    expect(calls).toEqual(['auth.sendCode', 'auth.signIn', 'auth.signIn'])
  } finally {
    await client.destroy()
    middleware(); await gateway.stop()
    routes.forEach(dispose => dispose())
    await downstream.stop(); await upstream.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

it('routes a secondary DC through the gateway, transfers media and restores persisted upstream sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-multidc-'))
  const first = await startApp()
  const second = await startApp()
  const downstream = await startApp()
  const user = { _: 'user' as const, id: 42, firstName: 'DC account', self: true }
  const fileBytes = Uint8Array.from([0, 1, 2, 254, 255])
  const mediaCalls: Array<{ dc?: number, cdn?: boolean }> = []
  let secondaryKey: Uint8Array | null = null
  const mediaKeys: string[] = []
  let codeRequests = 0
  let authorizationImports = 0
  const { makeConfig } = await import('../../bridge/src/synthetic.js')
  const config = makeConfig(1, '127.0.0.1', first.port) as import('@mtcute/core').tl.RawConfig
  config.dcOptions = [
    { _: 'dcOption', id: 1, ipAddress: '127.0.0.1', port: first.port },
    { _: 'dcOption', id: 2, ipAddress: '127.0.0.1', port: second.port },
  ]
  const dispose = [
    downstream.ctx.mtproto.register('help.getConfig', async () => makeConfig(1, '127.0.0.1', downstream.port)),
    first.ctx.mtproto.register('help.getConfig', async () => config),
    first.ctx.mtproto.register('auth.sendCode', async () => { codeRequests++; return { _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: 'hash' } }),
    first.ctx.mtproto.register('auth.signIn', async () => ({ _: 'auth.authorization', user })),
    first.ctx.mtproto.register('users.getUsers', async () => ({ _: 'vector', items: [user] })),
    first.ctx.mtproto.register('updates.getState', async () => ({ _: 'updates.state', pts: 1, qts: 0, date: 1800000000, seq: 1, unreadCount: 0 })),
    first.ctx.mtproto.register('auth.exportAuthorization', async () => ({ _: 'auth.exportedAuthorization', id: Long.fromNumber(42), bytes: Uint8Array.of(9, 8, 7) })),
    second.ctx.mtproto.register('help.getConfig', async () => ({ ...config, thisDc: 2 })),
    second.ctx.mtproto.register('auth.importAuthorization', async (rpc, request) => {
      authorizationImports++
      secondaryKey = rpc.authKeyId
      expect(rpc.dcId).toBe(2)
      expect(Buffer.from((request as { bytes: Uint8Array }).bytes)).toEqual(Buffer.from([9, 8, 7]))
      return { _: 'auth.authorization', user }
    }),
    second.ctx.mtproto.register('upload.getFile', async (rpc, request) => {
      mediaKeys.push(Buffer.from(rpc.authKeyId!).toString('hex'))
      mediaCalls.push({ dc: rpc.dcId, cdn: (request as { cdnSupported?: boolean }).cdnSupported })
      return { _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: 1800000000, bytes: fileBytes }
    }),
    second.ctx.mtproto.register('upload.saveFilePart', async () => ({ _: 'boolTrue' })),
    second.ctx.mtproto.register('users.getUsers', async () => ({ _: 'vector', items: [user] })),
  ]
  const store = new RouteStore(join(directory, 'gateway')); await store.init()
  const originDc = { id: 1, ipAddress: '127.0.0.1', port: first.port }
  const dependencies = {
    store, createUpstream: createUpstreamFactory(store, { defaultDcs: { main: originDc, media: originDc } }),
    isVirtualPhone: async (_phone: string) => false,
    isLocalKey: async (_key: string) => false,
    push: (key: Uint8Array, update: import('@mtcute/core').tl.TypeUpdates) => { downstream.ctx.mtproto.sendUpdateToAuthKey(key, update) },
  }
  let gateway = new TelegramGateway({ allowedPhones: ['15551234567'] }, dependencies)
  const { createGatewayMiddleware } = await import('@mtproto-relay/telegram-gateway')
  let removeMiddleware = downstream.ctx.on('mtproto/rpc', createGatewayMiddleware(gateway), { prepend: true })
  const dc = { id: 1, ipAddress: '127.0.0.1', port: downstream.port }
  const client = new TelegramClient({ apiId: 123, apiHash: 'a'.repeat(32), storage: new MemoryStorage(), defaultDcs: { main: dc, media: dc }, updates: false, logLevel: 0 })
  try {
    await client.call({ _: 'auth.sendCode', phoneNumber: '15551234567', apiId: 123, apiHash: 'a'.repeat(32), settings: { _: 'codeSettings' } })
    await client.call({ _: 'auth.signIn', phoneNumber: '15551234567', phoneCodeHash: 'hash', phoneCode: '12345' })
    const advertised = await client.call({ _: 'help.getConfig' })
    expect(advertised.dcOptions.map(option => option.id)).toEqual([1, 2])
    expect(advertised.dcOptions.every(option => option.port === downstream.port)).toBe(true)
    // Secondary connection resolves its endpoint through the rewritten gateway config.
    const location = { _: 'inputDocumentFileLocation' as const, id: Long.fromNumber(55), accessHash: Long.ZERO, fileReference: new Uint8Array(), thumbSize: '' }
    const file = await client.call({ _: 'upload.getFile', location, offset: 0, limit: 4096, cdnSupported: true }, { dcId: 2, maxRetryCount: 0 })
    expect(file._).toBe('upload.file')
    if (file._ === 'upload.file') expect(Buffer.from(file.bytes)).toEqual(Buffer.from(fileBytes))
    expect(secondaryKey).not.toBeNull()
    expect(mediaCalls).toEqual([{ dc: 2, cdn: false }])
    expect(await client.call({ _: 'upload.saveFilePart', fileId: Long.fromNumber(99), filePart: 0, bytes: fileBytes }, { dcId: 2 })).toBe(true)
    removeMiddleware(); await gateway.stop()
    gateway = new TelegramGateway({ allowedPhones: ['15551234567'] }, dependencies)
    removeMiddleware = downstream.ctx.on('mtproto/rpc', createGatewayMiddleware(gateway), { prepend: true })
    expect(await client.call({ _: 'updates.getState' })).toMatchObject({ pts: 1 })
    const restored = await client.call({ _: 'upload.getFile', location, offset: 0, limit: 4096 }, { dcId: 2, maxRetryCount: 0 })
    expect(restored._).toBe('upload.file')
    expect(mediaCalls).toHaveLength(2)
    expect(mediaKeys).toEqual([Buffer.from(secondaryKey!).toString('hex'), Buffer.from(secondaryKey!).toString('hex')])
    expect(codeRequests).toBe(1)
    expect(authorizationImports).toBe(1)
  } finally {
    await client.destroy(); removeMiddleware(); await gateway.stop()
    dispose.forEach(fn => fn())
    await downstream.stop(); await second.stop(); await first.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
