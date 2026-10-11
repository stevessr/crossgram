import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { tl } from '@mtcute/core'
import { TelegramClient } from '@mtcute/node'
import { bareVector, RpcError, type RpcResult, type ServerRpcContext } from '@mtproto-relay/mtproto'
import type { DcOptions } from '@mtcute/core/utils.js'
import Long from 'long'
import { RouteStore, type RouteRecord } from './store.js'

export interface Upstream {
  call(request: tl.RpcMethod): Promise<unknown>
  onUpdate(handler: (update: tl.TypeUpdates) => void): () => void
  destroy(): Promise<void>
  exportSession?(): Promise<string>
  primaryDcId?(): Promise<number>
}
export type UpstreamFactory = (key: string, record: RouteRecord) => Promise<Upstream>
export interface GatewayOptions {
  allowedPhones: string[]
  maxSessions?: number
  sendCodeIntervalMs?: number
}
export interface GatewayDependencies {
  store: RouteStore
  createUpstream: UpstreamFactory
  isVirtualPhone(phone: string): Promise<boolean>
  isLocalKey(authKeyId: string): Promise<boolean>
  push(authKeyId: Uint8Array, update: tl.TypeUpdates): void
}
interface Entry { record: RouteRecord, client: Upstream, removeListener: () => void }

/** Independent official Telegram authorization for each downstream permanent auth key. */
export class TelegramGateway {
  private entries = new Map<string, Promise<Entry | undefined>>()
  private selections = new Map<string, string>()
  private rates = new Map<string, number>()
  private stopped = false
  private allowed: Set<string>
  constructor(private options: GatewayOptions, private dependencies: GatewayDependencies) {
    this.allowed = new Set(options.allowedPhones.map(normalizePhone))
  }

