import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decode, encode } from '@msgpack/msgpack'
import type { Database } from '@cordisjs/plugin-database'
import type {
  ChannelScopeUpdate, NewUpdateDelivery, UpdateDelivery, UpdateJson, UpdateStoreBackend,
} from '@mtproto-relay/update-store'

/**
 * Only the account-scoped update journal is sharded. Canonical messages, users,
 * IDs and session credentials deliberately remain in Cordis' main database:
 * routing those tables independently would break global numeric ID lookups.
 */
export interface SQLiteShardOptions {
  enabled?: boolean
  directory?: string
  batchWindowMs?: number
  maxBatchSize?: number
  busyTimeoutMs?: number
  /** Keys are stable mtproto_platform_session.id values, not platform kinds. */
  accounts?: Record<string, {
    path?: string
    batchWindowMs?: number
    maxBatchSize?: number
  }>
}

interface PendingOperation<T = unknown> {
  action: () => T
  resolve(value: T): void
  reject(reason: unknown): void
}

interface Shard {
  sessionId: string
  path: string
  db: DatabaseSync
  batchWindowMs: number
  maxBatchSize: number
  queue: PendingOperation[]
  committedBatches: number
  committedOperations: number
  timer?: ReturnType<typeof setTimeout>
}

interface RawRow {
  message_id: number
  event_key: string
  platform_session_id: string
  scope: string
  pts: number
  pts_count: number
  seq: number
  date: number
  published: number
  claimed_at: number | null
  payload: Uint8Array | null
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS shard_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS delivery ('
    + 'message_id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'event_key TEXT NOT NULL UNIQUE, platform_session_id TEXT NOT NULL,'
    + 'scope TEXT NOT NULL, pts INTEGER NOT NULL, pts_count INTEGER NOT NULL,'
    + 'seq INTEGER NOT NULL, date INTEGER NOT NULL, published INTEGER NOT NULL,'
    + 'claimed_at INTEGER, payload BLOB)',
  'CREATE INDEX IF NOT EXISTS delivery_scope ON delivery(platform_session_id, scope, message_id)',
  'CREATE INDEX IF NOT EXISTS delivery_pending ON delivery(platform_session_id, published, seq, message_id)',
  'CREATE INDEX IF NOT EXISTS delivery_pts ON delivery(platform_session_id, scope, pts, message_id)',
  'CREATE INDEX IF NOT EXISTS delivery_date ON delivery(platform_session_id, date, seq, message_id)',
].join(';')

const COLUMNS = 'message_id, event_key, platform_session_id, scope, pts, pts_count, seq, date, published, claimed_at, payload'
const INSERT = 'INSERT OR IGNORE INTO delivery (' + COLUMNS + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

/**
 * A separate WAL file and commit queue per adapter account. Every mutation's
 * Promise resolves *after COMMIT*. Batching therefore never acknowledges a
 * write that exists only in volatile memory.
 *
 * The legacy Cordis delivery table is migrated in bounded, idempotent pages on
 * first use. A failed migration does not start the sharded backend.
 */
export class ShardedSQLiteUpdateStoreBackend implements UpdateStoreBackend {
  private readonly _directory: string
  private readonly _shards = new Map<string, Shard>()
  private readonly _knownPaths = new Map<string, string>()
  private readonly _owners = new Map<string, string>()
  private readonly _ownerCacheLimit = 4096
  private _ready?: Promise<void>
  private _closed = false

  constructor(
    private readonly _legacy: Database,
    private readonly _config: SQLiteShardOptions,
    private readonly _retention: number,
    readonly retentionSeconds: number,
  ) {
    this._directory = resolve(_config.directory ?? './data/update-shards')
  }

  private ready(): Promise<void> {
    return this._ready ??= this.initialize()
  }

  private async initialize(): Promise<void> {
    await this._legacy.prepared()
    mkdirSync(this._directory, { recursive: true })
    const paths = new Set(
      readdirSync(this._directory)
        .filter((name) => name.endsWith('.db'))
        .map((name) => join(this._directory, name)),
    )
    for (const account of Object.values(this._config.accounts ?? {})) {
      if (account.path && existsSync(resolve(account.path))) paths.add(resolve(account.path))
    }
    for (const path of paths) {
      const db = new DatabaseSync(path)
      try {
        const exists = db.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='shard_metadata'",
        ).get()
        if (!exists) continue
        const row = db.prepare("SELECT value FROM shard_metadata WHERE key='sessionId'").get() as
          | { value: string } | undefined
        if (!row) throw new Error('SQLite shard missing session identity: ' + path)
        const previous = this._knownPaths.get(row.value)
        if (previous && previous !== path) {
          throw new Error('Duplicate SQLite shards for account ' + row.value)
        }
        this._knownPaths.set(row.value, path)
      } finally {
        db.close()
      }
    }

