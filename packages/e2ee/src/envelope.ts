/**
 * Experimental client-side encryption envelope for CrossGram-native peers.
 *
 * Never call this from the bridge server with server-owned private keys.
 * This is NOT compatible with Telegram Secret Chats or Matrix Olm/Megolm.
 * See docs/E2EE.zh.md before enabling it in any client.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify,
  type KeyObject,
} from 'node:crypto'

const VERSION = 1
const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_ID_BYTES = 256
const AAD_DOMAIN = 'crossgram/e2ee-envelope/v1'

export interface DeviceIdentity {
  /** Private keys MUST be created and persisted by the end-user device only. */
  deviceId: string
  signingPrivateKey: KeyObject
  signingPublicKey: KeyObject
  agreementPrivateKey: KeyObject
  agreementPublicKey: KeyObject
}

export interface VerifiedDevice {
  /** The binding to the user account MUST be authenticated outside this module. */
  deviceId: string
  signingPublicKey: KeyObject
  agreementPublicKey: KeyObject
}

export interface EncryptedEnvelope {
  v: 1
  /** Associated-data context, e.g. an authenticated conversation identifier. */
  conversationId: string
  senderDeviceId: string
  recipientDeviceId: string
  /** Hash of the device's X25519 SPKI public key. */
  recipientKeyId: string
  ephemeralPublicKey: string
  salt: string
  nonce: string
  ciphertext: string
  tag: string
  /** Detached Ed25519 signature over the entire signed envelope. */
  signature: string
}

/** A durable implementation must atomically accept a new ID only once. */
export interface ReplayGuard {
  acceptOnce(messageId: string): Promise<boolean>
}

/** Test/demo guard only: state is lost at process restart; do not use in production. */
export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Set<string>()
  async acceptOnce(messageId: string): Promise<boolean> {
    if (this.seen.has(messageId)) return false
    this.seen.add(messageId)
    return true
  }
}

export function generateDeviceIdentity(deviceId: string): DeviceIdentity {
  checkId(deviceId)
  const signing = generateKeyPairSync('ed25519')
  const agreement = generateKeyPairSync('x25519')
  return {
    deviceId,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
  }
}

export function publicDevice(identity: DeviceIdentity): VerifiedDevice {
  return {
    deviceId: identity.deviceId,
    signingPublicKey: identity.signingPublicKey,
    agreementPublicKey: identity.agreementPublicKey,
  }
}

/**
 * SHA-256 fingerprint for independent (e.g. QR-code) device verification.
 * This is NOT an identity proof unless users actually compare the result.
 */
export function deviceFingerprint(device: VerifiedDevice): string {
  checkPublicKey(device.signingPublicKey, 'ed25519')
  checkPublicKey(device.agreementPublicKey, 'x25519')
  const keys = [
    device.deviceId,
    publicDer(device.signingPublicKey).toString('base64url'),
    publicDer(device.agreementPublicKey).toString('base64url'),
  ]
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex')
}

/** Seal bytes before they reach any CrossGram server or external adapter. */
export function sealMessage(
  plaintext: Uint8Array,
  conversationId: string,
  sender: DeviceIdentity,
  recipient: VerifiedDevice,
): EncryptedEnvelope {
  checkId(conversationId)
  checkId(sender.deviceId)
  checkId(recipient.deviceId)
  checkPublicKey(recipient.agreementPublicKey, 'x25519')
  checkPrivateKey(sender.signingPrivateKey, 'ed25519')
  if (plaintext.byteLength > MAX_MESSAGE_BYTES) throw new Error('E2EE_MESSAGE_TOO_LARGE')
  const ephemeral = generateKeyPairSync('x25519')
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const secret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient.agreementPublicKey,
  })
  const envelope: EncryptedEnvelope = {
    v: VERSION,
    conversationId,
    senderDeviceId: sender.deviceId,
    recipientDeviceId: recipient.deviceId,
    recipientKeyId: keyId(recipient.agreementPublicKey),
    ephemeralPublicKey: publicDer(ephemeral.publicKey).toString('base64url'),
    salt: salt.toString('base64url'),
    nonce: nonce.toString('base64url'),
    ciphertext: '',
    tag: '',
    signature: '',
  }
  const key = deriveKey(secret, salt, envelope)
  secret.fill(0)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(headerBytes(envelope))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  key.fill(0)
  envelope.ciphertext = ciphertext.toString('base64url')
  envelope.tag = cipher.getAuthTag().toString('base64url')
  envelope.signature = sign(null, signedBytes(envelope), sender.signingPrivateKey).toString('base64url')
  return envelope
}

/**
 * Decrypt ONLY with a separately authenticated/pinned sender device bundle.
 * Rejects cross-conversation injection, invalid signatures, modified fields,
 * wrong recipients and duplicate envelopes. The guard MUST be durable and
 * atomic for real clients.
 */
