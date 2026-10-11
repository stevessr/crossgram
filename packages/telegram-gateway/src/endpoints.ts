import type { tl } from '@mtcute/core'

export type GatewayEndpoint = Pick<tl.RawDcOption, 'ipAddress' | 'port' | 'ipv6'>
export function rewriteOptions(options: tl.RawDcOption[], endpoint: GatewayEndpoint): tl.RawDcOption[] {
  return options.filter(option => !option.cdn).map(option => ({
    ...option, ipAddress: endpoint.ipAddress, port: endpoint.port, ipv6: endpoint.ipv6, secret: undefined, tcpoOnly: false,
  }))
}
/** Never let an upstream pushed configuration reintroduce a direct official endpoint. */
export function rewriteUpdate(update: tl.TypeUpdates, endpoint?: GatewayEndpoint): tl.TypeUpdates {
  const rewrite = (value: tl.TypeUpdate): tl.TypeUpdate | undefined => {
    if (value._ !== 'updateDcOptions') return value
    if (!endpoint) return undefined
    return { ...value, dcOptions: rewriteOptions(value.dcOptions, endpoint) }
  }
  if (update._ === 'updates' || update._ === 'updatesCombined') {
    return { ...update, updates: update.updates.map(rewrite).filter((value): value is tl.TypeUpdate => value !== undefined) }
  }
  if (update._ === 'updateShort') {
    const value = rewrite(update.update)
    return value ? { ...update, update: value } : { _: 'updatesTooLong' }
  }
  return update
}
