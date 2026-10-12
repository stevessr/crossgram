import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const LOGIN_CODE_PERIOD_SECONDS = 30
export const LOGIN_CODE_DIGITS = 6

export interface LoginCodeState {
  code: string
  period: number
  validUntil: number
  remainingSeconds: number
}

/** Generate a process-independent secret suitable for RFC 6238 TOTP. */
export function generateLoginSecret(): string {
  return randomBytes(20).toString('hex')
}

/** Return the six-digit RFC 6238 code for a hexadecimal secret. */
export function generateLoginCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / LOGIN_CODE_PERIOD_SECONDS)
  const input = Buffer.alloc(8)
  input.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', Buffer.from(secret, 'hex')).update(input).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  return String(binary % 10 ** LOGIN_CODE_DIGITS).padStart(LOGIN_CODE_DIGITS, '0')
}

/** Verify only the currently displayed period, matching the Cordis countdown. */
export function verifyLoginCode(secret: string, candidate: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(candidate)) return false
  const expected = Buffer.from(generateLoginCode(secret, now))
  return timingSafeEqual(expected, Buffer.from(candidate))
}

export function getLoginCodeState(secret: string, now = Date.now()): LoginCodeState {
  const period = Math.floor(now / 1000 / LOGIN_CODE_PERIOD_SECONDS)
  const validUntil = (period + 1) * LOGIN_CODE_PERIOD_SECONDS * 1000
  return {
    code: generateLoginCode(secret, now),
    period,
    validUntil,
    remainingSeconds: Math.max(1, Math.ceil((validUntil - now) / 1000)),
  }
}

/** Login codes in on-demand mode are generated only after an explicit request. */
export const ON_DEMAND_LOGIN_CODE_TTL_MS = 5 * 60_000

export interface IssuedLoginCode {
  code: string
  validUntil: number
  remainingSeconds: number
}

/**
 * Transient, single-use codes for platform identities. Never persisted; after a
 * restart clients must request a new code. Merely reading a code never issues one.
 */
export class OnDemandLoginCodeStore {
  private readonly _codes = new Map<string, { code: string, validUntil: number }>()

  issue(authId: string, now = Date.now(), replace = false): IssuedLoginCode {
    const existing = this.get(authId, now)
    if (existing && !replace) return existing
    // 000000 is reserved by the legacy SRP second-factor login path.
    const code = String(randomInt(1, 10 ** LOGIN_CODE_DIGITS)).padStart(LOGIN_CODE_DIGITS, '0')
    const validUntil = now + ON_DEMAND_LOGIN_CODE_TTL_MS
    this._codes.set(authId, { code, validUntil })
    return { code, validUntil, remainingSeconds: Math.ceil(ON_DEMAND_LOGIN_CODE_TTL_MS / 1000) }
  }

  get(authId: string, now = Date.now()): IssuedLoginCode | undefined {
    const entry = this._codes.get(authId)
    if (!entry) return
    if (now >= entry.validUntil) {
      this._codes.delete(authId)
      return
    }
    return {
      code: entry.code,
      validUntil: entry.validUntil,
      remainingSeconds: Math.ceil((entry.validUntil - now) / 1000),
    }
  }

  /** Consume before authorization, so parallel sign-in attempts cannot reuse it. */
  consume(authId: string, candidate: string, now = Date.now()): boolean {
    const entry = this.get(authId, now)
    if (!entry || !/^\\d{6}$/.test(candidate)) return false
    if (!timingSafeEqual(Buffer.from(entry.code), Buffer.from(candidate))) return false
    this._codes.delete(authId)
    return true
  }
}