export async function openMessage(
  candidate: unknown,
  conversationId: string,
  recipient: DeviceIdentity,
  pinnedSender: VerifiedDevice,
  replayGuard: ReplayGuard,
): Promise<Uint8Array> {
  const envelope = parseEnvelope(candidate)
  checkId(conversationId)
  checkId(recipient.deviceId)
  checkId(pinnedSender.deviceId)
  checkPublicKey(pinnedSender.signingPublicKey, 'ed25519')
  checkPrivateKey(recipient.agreementPrivateKey, 'x25519')
  if (
    envelope.conversationId !== conversationId
    || envelope.recipientDeviceId !== recipient.deviceId
    || envelope.senderDeviceId !== pinnedSender.deviceId
  ) throw new Error('E2EE_CONTEXT_MISMATCH')
  if (envelope.recipientKeyId !== keyId(createPublicKey(recipient.agreementPrivateKey))) {
    throw new Error('E2EE_RECIPIENT_KEY_MISMATCH')
  }
  const signature = decode(envelope.signature, 64)
  if (!verify(null, signedBytes(envelope), pinnedSender.signingPublicKey, signature)) {
    throw new Error('E2EE_SIGNATURE_INVALID')
  }
  const ephemeral = createPublicKey({ key: decode(envelope.ephemeralPublicKey, 128), format: 'der', type: 'spki' })
  checkPublicKey(ephemeral, 'x25519')
  const salt = decode(envelope.salt, 32)
  const nonce = decode(envelope.nonce, 12)
  const ciphertext = decode(envelope.ciphertext, MAX_MESSAGE_BYTES, true)
  const tag = decode(envelope.tag, 16)
  const secret = diffieHellman({ privateKey: recipient.agreementPrivateKey, publicKey: ephemeral })
  const key = deriveKey(secret, salt, envelope)
  secret.fill(0)
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(headerBytes(envelope))
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } finally {
    key.fill(0)
  }
  const replayId = createHash('sha256').update(signedBytes(envelope)).update(signature).digest('hex')
  if (!await replayGuard.acceptOnce(replayId)) {
    plaintext.fill(0)
    throw new Error('E2EE_REPLAY_DETECTED')
  }
  return plaintext
}

/** Strict parsing before any asymmetric or memory-intensive operation. */
export function parseEnvelope(candidate: unknown): EncryptedEnvelope {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('E2EE_MALFORMED_ENVELOPE')
  }
  const value = candidate as Record<string, unknown>
  const fields = ['conversationId', 'senderDeviceId', 'recipientDeviceId',
    'recipientKeyId', 'ephemeralPublicKey', 'salt', 'nonce', 'ciphertext', 'tag', 'signature'] as const
  if (value.v !== VERSION || Object.keys(value).length !== fields.length + 1
      || fields.some(field => typeof value[field] !== 'string')) {
    throw new Error('E2EE_MALFORMED_ENVELOPE')
  }
  const e = value as unknown as EncryptedEnvelope
  checkId(e.conversationId)
  checkId(e.senderDeviceId)
  checkId(e.recipientDeviceId)
  decode(e.recipientKeyId, 32)
  decode(e.ephemeralPublicKey, 128)
  decode(e.salt, 32)
  decode(e.nonce, 12)
  decode(e.ciphertext, MAX_MESSAGE_BYTES, true)
  decode(e.tag, 16)
  decode(e.signature, 64)
  return e
}

function checkId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES) {
    throw new Error('E2EE_INVALID_ID')
  }
}

function checkPublicKey(key: KeyObject, algorithm: string): void {
  if (key.type !== 'public' || key.asymmetricKeyType !== algorithm) throw new Error('E2EE_INVALID_PUBLIC_KEY')
}

function checkPrivateKey(key: KeyObject, algorithm: string): void {
  if (key.type !== 'private' || key.asymmetricKeyType !== algorithm) throw new Error('E2EE_INVALID_PRIVATE_KEY')
}

function publicDer(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }) as Buffer
}

function keyId(publicKey: KeyObject): string {
  return createHash('sha256').update(publicDer(publicKey)).digest('base64url')
}

function decode(value: string, maxLength: number, allowEmpty = false): Buffer {
  if (typeof value !== 'string' || (!value && !allowEmpty)
      || !/^[A-Za-z0-9_-]*$/.test(value)
      || value.length > Math.ceil(maxLength * 4 / 3) + 2) {
    throw new Error('E2EE_INVALID_ENCODING')
  }
  const result = Buffer.from(value, 'base64url')
  if (result.length > maxLength || result.toString('base64url') !== value) {
    throw new Error('E2EE_INVALID_ENCODING')
  }
  return result
}

function headerBytes(e: EncryptedEnvelope): Buffer {
  return Buffer.from(JSON.stringify([
    AAD_DOMAIN, e.v, e.conversationId, e.senderDeviceId, e.recipientDeviceId,
    e.recipientKeyId, e.ephemeralPublicKey, e.salt, e.nonce,
  ]))
}

function signedBytes(e: EncryptedEnvelope): Buffer {
  return Buffer.from(JSON.stringify([
    AAD_DOMAIN, e.v, e.conversationId, e.senderDeviceId, e.recipientDeviceId,
    e.recipientKeyId, e.ephemeralPublicKey, e.salt, e.nonce, e.ciphertext, e.tag,
  ]))
}

function deriveKey(secret: Buffer, salt: Buffer, e: EncryptedEnvelope): Buffer {
  const info = Buffer.from(JSON.stringify([
    AAD_DOMAIN, e.conversationId, e.senderDeviceId, e.recipientDeviceId, e.recipientKeyId,
  ]))
  return Buffer.from(hkdfSync('sha256', secret, salt, info, 32))
}