  async route(rpc: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult | undefined> {
    try { return await this.handle(rpc, request) }
    catch (error) {
      if (error instanceof RpcError) throw error
      const e = error as { code?: number, errorMessage?: string, text?: string }
      const text = e.text ?? e.errorMessage
      if (Number.isInteger(e.code) && typeof text === 'string' && /^[A-Z0-9_]+$/.test(text)) throw new RpcError(e.code!, text)
      throw new RpcError(502, 'GATEWAY_UPSTREAM_UNAVAILABLE')
    }
  }

  private async handle(rpc: ServerRpcContext, request: tl.RpcMethod): Promise<RpcResult | undefined> {
    if (this.stopped) throw new RpcError(503, 'GATEWAY_STOPPED')
    if (!rpc.authKeyId) return
    // Local transport key binding must never be forwarded: its nonce/key IDs are unrelated upstream.
    if (request._ === 'auth.bindTempAuthKey') return
    const rawKey = Buffer.from(rpc.authKeyId).toString('hex')
    const key = createHash('sha256').update(rpc.authKeyId).digest('hex')
    let pending = this.entries.get(key)
    const previousMethod = this.selections.get(key)
    if (!pending) {
      this.selections.set(key, request._)
      pending = this.select(rpc, request, key, rawKey)
      this.entries.set(key, pending)
      pending.then(entry => { if (!entry && this.entries.get(key) === pending) this.entries.delete(key); this.selections.delete(key) },
        () => { if (this.entries.get(key) === pending) this.entries.delete(key); this.selections.delete(key) })
    }
    const entry = await pending
    if (!entry) {
      if (previousMethod && previousMethod !== request._ && (request._ === 'auth.sendCode' || request._ === 'auth.importAuthorization')) return this.handle(rpc, request)
      return
    }
    if ('phoneNumber' in request && typeof request.phoneNumber === 'string' && normalizePhone(request.phoneNumber) !== entry.record.phone) {
      throw new RpcError(400, 'AUTH_RESTART')
    }
    if (request._ === 'help.getNearestDc') return
    if (request._ === 'auth.exportAuthorization') {
      if (!Number.isSafeInteger(request.dcId) || request.dcId < 1 || request.dcId > 1000) throw new RpcError(400, 'DC_ID_INVALID')
      const target = request.dcId
      const primary = await entry.client.primaryDcId?.()
      let record: RouteRecord
      let id: string
      if (target === primary) {
        const users = await entry.client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }) as Array<{ id: number }>
        if (!users[0]?.id || !entry.client.exportSession) throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
        id = String(users[0].id)
        record = { ...entry.record, dcId: target, seedSession: await entry.client.exportSession(), pendingImport: undefined, importedFrom: key }
      } else {
        const exported = await entry.client.call(request) as { id: Long, bytes: Uint8Array }
        id = String(exported.id)
        record = { ...entry.record, dcId: target, seedSession: undefined, pendingImport: { id, bytes: Buffer.from(exported.bytes).toString('base64') }, importedFrom: key }
      }
      const bytes = await this.dependencies.store.exportTicket({ parent: key, userId: id, dcId: target, expiresAt: Date.now() + 60000, record })
      return { _: 'auth.exportedAuthorization', id: Long.fromString(id), bytes }
    }
    if (request._ === 'auth.importAuthorization') {
      if (entry.record.importTicketHash !== createHash('sha256').update(request.bytes).digest('hex')) throw new RpcError(400, 'AUTH_BYTES_INVALID')
      let result: unknown
      if (entry.record.pendingImport) {
        result = await entry.client.call({ _: 'auth.importAuthorization', id: Long.fromString(entry.record.pendingImport.id), bytes: Buffer.from(entry.record.pendingImport.bytes, 'base64') })
      } else {
        const users = await entry.client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }) as tl.RawUser[]
        if (!users[0] || users[0]._ !== 'user') throw new RpcError(401, 'AUTH_KEY_UNREGISTERED')
        result = { _: 'auth.authorization', user: users[0] }
      }
      entry.record.pendingImport = undefined
      entry.record.seedSession = undefined
      await this.dependencies.store.save(key, entry.record)
      return normalizeResult(result)
    }
    // These need explicit cross-key/DC mapping and must not leak upstream auth blobs to local keys.
    if (request._ === 'auth.exportLoginToken' || request._ === 'auth.importLoginToken') {
      throw new RpcError(400, 'GATEWAY_DC_OR_QR_NOT_SUPPORTED')
    }
    if (request._ === 'auth.sendCode' || request._ === 'auth.resendCode') {
      if (request._ === 'auth.sendCode' && (request.apiId !== entry.record.apiId || request.apiHash !== entry.record.apiHash)) {
        throw new RpcError(400, 'API_ID_INVALID')
      }
      const previous = this.rates.get(entry.record.phone)
      const interval = this.options.sendCodeIntervalMs ?? 60000
      if (previous !== undefined && Date.now() - previous < interval) {
        throw new RpcError(420, `FLOOD_WAIT_${Math.ceil((interval - Date.now() + previous) / 1000)}`)
      }
      this.rates.set(entry.record.phone, Date.now())
    }
    let response: unknown
    try { response = await entry.client.call(request._ === 'upload.getFile' ? { ...request, cdnSupported: false } : request) }
    catch (error) {
      // Deliberately preserve only structured RPC errors; never echo arbitrary errors/credentials.
      const e = error as { code?: number, errorMessage?: string, text?: string }
      const text = e.text ?? e.errorMessage
      if (Number.isInteger(e.code) && typeof text === 'string' && /^[A-Z0-9_]+$/.test(text)) {
        throw new RpcError(e.code!, text)
      }
      throw new RpcError(502, 'GATEWAY_UPSTREAM_UNAVAILABLE')
    }
    if (request._ === 'auth.logOut') {
      for (const id of await this.dependencies.store.family(key)) {
        const member = await this.entries.get(id)
        member?.removeListener()
        await member?.client.destroy()
        this.entries.delete(id)
        this.selections.delete(id)
        await this.dependencies.store.remove(id)
      }
    }
    return normalizeResult(response)
  }

  private async select(rpc: ServerRpcContext, request: tl.RpcMethod, key: string, rawKey: string): Promise<Entry | undefined> {
    if (await this.dependencies.isLocalKey(rawKey)) return
    let record = await this.dependencies.store.load(key)
    if (!record) {
      if (await this.dependencies.store.hasSession(key)) throw new RpcError(500, 'GATEWAY_STATE_INCONSISTENT')
      if (request._ === 'auth.importAuthorization') {
        try {
          const ticket = await this.dependencies.store.importTicket(request.bytes, String(request.id), rpc.dcId)
          record = { ...ticket.record, importTicketHash: createHash('sha256').update(request.bytes).digest('hex') }
          if (!this.allowed.has(record.phone)) throw new Error('Revoked phone')
          await this.dependencies.store.save(key, record)
        } catch { throw new RpcError(400, 'AUTH_BYTES_INVALID') }
      }
      if (!record && request._ !== 'auth.sendCode') return
      if (!record && request._ === 'auth.sendCode') {
        const phone = normalizePhone(request.phoneNumber)
        // DB lookup, not a guessed prefix: real Fragment numbers can also start with 888.
        if (await this.dependencies.isVirtualPhone(phone)) return
        if (!this.allowed.has(phone)) throw new RpcError(403, 'GATEWAY_PHONE_NOT_ALLOWED')
        if (!Number.isSafeInteger(request.apiId) || request.apiId < 1 || !/^[a-f\d]{32}$/i.test(request.apiHash)) {
          throw new RpcError(400, 'API_ID_INVALID')
        }
        record = { version: 1, phone, apiId: request.apiId, apiHash: request.apiHash, clientInfo: rpc.clientInfo, dcId: rpc.dcId }
        await this.dependencies.store.save(key, record)
      }
    }
    // Revoking an allow-list entry also revokes access through existing persisted routes.
    if (!this.allowed.has(record.phone)) throw new RpcError(403, 'GATEWAY_PHONE_NOT_ALLOWED')
    if (this.entries.size > (this.options.maxSessions ?? 20)) throw new RpcError(503, 'GATEWAY_SESSION_LIMIT')
    const client = await this.dependencies.createUpstream(key, structuredClone(record))
    const removeListener = client.onUpdate(update => {
      if (!this.stopped) this.dependencies.push(rpc.authKeyId!, update)
    })
    return { client, record, removeListener }
  }

  async stop() {
    this.stopped = true
    const entries = await Promise.allSettled(this.entries.values())
    await Promise.all(entries.map(async result => {
      if (result.status === 'fulfilled' && result.value) {
        result.value.removeListener()
        await result.value.client.destroy()
      }
    }))
    this.entries.clear()
    this.selections.clear()
  }
}