    // Source rows are deleted only *after* the destination transaction commits.
    // A crash between steps is retried with INSERT OR IGNORE on restart.
    let cursor = 0
    for (;;) {
      const page = await this._legacy.select('mtproto_update_delivery', {
        messageId: { $gt: cursor },
      }).orderBy('messageId').limit(128).execute()
      if (!page.length) break
      const groups = new Map<string, typeof page>()
      for (const row of page) {
        const list = groups.get(row.platformSessionId) ?? []
        list.push(row)
        groups.set(row.platformSessionId, list)
      }
      for (const [sessionId, rows] of groups) {
        const shard = this.open(sessionId)
        shard.db.exec('BEGIN IMMEDIATE')
        try {
          const statement = shard.db.prepare(INSERT)
          for (const row of rows) {
            statement.run(
              row.messageId, row.eventKey, row.platformSessionId, row.scope,
              row.pts, row.ptsCount, row.seq, row.date, Number(row.published),
              row.claimedAt, row.payload === null ? null : new Uint8Array(row.payload),
            )
          }
          shard.db.exec('COMMIT')
        } catch (error) {
          shard.db.exec('ROLLBACK')
          throw error
        }
      }
      await this._legacy.remove('mtproto_update_delivery', {
        messageId: { $in: page.map((row) => row.messageId) },
      })
      cursor = page[page.length - 1].messageId
    }
  }

  private pathFor(sessionId: string): string {
    const configured = this._config.accounts?.[sessionId]?.path
    const target = configured
      ? resolve(configured)
      : join(this._directory, createHash('sha256').update(sessionId).digest('hex').slice(0, 32) + '.db')
    const existing = this._knownPaths.get(sessionId)
    if (existing && existing !== target) {
      throw new Error('Account ' + sessionId + ' already has a shard at ' + existing
        + '; move it offline before changing its configured path')
    }
    for (const [owner, path] of this._knownPaths) {
      if (owner !== sessionId && path === target) {
        throw new Error('SQLite account shard path reused by ' + owner + ' and ' + sessionId)
      }
    }
    return target
  }

  private open(sessionId: string): Shard {
    const cached = this._shards.get(sessionId)
    if (cached) return cached
    const path = this.pathFor(sessionId)
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    try {
      const timeout = Math.max(0, Math.min(60_000, this._config.busyTimeoutMs ?? 5_000))
      db.exec('PRAGMA busy_timeout = ' + timeout)
      db.exec('PRAGMA journal_mode = WAL')
      // FULL is intentional: a resolved mutation remains durable across a power loss.
      db.exec('PRAGMA synchronous = FULL')
      db.exec(SCHEMA)
      const stored = db.prepare("SELECT value FROM shard_metadata WHERE key='sessionId'").get() as
        | { value: string } | undefined
      if (stored && stored.value !== sessionId) {
        throw new Error('SQLite shard belongs to ' + stored.value + ', not ' + sessionId)
      }
      if (!stored) {
        db.prepare("INSERT INTO shard_metadata(key, value) VALUES ('sessionId', ?)").run(sessionId)
      }
      const account = this._config.accounts?.[sessionId]
      const shard: Shard = {
        sessionId, path, db,
        batchWindowMs: Math.max(0, Math.min(1_000, account?.batchWindowMs ?? this._config.batchWindowMs ?? 8)),
        maxBatchSize: Math.max(1, Math.min(1_024, account?.maxBatchSize ?? this._config.maxBatchSize ?? 64)),
        queue: [],
        committedBatches: 0,
        committedOperations: 0,
      }
      this._knownPaths.set(sessionId, path)
      this._shards.set(sessionId, shard)
      return shard
    } catch (error) {
      db.close()
      throw error
    }
  }

  private fromRow(value: unknown): UpdateDelivery {
    const row = value as RawRow
    return {
      messageId: row.message_id, eventKey: row.event_key,
      platformSessionId: row.platform_session_id, scope: row.scope,
      pts: row.pts, ptsCount: row.pts_count, seq: row.seq, date: row.date,
      published: Boolean(row.published), claimedAt: row.claimed_at,
      payload: row.payload === null ? null : decode(row.payload) as UpdateJson,
    }
  }

  private flush(shard: Shard): void {
    if (shard.timer) clearTimeout(shard.timer)
    shard.timer = undefined
    const batch = shard.queue.splice(0)
    if (!batch.length) return
    const results: unknown[] = []
    try {
      shard.db.exec('BEGIN IMMEDIATE')
      try {
        for (const operation of batch) results.push(operation.action())
        shard.db.exec('COMMIT')
        shard.committedBatches++
        shard.committedOperations += batch.length
      } catch (error) {
        shard.db.exec('ROLLBACK')
        throw error
      }
      batch.forEach((operation, index) => operation.resolve(results[index]))
    } catch (error) {
      batch.forEach((operation) => operation.reject(error))
    }
  }

