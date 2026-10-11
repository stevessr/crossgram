/**
 * CrossGram-native client device identity exchange and explicit key pinning.
 *
 * This is NOT the Telegram Secret Chat protocol. Public bundles can travel
 * through an untrusted relay, but trust MUST be established over an independent,
 * authenticated channel before the local client accepts them.
 */
import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto'
import {
  deviceFingerprint, type DeviceIdentity, type VerifiedDevice,
  sealMessage, openMessage, parseEnvelope,
  type EncryptedEnvelope, type ReplayGuard,
} from './envelope.js'

export interface PublicDeviceBundle {
  v: 1
  deviceId: string
  /** DER SubjectPublicKeyInfo, unpadded base64url. */
  ed25519: string
  /** DER SubjectPublicKeyInfo, unpadded base64url. */
  x25519: string
}

export interface DevicePinStore {
  /** Must be stored on the END-USER DEVICE, never on CrossGram infrastructure. */
  get(accountId: string, deviceId: string): Promise<PublicDeviceBundle | undefined>
  /**
   * Atomically insert on first use. Must NOT overwrite existing pins.
   * Return the actually persisted value, so concurrent key substitutions fail.
   */
  pinIfAbsent(accountId: string, bundle: PublicDeviceBundle): Promise<PublicDeviceBundle>
  /** Explicit local revocation, ideally gated by a verified user action. */
  revoke(accountId: string, deviceId: string): Promise<void>
}

/** Only for unit tests / demos. Production clients must use durable secure storage. */
export class MemoryDevicePinStore implements DevicePinStore {
  private readonly pins = new Map<string, PublicDeviceBundle>()
  private key(account: string, device: string): string {
    validateIdentifier(account)
    validateIdentifier(device)
    return JSON.stringify([account, device])
  }

  async get(accountId: string, deviceId: string): Promise<PublicDeviceBundle | undefined> {
    const existing = this.pins.get(this.key(accountId, deviceId))
    return existing ? { ...existing } : undefined
  }

  async pinIfAbsent(accountId: string, bundle: PublicDeviceBundle): Promise<PublicDeviceBundle> {
    const key = this.key(accountId, bundle.deviceId)
    if (!this.pins.has(key)) this.pins.set(key, { ...bundle })
    return { ...this.pins.get(key)! }
  }

  async revoke(accountId: string, deviceId: string): Promise<void> {
    this.pins.delete(this.key(accountId, deviceId))
  }
}

/** Export only device public keys, NEVER the private key objects. */
export function exportDeviceBundle(device: VerifiedDevice | DeviceIdentity): PublicDeviceBundle {
  validateIdentifier(device.deviceId)
  assertPublic(device.signingPublicKey, 'ed25519')
  assertPublic(device.agreementPublicKey, 'x25519')
  return {
    v: 1,
    deviceId: device.deviceId,
    ed25519: encodePublic(device.signingPublicKey),
    x25519: encodePublic(device.agreementPublicKey),
  }
}

/** Check the public key wire format before allowing an identity into storage. */
export function parseDeviceBundle(input: unknown): VerifiedDevice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  }
  const value = input as Record<string, unknown>
  if (value.v !== 1 || Object.keys(value).length !== 4
    || typeof value.deviceId !== 'string'
    || typeof value.ed25519 !== 'string' || typeof value.x25519 !== 'string') {
    throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  }
  validateIdentifier(value.deviceId)
  return {
    deviceId: value.deviceId,
    signingPublicKey: parsePublic(value.ed25519, 'ed25519'),
    agreementPublicKey: parsePublic(value.x25519, 'x25519'),
  }
}

/**
 * Fingerprint for QR-code or in-person safety-number verification.
 * DO NOT compare to a value fetched from the same untrusted server!
 */
export function bundleFingerprint(bundle: unknown): string {
  return deviceFingerprint(parseDeviceBundle(bundle))
}

/**
 * Safety number for the EXACT account/device binding. In the verification UI
 * show the account and device identifiers alongside this fingerprint.
 * Never trust a value fetched from the same directory server as the keys.
 */
export function accountDeviceFingerprint(accountId: string, bundle: unknown): string {
  validateIdentifier(accountId)
  const device = parseDeviceBundle(bundle)
  return createHash('sha256').update(JSON.stringify([
    'crossgram/account-device-binding/v1', accountId, deviceFingerprint(device),
  ])).digest('hex')
}

/**
 * A user-verified public bundle is pinned for an ACCOUNT + device ID.
 * On key rotation, fail closed: the user must explicitly revoke the previous
 * pin and verify a fresh fingerprint via an independent channel.
 */
