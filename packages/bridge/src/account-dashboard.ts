import type { ProvisionedPlatformAccount } from './platform-account.js'
import { getLoginCodeState, type IssuedLoginCode } from './login-code.js'
import { isValidSrpVerifier } from './login-srp.js'

import type { CrossGramServerConfig, PlatformAccountStatus, PlatformAccountView } from './dashboard-types.js'
export type { CrossGramServerConfig, CrossGramServerConfigDc, PlatformAccountDashboardData, PlatformAccountStatus, PlatformAccountView } from './dashboard-types.js'

export function makeCrossGramServerConfig(
  host: string,
  port: number,
  publicKeyPem: string,
): CrossGramServerConfig {
  return {
    name: 'CrossGram',
    enable_special_config: false,
    host,
    port,
    rsa_key: publicKeyPem.trim(),
    dcs: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, ip: host, port })),
  }
}

export function makePlatformAccountView(
  platformId: string,
  platformKind: string,
  account: ProvisionedPlatformAccount,
  apiPrefix: string,
  now = Date.now(),
  issuedCode?: IssuedLoginCode | null,
): PlatformAccountView {
  const code = issuedCode === undefined ? getLoginCodeState(account.auth.totpSecret, now) : issuedCode
  const profile = account.profile
  return {
    platformId,
    platformKind,
    status: 'ready',
    displayName: [profile.firstName, profile.lastName].filter(Boolean).join(' '),
    firstName: profile.firstName,
    lastName: profile.lastName,
    username: profile.username,
    userId: profile.id,
    avatarUrl: profile.avatar
      ? `${apiPrefix}/platforms/${encodeURIComponent(platformId)}/avatar?v=${encodeURIComponent(profile.avatar.id)}`
      : undefined,
    virtualPhone: `+${account.auth.virtualPhone}`,
    loginCode: code?.code,
    validUntil: code?.validUntil,
    remainingSeconds: code?.remainingSeconds,
    hasPassword: isValidSrpVerifier(account.auth.passwordSrp),
  }
}

export function makeUnavailableAccountView(
  platformId: string,
  platformKind: string,
  status: Exclude<PlatformAccountStatus, 'ready'>,
  error?: unknown,
): PlatformAccountView {
  return {
    platformId,
    platformKind,
    status,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
  }
}
