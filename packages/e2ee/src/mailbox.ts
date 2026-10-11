/**
 * Prototype opaque per-device mailbox for CrossGram-native E2EE devices.
 *
 * SERVER SIDE: this module never receives private keys or plaintext. The
 * caller MUST derive AuthenticatedDevice from a verified server-side session,
 * NOT from request JSON. Its authorization callback MUST independently
 * validate conversation membership and recipient device ownership.
 *
 * In-memory only; NOT wired to MTProto / Bridge and not suitable for production.
 */
import { createHash } from 'node:crypto'
import { parseEnvelope, type EncryptedEnvelope } from './envelope.js'

export interface AuthenticatedDevice {
  /** Identity vouched for by the authenticated transport, not user input. */
  accountId: string
  deviceId: string
}
export interface RecipientDevice {
  accountId: string
  deviceId: string
}
export interface EncryptedDelivery {
  id: string
  /** Untrusted routing metadata. Never substitute for recipient-side signature verification. */
  senderAccountId: string
  recipientAccountId: string
  createdAt: number
  envelope: EncryptedEnvelope
}
export type MailboxAuthorization = (
  sender: AuthenticatedDevice,
  recipient: RecipientDevice,
  conversationId: string,
) => Promise<boolean>

interface Pending {
  delivery: EncryptedDelivery
  expiresAt: number
}

const MAX_DEVICES = 10_000
const MAX_PENDING_PER_DEVICE = 100
const MAX_TOMBSTONES = 50_000
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A deliberately small, server-blind transport prototype. Operations execute
 * without awaiting between authorization and state change, but production
 * requires durable transactional writes and ACL synchronization.
 */
export class MemoryEncryptedMailbox {
  private readonly pending = new Map<string, Map<string, Pending>>()
  private readonly tombstones = new Map<string, number>()
  constructor(
    private readonly authorize: MailboxAuthorization,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error('E2EE_INVALID_MAILBOX_TTL')
    }
  }

  /**
   * Server may inspect only opaque envelope metadata. A malicious server may
   * still drop, delay, reorder or correlate messages.
   */
  async publish(
    authenticatedSender: AuthenticatedDevice,
    recipient: RecipientDevice,
    untrustedEnvelope: unknown,
  ): Promise<{ id: string, duplicate: boolean }> {
    validateDevice(authenticatedSender)
    validateDevice(recipient)
    const envelope = parseEnvelope(untrustedEnvelope)
    if (envelope.senderDeviceId !== authenticatedSender.deviceId
      || envelope.recipientDeviceId !== recipient.deviceId) {
      throw new Error('E2EE_MAILBOX_DEVICE_MISMATCH')
    }
    if (!await this.authorize(authenticatedSender, recipient, envelope.conversationId)) {
      throw new Error('E2EE_MAILBOX_UNAUTHORIZED')
    }
    const now = this.clock()
    this.expire(now)
    const key = deviceKey(recipient)
    const id = deliveryId(authenticatedSender.accountId, recipient.accountId, envelope)
    const replayKey = JSON.stringify([key, id])
    if (this.tombstones.has(replayKey)) return { id, duplicate: true }
    const current = this.pending.get(key)
    if ((current?.size ?? 0) >= MAX_PENDING_PER_DEVICE
      || this.tombstones.size >= MAX_TOMBSTONES
      || (!current && this.pending.size >= MAX_DEVICES)) {
      throw new Error('E2EE_MAILBOX_FULL')
    }
    const queue = current ?? new Map<string, Pending>()
    if (!current) this.pending.set(key, queue)
    const expiresAt = now + this.ttlMs
    queue.set(id, {
      delivery: {
        id,
        senderAccountId: authenticatedSender.accountId,
        recipientAccountId: recipient.accountId,
        createdAt: now,
        envelope: { ...envelope },
      },
      expiresAt,
    })
    this.tombstones.set(replayKey, expiresAt)
    return { id, duplicate: false }
  }

  /**
   * The invoking authenticated device may only read its OWN queue. `device`
   * must come from a checked server auth session, never client-supplied JSON.
   */
  async list(authenticatedRecipient: AuthenticatedDevice, limit = 50): Promise<EncryptedDelivery[]> {
    validateDevice(authenticatedRecipient)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('E2EE_INVALID_MAILBOX_LIMIT')
    }
    this.expire(this.clock())
    const queue = this.pending.get(deviceKey(authenticatedRecipient))
    if (!queue) return []
    return [...queue.values()].slice(0, limit).map(({ delivery }) => ({
      ...delivery,
      envelope: { ...delivery.envelope },
    }))
  }

  /** Acknowledge only exact IDs present in this authenticated device's queue. */
  async acknowledge(authenticatedRecipient: AuthenticatedDevice, ids: readonly string[]): Promise<number> {
    validateDevice(authenticatedRecipient)
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(x => !/^[0-9a-f]{64}$/.test(x))) {
      throw new Error('E2EE_INVALID_DELIVERY_IDS')
    }
    this.expire(this.clock())
    const key = deviceKey(authenticatedRecipient)
    const queue = this.pending.get(key)
    if (!queue) return 0
    let removed = 0
    for (const id of ids) {
      if (queue.delete(id)) removed++
    }
    if (!queue.size) this.pending.delete(key)
    // Tombstone remains until TTL to stop replay-by-republish after ACK.
    return removed
  }

  /** Cannot prevent a hostile operator from reading metadata or deleting ciphertext. */
  private expire(now: number): void {
    for (const [key, queue] of this.pending) {
      for (const [id, item] of queue) {
        if (item.expiresAt <= now) queue.delete(id)
      }
      if (!queue.size) this.pending.delete(key)
    }
    for (const [id, expiry] of this.tombstones) {
      if (expiry <= now) this.tombstones.delete(id)
    }
  }
}

export function deliveryId(senderAccountId: string, recipientAccountId: string, e: EncryptedEnvelope): string {
  // Fixed field ordering also deduplicates semantically identical JSON objects.
  return createHash('sha256').update(JSON.stringify([
    'crossgram/e2ee-mailbox/v1', senderAccountId, recipientAccountId,
    e.v, e.conversationId, e.senderDeviceId, e.recipientDeviceId,
    e.recipientKeyId, e.ephemeralPublicKey, e.salt, e.nonce,
    e.ciphertext, e.tag, e.signature,
  ])).digest('hex')
}
export function validateDevice(device: AuthenticatedDevice | RecipientDevice): void {
  if (!device || typeof device !== 'object') throw new Error('E2EE_INVALID_MAILBOX_DEVICE')
  for (const value of [device.accountId, device.deviceId]) {
    if (typeof value !== 'string' || !value.trim()
      || Buffer.byteLength(value, 'utf8') > 256) throw new Error('E2EE_INVALID_MAILBOX_DEVICE')
  }
}
export function deviceKey(device: AuthenticatedDevice | RecipientDevice): string {
  return JSON.stringify([device.accountId, device.deviceId])
}