export function normalizePhone(phone: string): string {
  const normalized = phone.replace(/[+\s()-]/g, '')
  if (!/^[1-9]\d{4,14}$/.test(normalized)) throw new RpcError(400, 'PHONE_NUMBER_INVALID')
  return normalized
}
export function normalizeResult(value: unknown): RpcResult {
  if (typeof value === 'boolean') return { _: value ? 'boolTrue' : 'boolFalse' }
  if (Array.isArray(value)) return bareVector(value as tl.TlObject[])
  if (value && typeof value === 'object' && '_' in value) return value as RpcResult
  throw new RpcError(502, 'GATEWAY_INVALID_UPSTREAM_RESULT')
}
export function createUpstreamFactory(store: RouteStore, network: { defaultDcs?: DcOptions } = {}): UpstreamFactory {
  return async (key, record) => {
    const storage = await store.sessionPath(key)
    const hadSession = (await stat(storage)).size > 0
    const client = new TelegramClient({
      ...network, apiId: record.apiId, apiHash: record.apiHash, storage,
      updates: false, logLevel: 0,
      initConnectionOptions: record.clientInfo ? {
        deviceModel: record.clientInfo.deviceModel, systemVersion: record.clientInfo.systemVersion,
        appVersion: record.clientInfo.appVersion, systemLangCode: record.clientInfo.systemLangCode,
        langPack: record.clientInfo.langPack, langCode: record.clientInfo.langCode,
      } : undefined,
    })
    try {
      if (!hadSession && record.seedSession) await client.importSession(record.seedSession)
      else if (!hadSession && record.dcId !== undefined && record.dcId !== await client.getPrimaryDcId()) await client.changePrimaryDc(record.dcId)
    } catch (error) { await client.destroy(); throw error }
    // No start()/getMe()/login prompts. Forward the client's own auth RPCs unchanged.
    return {
      call: request => client.call(request, { timeout: 30000, maxRetryCount: 0, floodSleepThreshold: 0 }),
      onUpdate: handler => { client.onServerUpdate.add(handler); return () => client.onServerUpdate.remove(handler) },
      destroy: () => client.destroy(),
      exportSession: () => client.exportSession(),
      primaryDcId: () => client.getPrimaryDcId(),
    }
  }
}