  private enqueue<T>(shard: Shard, action: () => T): Promise<T> {
    if (this._closed) return Promise.reject(new Error('SQLite update store is closed'))
    return new Promise<T>((resolve, reject) => {
      shard.queue.push({ action, resolve, reject } as PendingOperation)
      if (shard.queue.length >= shard.maxBatchSize || shard.batchWindowMs === 0) {
        if (shard.timer) clearTimeout(shard.timer)
        shard.timer = undefined
        queueMicrotask(() => this.flush(shard))
      } else if (!shard.timer) {
        shard.timer = setTimeout(() => this.flush(shard), shard.batchWindowMs)
      }
    })
  }

  private rememberOwner(eventKey: string, sessionId: string): void {
    this._owners.delete(eventKey)
    this._owners.set(eventKey, sessionId)
    if (this._owners.size > this._ownerCacheLimit) {
      this._owners.delete(this._owners.keys().next().value!)
    }
  }

  /** Commit counters are per account, useful for verifying the actual batch ratio. */
  statistics(): Record<string, { committedBatches: number, committedOperations: number }> {
    return Object.fromEntries([...this._shards].map(([sessionId, shard]) => [
      sessionId, {
        committedBatches: shard.committedBatches,
        committedOperations: shard.committedOperations,
      },
    ]))
  }

  private async locate(eventKey: string): Promise<Shard | undefined> {
    await this.ready()
    const owned = this._owners.get(eventKey)
    if (owned) return this.open(owned)
    for (const sessionId of this._knownPaths.keys()) {
      const shard = this.open(sessionId)
      this.flush(shard)
      const row = shard.db.prepare('SELECT 1 FROM delivery WHERE event_key = ?').get(eventKey)
      if (row) {
        this.rememberOwner(eventKey, sessionId)
        return shard
      }
    }
    return undefined
  }

  async get(eventKey: string): Promise<UpdateDelivery | undefined> {
    const shard = await this.locate(eventKey)
    if (!shard) return
    this.flush(shard)
    const row = shard.db.prepare('SELECT ' + COLUMNS + ' FROM delivery WHERE event_key = ?')
      .get(eventKey)
    return row ? this.fromRow(row) : undefined
  }

  async create(delivery: NewUpdateDelivery): Promise<UpdateDelivery> {
    await this.ready()
    const shard = this.open(delivery.platformSessionId)
    const value = await this.enqueue(shard, () => {
      const previous = shard.db.prepare('SELECT ' + COLUMNS + ' FROM delivery WHERE event_key = ?')
        .get(delivery.eventKey)
      if (previous) return this.fromRow(previous)
      const inserted = shard.db.prepare(
        'INSERT INTO delivery (event_key, platform_session_id, scope, pts, pts_count, seq, date, published, claimed_at, payload)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        delivery.eventKey, delivery.platformSessionId, delivery.scope,
        delivery.pts, delivery.ptsCount, delivery.seq, delivery.date,
        Number(delivery.published), delivery.claimedAt,
        delivery.payload === null ? null : encode(delivery.payload),
      )
      if (this._retention <= 0) {
        shard.db.prepare('DELETE FROM delivery WHERE platform_session_id=? AND scope=?')
          .run(delivery.platformSessionId, delivery.scope)
      } else {
        const overflow = shard.db.prepare(
          'SELECT message_id FROM delivery WHERE platform_session_id=? AND scope=?'
          + ' ORDER BY message_id DESC LIMIT 1 OFFSET ?',
        ).get(delivery.platformSessionId, delivery.scope, this._retention) as
          | { message_id: number } | undefined
        if (overflow) {
          shard.db.prepare(
            'DELETE FROM delivery WHERE platform_session_id=? AND scope=? AND message_id<=?',
          ).run(delivery.platformSessionId, delivery.scope, overflow.message_id)
        }
      }
      const row = shard.db.prepare('SELECT ' + COLUMNS + ' FROM delivery WHERE message_id = ?')
        .get(Number(inserted.lastInsertRowid))
      // Match the legacy backend's retention=0 contract: creation returns
      // the inserted record even if the count cap immediately removes it.
      if (row) return this.fromRow(row)
      return { ...delivery, messageId: Number(inserted.lastInsertRowid) }
    })
    this.rememberOwner(delivery.eventKey, delivery.platformSessionId)
    return value
  }

  async markPublished(eventKey: string): Promise<void> {
    const shard = await this.locate(eventKey)
    if (shard) await this.enqueue(shard, () => {
      shard.db.prepare('UPDATE delivery SET published=1 WHERE event_key=?').run(eventKey)
    })
  }

