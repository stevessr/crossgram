import type { tl } from '@mtcute/core'
import type { RpcResult, CordisServerRpcContext } from '@mtproto-relay/mtproto'
import type { Context } from 'cordis'
import type {} from '@mtproto-relay/bridge'
import z from 'schemastery'
import { TelegramGateway, createUpstreamFactory } from './gateway.js'
import { rewriteOptions, rewriteUpdate, type GatewayEndpoint } from './endpoints.js'
import { RouteStore } from './store.js'
export * from './gateway.js'
export * from './store.js'

export interface Config { enabled?: boolean, storage: string, allowedPhones: string[], maxSessions?: number, sendCodeIntervalMs?: number }
export const Config = z.object({
  enabled: z.boolean().default(false),
  storage: z.string().required(),
  allowedPhones: z.array(z.string()).default([]),
  maxSessions: z.natural().min(1).default(20),
  sendCodeIntervalMs: z.natural().min(1000).default(60000),
})
export const name = 'telegram-rpc-gateway'
export const inject = ['mtproto', 'mtprotoBridge', 'database']
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  if (!config.allowedPhones.length) throw new Error('Experimental Telegram gateway requires an explicit phone allow-list')
  const store = new RouteStore(config.storage)
  await store.init()
  let endpoint: GatewayEndpoint | undefined
  const gateway = new TelegramGateway(config, {
    store, createUpstream: createUpstreamFactory(store),
    isVirtualPhone: async phone => Boolean((await ctx.database.get('mtproto_auth_session', { virtualPhone: phone })).length),
    isLocalKey: async authKeyId => Boolean((await ctx.database.get('mtproto_auth_binding', { authKeyId })).length),
    push: (key, update) => { ctx.mtproto.sendUpdateToAuthKey(key, rewriteUpdate(update, endpoint)) },
  })
  ctx.effect(() => () => gateway.stop())
  ctx.on('mtproto/rpc', createGatewayMiddleware(gateway, value => { endpoint = value }), { prepend: true })
}

/** Shared by production and the double-ended encrypted-socket regression suite. */
export function createGatewayMiddleware(gateway: TelegramGateway, onEndpoint?: (endpoint: GatewayEndpoint) => void) {
  return async function (this: CordisServerRpcContext, request: tl.RpcMethod, next: () => Promise<RpcResult | undefined>): Promise<RpcResult | undefined> {
    const response = await gateway.route(this, request)
    if (request._ === 'help.getConfig') {
      const local = await next() as tl.RawConfig
      const endpoint = local.dcOptions.find(option => !option.ipv6 && !option.cdn)
      if (!endpoint) throw new Error('Gateway has no advertised local endpoint')
      onEndpoint?.(endpoint)
      if (response?._ === 'config') return { ...response, thisDc: this.dcId ?? response.thisDc, dcOptions: rewriteOptions(response.dcOptions, endpoint) }
      if (response === undefined) return { ...local, thisDc: this.dcId ?? local.thisDc, dcOptions: [1, 2, 3, 4, 5].map(id => ({
        _: 'dcOption', ...endpoint, id, tcpoOnly: false, static: true,
      })) }
    }
    if (response === undefined) return await next() as RpcResult
    return response
  }
}
