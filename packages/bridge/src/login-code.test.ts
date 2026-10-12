import { describe, expect, it } from 'vitest'
import {
  generateLoginCode, getLoginCodeState, LOGIN_CODE_PERIOD_SECONDS, verifyLoginCode,
  OnDemandLoginCodeStore, ON_DEMAND_LOGIN_CODE_TTL_MS,
} from './login-code.js'

const rfcSecret = Buffer.from('12345678901234567890').toString('hex')

describe('30-second platform login code', () => {
  it('implements the RFC 6238 SHA-1 vectors truncated to six digits', () => {
    expect(generateLoginCode(rfcSecret, 59_000)).toBe('287082')
    expect(generateLoginCode(rfcSecret, 1_111_111_109_000)).toBe('081804')
    expect(generateLoginCode(rfcSecret, 1_234_567_890_000)).toBe('005924')
  })

  it('changes exactly at a 30-second boundary and reports its countdown', () => {
    expect(LOGIN_CODE_PERIOD_SECONDS).toBe(30)
    const before = getLoginCodeState(rfcSecret, 29_001)
    const after = getLoginCodeState(rfcSecret, 30_000)
    expect(before).toMatchObject({ period: 0, validUntil: 30_000, remainingSeconds: 1 })
    expect(after).toMatchObject({ period: 1, validUntil: 60_000, remainingSeconds: 30 })
    expect(before.code).not.toBe(after.code)
  })

  it('accepts only the current six-digit value', () => {
    const now = 61_000
    expect(verifyLoginCode(rfcSecret, generateLoginCode(rfcSecret, now), now)).toBe(true)
    expect(verifyLoginCode(rfcSecret, generateLoginCode(rfcSecret, 29_000), now)).toBe(false)
    expect(verifyLoginCode(rfcSecret, '12345', now)).toBe(false)
    expect(verifyLoginCode(rfcSecret, 'abcdef', now)).toBe(false)
  })
})

describe('on-demand platform login codes', () => {
  it('does not generate a code until asked and does not rotate while active', () => {
    const store = new OnDemandLoginCodeStore()
    expect(store.get('account', 1_000)).toBeUndefined()
    const issued = store.issue('account', 1_000)
    expect(issued.code).toMatch(/^\d{6}$/)
    expect(issued.code).not.toBe('000000')
    expect(issued.validUntil).toBe(1_000 + ON_DEMAND_LOGIN_CODE_TTL_MS)
    expect(store.get('account', 100_000)?.code).toBe(issued.code)
    expect(store.issue('account', 100_000).code).toBe(issued.code)
    expect(store.get('other', 100_000)).toBeUndefined()
  })

  it('rejects unknown, expired and malformed codes; consumes successful codes once', () => {
    const store = new OnDemandLoginCodeStore()
    const issued = store.issue('account', 1_000)
    expect(store.consume('other', issued.code, 2_000)).toBe(false)
    expect(store.consume('account', 'invalid', 2_000)).toBe(false)
    expect(store.consume('account', '12345', 2_000)).toBe(false)
    expect(store.consume('account', issued.code, 1_000 + ON_DEMAND_LOGIN_CODE_TTL_MS)).toBe(false)
    expect(store.get('account', 1_000 + ON_DEMAND_LOGIN_CODE_TTL_MS)).toBeUndefined()
    const renewed = store.issue('account', 400_000)
    expect(store.consume('account', renewed.code, 400_001)).toBe(true)
    expect(store.consume('account', renewed.code, 400_002)).toBe(false)
  })

  it('reissues a code only on explicit replacement and immediately invalidates the old one', () => {
    const store = new OnDemandLoginCodeStore()
    const issued = store.issue('account', 1_000)
    const renewed = store.issue('account', 2_000, true)
    expect(renewed.validUntil).toBe(2_000 + ON_DEMAND_LOGIN_CODE_TTL_MS)
    expect(renewed.code).not.toBe(issued.code)
    expect(store.get('account', 2_001)?.code).toBe(renewed.code)
    expect(store.get('account', 2_001)?.remainingSeconds).toBe(300)
    // A rare random collision of six digits is possible; still only one
    // current entry and one successful consumption can exist.
    expect(store.consume('account', renewed.code, 2_002)).toBe(true)
    expect(store.consume('account', issued.code, 2_003)).toBe(false)
  })
})