  async claim(eventKey: string, claimedAt: number): Promise<void> {
    const shard = await this.locate(eventKey)
    if (shard) await this.enqueue(shard, () => {
      shard.db.prepare('UPDATE delivery SET claimed_at=? WHERE event_key=?').run(claimedAt, eventKey)
    })
  }

  async setPayload(eventKey: string, payload: UpdateJson): Promise<void> {
    const shard = await this.locate(eventKey)
    if (shard) await this.enqueue(shard, () => {
      shard.db.prepare('UPDATE delivery SET payload=? WHERE event_key=?').run(encode(payload), eventKey)
    })
  }

  async remove(eventKey: string): Promise<void> {
    const shard = await this.locate(eventKey)
    if (shard) await this.enqueue(shard, () => {
      shard.db.prepare('DELETE FROM delivery WHERE event_key=?').run(eventKey)
    })
    this._owners.delete(eventKey)
  }

  async getPending(sessionId: string): Promise<UpdateDelivery[]> {
    await this.ready()
    const shard = this.open(sessionId)
    this.flush(shard)
    return shard.db.prepare(
      'SELECT ' + COLUMNS + ' FROM delivery WHERE platform_session_id=? AND published=0'
      + ' ORDER BY seq, message_id',
    ).all(sessionId).map((row) => this.fromRow(row))
  }

  async getAfter(sessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDelivery[]> {
    if (limit <= 0) return []
    await this.ready()
    const shard = this.open(sessionId)
    this.flush(shard)
    return shard.db.prepare(
      'SELECT ' + COLUMNS + ' FROM delivery WHERE platform_session_id=? AND scope=? AND pts>?'
      + ' ORDER BY pts, message_id LIMIT ?',
    ).all(sessionId, scope, pts, Math.max(0, Math.trunc(limit))).map((row) => this.fromRow(row))
  }

  async getSince(sessionId: string, date: number, limit: number): Promise<UpdateDelivery[]> {
    if (limit <= 0) return []
    await this.ready()
    const shard = this.open(sessionId)
    this.flush(shard)
    return shard.db.prepare(
      'SELECT ' + COLUMNS + ' FROM delivery WHERE platform_session_id=? AND date>=?'
      + ' ORDER BY seq, message_id LIMIT ?',
    ).all(sessionId, date, Math.max(0, Math.trunc(limit))).map((row) => this.fromRow(row))
  }

  async getChangedChannelScopes(sessionId: string, date: number): Promise<ChannelScopeUpdate[]> {
    await this.ready()
    const shard = this.open(sessionId)
    this.flush(shard)
    const rows = shard.db.prepare(
      "SELECT scope, MAX(pts) AS pts, MIN(message_id) AS firstDeliveryId FROM delivery"
      + " WHERE platform_session_id=? AND date>=? AND pts_count>0 AND payload IS NOT NULL"
      + " AND scope LIKE 'channel:%' GROUP BY scope ORDER BY firstDeliveryId",
    ).all(sessionId, date) as Array<{ scope: string, pts: number, firstDeliveryId: number }>
    return rows
  }

  async prune(sessionId: string, scope: string): Promise<void> {
    await this.ready()
    const shard = this.open(sessionId)
    await this.enqueue(shard, () => {
      if (this._retention <= 0) {
        shard.db.prepare('DELETE FROM delivery WHERE platform_session_id=? AND scope=?').run(sessionId, scope)
        return
      }
      const overflow = shard.db.prepare(
        'SELECT message_id FROM delivery WHERE platform_session_id=? AND scope=?'
        + ' ORDER BY message_id DESC LIMIT 1 OFFSET ?',
      ).get(sessionId, scope, this._retention) as { message_id: number } | undefined
      if (overflow) shard.db.prepare(
        'DELETE FROM delivery WHERE platform_session_id=? AND scope=? AND message_id<=?',
      ).run(sessionId, scope, overflow.message_id)
    })
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    if (!this.retentionSeconds) return 0
    await this.ready()
    let removed = 0
    for (const sessionId of this._knownPaths.keys()) {
      const shard = this.open(sessionId)
      removed += await this.enqueue(shard, () => Number(shard.db.prepare(
        'DELETE FROM delivery WHERE date<?',
      ).run(Math.floor(now / 1_000) - this.retentionSeconds).changes))
    }
    return removed
  }

  async close(): Promise<void> {
    if (!this._ready) return
    await this._ready
    // Do not reject already accepted work on shutdown.
    this._closed = true
    for (const shard of this._shards.values()) {
      this.flush(shard)
      shard.db.close()
    }
    this._shards.clear()
  }
}
