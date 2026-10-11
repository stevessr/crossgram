/**
 * Crash-persistent opaque mailbox backing store for CrossGram-native clients.
 * No endpoint is exposed. Callers MUST bind both sender and receiver objects
 * to independently verified server-side sessions and pass an ACL callback
 * enforcing room membership and recipient-device registration.
 *
 * SQLite contains ciphertext + route metadata, NEVER client private keys.
 * For moderate/local prototypes only: production needs mailbox quotas,
 * multi-instance coordination, rate limiting, backups and retention policies.
 */
import { DatabaseSync } from 'node:sqlite'
import { parseEnvelope, type EncryptedEnvelope } from './envelope.js'
import {
  deliveryId, validateDevice, type AuthenticatedDevice, type EncryptedDelivery,
  type MailboxAuthorization, type RecipientDevice,
} from './mailbox.js'

interface SqliteDeliveryRow {
  id: string
  sender_account: string
  recipient_account: string
  created_at: number
  envelope_json: string
}
const MAX_PENDING_PER_DEVICE = 100
const MAX_DELIVERY_IDS = 100
const DEFAULT_TTL_MS = 7 * 86400 * 1000

/**
 * Persisted mailbox with BEGIN IMMEDIATE transactions, duplicate tombstones,
 * bounded device queues and durable ACK semantics.
 */
export class SqliteEncryptedMailbox {
  private readonly db: DatabaseSync

  constructor(
    databasePath: string,
    private readonly authorize: MailboxAuthorization,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {
    if (!databasePath?.trim()) throw new Error('E2EE_MAILBOX_INVALID_PATH')
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400 * 1000) {
      throw new Error('E2EE_INVALID_MAILBOX_TTL')
    }
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    // A file-backed WAL database with FULL synchronous mode durably commits
    // transactions on filesystems honoring SQLite's sync guarantees.
    if (databasePath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2ee_mailbox (
        id TEXT PRIMARY KEY,
        sender_account TEXT NOT NULL,
        sender_device TEXT NOT NULL,
        recipient_account TEXT NOT NULL,
        recipient_device TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        envelope_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS e2ee_mailbox_by_device
        ON e2ee_mailbox (recipient_account, recipient_device, created_at, id);
      CREATE TABLE IF NOT EXISTS e2ee_delivery_tombstone (
        id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS e2ee_tombstone_expiry
        ON e2ee_delivery_tombstone (expires_at);
    `)
  }

  close(): void {
    this.db.close()
  }

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
    // Always authorize before checking for duplicates. An unauthorized actor
    // must not be able to probe existence of someone else's encrypted message.
    if (!await this.authorize(authenticatedSender, recipient, envelope.conversationId)) {
      throw new Error('E2EE_MAILBOX_UNAUTHORIZED')
    }
    const id = deliveryId(authenticatedSender.accountId, recipient.accountId, envelope)
    const now = this.clock()
    return this.transaction(() => {
      this.prune(now)
      const duplicate = this.db.prepare('SELECT 1 FROM e2ee_delivery_tombstone WHERE id = ?').get(id)
      if (duplicate) return { id, duplicate: true }
      const countRow = this.db.prepare(`
        SELECT COUNT(*) AS count FROM e2ee_mailbox
        WHERE recipient_account = ? AND recipient_device = ?
      `).get(recipient.accountId, recipient.deviceId) as { count: number }
      if (countRow.count >= MAX_PENDING_PER_DEVICE) throw new Error('E2EE_MAILBOX_FULL')
      this.db.prepare(`
        INSERT INTO e2ee_delivery_tombstone (id, expires_at) VALUES (?, ?)
      `).run(id, now + this.ttlMs)
      this.db.prepare(`
        INSERT INTO e2ee_mailbox
          (id, sender_account, sender_device, recipient_account, recipient_device,
           conversation_id, created_at, expires_at, envelope_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, authenticatedSender.accountId, authenticatedSender.deviceId,
        recipient.accountId, recipient.deviceId, envelope.conversationId,
        now, now + this.ttlMs, JSON.stringify(envelope),
      )
      return { id, duplicate: false }
    })
  }

  async list(authenticatedRecipient: AuthenticatedDevice, limit = 50): Promise<EncryptedDelivery[]> {
    validateDevice(authenticatedRecipient)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('E2EE_INVALID_MAILBOX_LIMIT')
    }
    return this.transaction(() => {
      this.prune(this.clock())
      const rows = this.db.prepare(`
        SELECT id, sender_account, recipient_account, created_at, envelope_json
        FROM e2ee_mailbox
        WHERE recipient_account = ? AND recipient_device = ?
        ORDER BY created_at, rowid LIMIT ?
      `).all(authenticatedRecipient.accountId, authenticatedRecipient.deviceId, limit) as unknown as SqliteDeliveryRow[]
      return rows.map(row => ({
        id: row.id,
        senderAccountId: row.sender_account,
        recipientAccountId: row.recipient_account,
        createdAt: row.created_at,
        envelope: parseEnvelope(JSON.parse(row.envelope_json)) as EncryptedEnvelope,
      }))
    })
  }

  async acknowledge(authenticatedRecipient: AuthenticatedDevice, ids: readonly string[]): Promise<number> {
    validateDevice(authenticatedRecipient)
    if (!Array.isArray(ids) || ids.length > MAX_DELIVERY_IDS
      || ids.some(x => typeof x !== 'string' || !/^[0-9a-f]{64}$/.test(x))) {
      throw new Error('E2EE_INVALID_DELIVERY_IDS')
    }
    return this.transaction(() => {
      this.prune(this.clock())
      const statement = this.db.prepare(`
        DELETE FROM e2ee_mailbox
        WHERE id = ? AND recipient_account = ? AND recipient_device = ?
      `)
      let removed = 0
      for (const id of new Set(ids)) {
        removed += Number(statement.run(id, authenticatedRecipient.accountId, authenticatedRecipient.deviceId).changes)
      }
      return removed
    })
  }

  private prune(now: number): void {
    this.db.prepare('DELETE FROM e2ee_mailbox WHERE expires_at <= ?').run(now)
    this.db.prepare('DELETE FROM e2ee_delivery_tombstone WHERE expires_at <= ?').run(now)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