export async function verifyAndPinDevice(
  store: DevicePinStore,
  accountId: string,
  untrustedBundle: unknown,
  independentlyVerifiedFingerprint: string,
): Promise<VerifiedDevice> {
  validateIdentifier(accountId)
  const device = parseDeviceBundle(untrustedBundle)
  const expected = fingerprintBytes(independentlyVerifiedFingerprint)
  const actual = Buffer.from(accountDeviceFingerprint(accountId, exportDeviceBundle(device)), 'hex')
  if (!timingSafeEqual(expected, actual)) throw new Error('E2EE_FINGERPRINT_MISMATCH')
  const canonical = exportDeviceBundle(device)
  const stored = await store.pinIfAbsent(accountId, canonical)
  if (!bundlesEqual(canonical, stored)) throw new Error('E2EE_DEVICE_KEY_CHANGED')
  return device
}

/** Retrieve only previously verified pinned keys, not directory-supplied keys. */
export async function getPinnedDevice(
  store: DevicePinStore,
  accountId: string,
  deviceId: string,
): Promise<VerifiedDevice> {
  validateIdentifier(accountId)
  validateIdentifier(deviceId)
  const bundle = await store.get(accountId, deviceId)
  if (!bundle) throw new Error('E2EE_DEVICE_UNVERIFIED')
  const device = parseDeviceBundle(bundle)
  if (device.deviceId !== deviceId) throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  return device
}

/**
 * Encrypt once per independently trusted recipient device (no implicit
 * enrollment). Caller transports these opaque envelopes without exposing
 * plaintext to the relay.
 */
export async function sealToPinnedDevices(
  plaintext: Uint8Array,
  conversationId: string,
  sender: DeviceIdentity,
  store: DevicePinStore,
  recipientAccountId: string,
  recipientDeviceIds: readonly string[],
  senderAccountId: string,
): Promise<EncryptedEnvelope[]> {
  validateIdentifier(senderAccountId)
  if (!recipientDeviceIds.length) throw new Error('E2EE_NO_RECIPIENT_DEVICES')
  if (recipientDeviceIds.length > 32) throw new Error('E2EE_TOO_MANY_RECIPIENT_DEVICES')
  const unique = new Set(recipientDeviceIds)
  if (unique.size !== recipientDeviceIds.length) throw new Error('E2EE_DUPLICATE_RECIPIENT_DEVICE')
  // Resolve every device BEFORE producing any ciphertext; fail closed if one
  // has not been independently authenticated.
  const devices = await Promise.all(recipientDeviceIds.map(
    id => getPinnedDevice(store, recipientAccountId, id),
  ))
  return devices.map(device => sealMessage(plaintext, conversationId, sender, device, {
    senderAccountId,
    recipientAccountId,
  }))
}

/**
 * Resolve a sender from independently pinned local keys, then authenticate and
 * decrypt. A server-supplied unknown device is never silently accepted.
 */
export async function openFromPinnedDevice(
  untrustedEnvelope: unknown,
  conversationId: string,
  recipient: DeviceIdentity,
  store: DevicePinStore,
  senderAccountId: string,
  replayGuard: ReplayGuard,
  recipientAccountId: string,
): Promise<Uint8Array> {
  validateIdentifier(recipientAccountId)
  const envelope = parseEnvelope(untrustedEnvelope)
  const sender = await getPinnedDevice(store, senderAccountId, envelope.senderDeviceId)
  return openMessage(envelope, conversationId, recipient, sender, replayGuard, {
    senderAccountId,
    recipientAccountId,
  })
}

function validateIdentifier(value: string): void {
  if (typeof value !== 'string' || !value.trim()
    || Buffer.byteLength(value, 'utf8') > 256) throw new Error('E2EE_INVALID_ID')
}

function encodePublic(key: VerifiedDevice['signingPublicKey']): string {
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url')
}

function assertPublic(key: VerifiedDevice['signingPublicKey'], algorithm: string): void {
  if (key.type !== 'public' || key.asymmetricKeyType !== algorithm) {
    throw new Error('E2EE_INVALID_PUBLIC_KEY')
  }
}

function parsePublic(encoded: string, algorithm: string): VerifiedDevice['signingPublicKey'] {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 172) {
    throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  }
  const der = Buffer.from(encoded, 'base64url')
  if (der.length > 128 || der.toString('base64url') !== encoded) {
    throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  }
  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  }
  assertPublic(key, algorithm)
  if (!Buffer.from(key.export({ format: 'der', type: 'spki' })).equals(der)) {
    throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
  }
  return key
}

function fingerprintBytes(value: string): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('E2EE_INVALID_FINGERPRINT')
  }
  return Buffer.from(value, 'hex')
}

function bundlesEqual(a: PublicDeviceBundle, b: PublicDeviceBundle): boolean {
  const canonical = exportDeviceBundle(parseDeviceBundle(b))
  return a.v === canonical.v && a.deviceId === canonical.deviceId
    && a.ed25519 === canonical.ed25519 && a.x25519 === canonical.x25519
}
