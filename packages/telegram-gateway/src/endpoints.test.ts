import { it, expect } from 'vitest'
import type { tl } from '@mtcute/core'
import { rewriteOptions, rewriteUpdate } from './endpoints.js'
const official: tl.RawDcOption[] = [{ _: 'dcOption', id: 3, ipAddress: '149.154.175.100', port: 443, secret: Uint8Array.of(1) }, { _: 'dcOption', id: 201, ipAddress: '149.154.175.101', port: 443, cdn: true }]
const local = { ipAddress: '192.0.2.1', port: 4430 }
it('preserves DC identity but removes official endpoints, CDN routes and transport secrets', () => {
  expect(rewriteOptions(official, local)).toEqual([{ _: 'dcOption', id: 3, ...local, ipv6: undefined, secret: undefined, tcpoOnly: false }])
  expect(official[0].ipAddress).toBe('149.154.175.100')
})
it('rewrites pushed DC configs and fails closed before a local endpoint is known', () => {
  const update: tl.TypeUpdates = { _: 'updateShort', date: 1800000000, update: { _: 'updateDcOptions', dcOptions: official } }
  expect(rewriteUpdate(update)).toEqual({ _: 'updatesTooLong' })
  expect(rewriteUpdate(update, local)).toMatchObject({ update: { dcOptions: [{ id: 3, ipAddress: '192.0.2.1' }] } })
})
