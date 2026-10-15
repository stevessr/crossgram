import { $, type Database } from '@cordisjs/plugin-database'
import type { Context } from 'cordis'
import { decode, encode } from '@msgpack/msgpack'
import z from 'schemastery'
import { ShardedSQLiteUpdateStoreBackend, type SQLiteShardOptions } from './sharded-sqlite.js'
import {
  UpdateStore,
  type ChannelScopeUpdate,
  type NewUpdateDelivery,
  type UpdateDelivery,
  type UpdateJson,
  type UpdateStoreBackend,
} from '@mtproto-relay/update-store'

interface UpdateDeliveryRecord {
  messageId: number
  eventKey: string
  platformSessionId: string
  scope: string
  pts: number
  ptsCount: number
  seq: number
  date: number
  published: boolean
  /** Wall-clock second of the last publisher claim; null when unclaimed. */
  claimedAt: number | null
  /** MessagePack-encoded UpdateJson. Null while the publisher is constructing the update. */
  payload: ArrayBuffer | null
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_update_delivery: UpdateDeliveryRecord
  }
}

export interface Config {
  /** Maximum retained deliveries for each Telegram account and update scope. */
  retention?: number
  /**
   * Age limit of one delivery, in seconds. `0` keeps rows until the count cap
   * evicts them.
   */
  retentionSeconds?: number
  /** Opt-in account-level SQLite journals, one WAL file and batch queue per adapter identity. */
  sqliteShards?: SQLiteShardOptions
}

export const Config = z.object({
  retention: z.natural().max(1_000_000).default(10_000)
    .description('Maximum retained update deliveries for each Telegram account and update scope.'),
  retentionSeconds: z.natural().max(90 * 24 * 3600).default(3 * 24 * 3600)
    .description('delivery 的保留时长（秒）：更旧的会被清理，0 表示只按条数保留。'),
  sqliteShards: z.object({
    enabled: z.boolean().default(false),
    directory: z.string().role('path').default('./data/update-shards'),
    batchWindowMs: z.natural().max(1000).default(8),
    maxBatchSize: z.natural().min(1).max(1024).default(64),
    busyTimeoutMs: z.natural().max(60000).default(5000),
    cacheSizeKiB: z.natural().min(256).max(65536).default(1024),
    mmapSizeMiB: z.natural().max(1024).default(0),
    accounts: z.dict(z.object({
      path: z.string().role('path'),
      batchWindowMs: z.natural().max(1000),
      maxBatchSize: z.natural().min(1).max(1024),
      cacheSizeKiB: z.natural().min(256).max(65536),
      mmapSizeMiB: z.natural().max(1024),
    })).default({}),
  }).description('Per-adapter-account SQLite journal files and transactional write batching (opt-in).').default({ enabled: false, directory: './data/update-shards',
    batchWindowMs: 8, maxBatchSize: 64, busyTimeoutMs: 5000,
    cacheSizeKiB: 1024, mmapSizeMiB: 0, accounts: {} }),
})

/**
 * How often the age sweep runs.
 *
 * The count cap is per scope, so a busy channel keeps weeks of history on its
 * own; only a sweep of the whole table keeps the journal's size bounded. Five
 * minutes is frequent enough to stay near the configured window and rare enough
 * to stay invisible next to the write traffic.
 */
const RETENTION_SWEEP_INTERVAL_MS = 5 * 60 * 1000

const DEFAULT_RETENTION_SECONDS = 3 * 24 * 3600

/** Context-free durable backend using compact MessagePack payloads and indexed account partitions. */
export class DatabaseUpdateStoreBackend implements UpdateStoreBackend {
  private readonly _database: Database
  private readonly _retention: number
  private readonly _retentionSeconds: number

  constructor(database: Database, config: Config = {}) {
    this._database = database
    this._retention = Math.max(0, Math.trunc(config.retention ?? 10_000))
    this._retentionSeconds = Math.max(
      0, Math.trunc(config.retentionSeconds ?? DEFAULT_RETENTION_SECONDS),
    )
  }

  /** Configured age cap in seconds; `0` disables the sweep. */
  get retentionSeconds(): number {
    return this._retentionSeconds
  }

  async get(eventKey: string): Promise<UpdateDelivery | undefined> {
    const [row] = await this._database.get('mtproto_update_delivery', { eventKey })
    return row ? decodeRow(row) : undefined
  }

  async create(delivery: NewUpdateDelivery): Promise<UpdateDelivery> {
    return this._database.withTransaction(async (database) => {
      const [existing] = await database.get('mtproto_update_delivery', { eventKey: delivery.eventKey })
      if (existing) return decodeRow(existing)

      const row = await database.create('mtproto_update_delivery', encodeNewRow(delivery))
      await this._prune(database, delivery.platformSessionId, delivery.scope)
      return decodeRow(row)
    })
  }

  async markPublished(eventKey: string): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { published: true })
  }

  async claim(eventKey: string, claimedAt: number): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { claimedAt })
  }

  async setPayload(eventKey: string, payload: UpdateJson): Promise<void> {
    await this._database.set('mtproto_update_delivery', { eventKey }, { payload: encodePayload(payload) })
  }

  async remove(eventKey: string): Promise<void> {
    await this._database.remove('mtproto_update_delivery', { eventKey })
  }

  async getPending(platformSessionId: string): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, published: false,
    }).orderBy('seq').orderBy('messageId').execute()
    return rows.map(decodeRow)
  }

  async getAfter(platformSessionId: string, scope: string, pts: number, limit: number): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, scope, pts: { $gt: pts },
    }).orderBy('pts').orderBy('messageId').limit(Math.max(0, Math.trunc(limit))).execute()
    return rows.map(decodeRow)
  }

  async getSince(platformSessionId: string, date: number, limit: number): Promise<UpdateDelivery[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, date: { $gte: date },
    }).orderBy('seq').orderBy('messageId').limit(Math.max(0, Math.trunc(limit))).execute()
    return rows.map(decodeRow)
  }

  /**
   * One grouped row per changed channel scope.
   *
   * The aggregate runs in the database, so a client whose date cursor is days
   * old costs one indexed pass and returns one row per channel — never the
   * payloads of every retained delivery, which is what made a stale cursor
   * decode tens of thousands of updates in one request.
   */
  async getChangedChannelScopes(
    platformSessionId: string,
    date: number,
  ): Promise<ChannelScopeUpdate[]> {
    const rows = await this._database.select('mtproto_update_delivery', {
      platformSessionId, date: { $gte: date }, ptsCount: { $gt: 0 }, payload: { $exists: true },
    }).groupBy('scope', (row) => ({
      pts: $.max(row.pts),
      firstDeliveryId: $.min(row.messageId),
    })).execute() as unknown as Array<{
      scope: string
      pts: number | string
      firstDeliveryId: number | string
    }>
    return rows
      .filter((row) => row.scope.startsWith('channel:'))
      .map((row) => ({
        scope: row.scope,
        pts: Number(row.pts),
        firstDeliveryId: Number(row.firstDeliveryId),
      }))
      .sort((left, right) => left.firstDeliveryId - right.firstDeliveryId)
  }

  async prune(platformSessionId: string, scope: string): Promise<void> {
    await this._database.withTransaction((database) => this._prune(database, platformSessionId, scope))
  }

  private async _prune(database: Database, platformSessionId: string, scope: string): Promise<void> {
    if (!this._retention) {
      await database.remove('mtproto_update_delivery', { platformSessionId, scope })
      return
    }

    // One indexed seek detects overflow. Removing through the oldest overflow
    // ID keeps exactly the newest configured count without loading payloads.
    const [oldestOverflow] = await database.select('mtproto_update_delivery', {
      platformSessionId, scope,
    }).orderBy('messageId', 'desc').offset(this._retention).limit(1).execute(['messageId'])
    if (!oldestOverflow) return
    await database.remove('mtproto_update_delivery', {
      platformSessionId, scope, messageId: { $lte: oldestOverflow.messageId },
    })
  }

  /**
   * Drop every delivery older than the configured age cap.
   *
   * This is a sweep of the whole table rather than another step of `_prune`:
   * the count cap is per scope, so a channel that stopped receiving updates
   * would keep its rows forever. Nothing in the read path depends on the
   * removed rows — a cursor older than the window starts from the oldest
   * retained delivery, exactly as it does past the count cap today.
   */
  async pruneExpired(now = Date.now()): Promise<number> {
    if (!this._retentionSeconds) return 0
    const cutoff = Math.floor(now / 1000) - this._retentionSeconds
    // Filter per platform session so each DELETE can seek the
    // `platformSessionId+date` index; an age-only filter has no usable index
    // and full-scans the delivery table on every sweep.
    const sessions = await this._database
      .select('mtproto_update_delivery', { date: { $lt: cutoff } })
      .groupBy('platformSessionId').execute()
    let removed = 0
    for (const { platformSessionId } of sessions) {
      const { removed: rows } = await this._database.remove('mtproto_update_delivery', {
        platformSessionId,
        date: { $lt: cutoff },
      })
      removed += rows ?? 0
    }
    return removed
  }
}

/** Durable Cordis update-store provider. */
export class DatabaseUpdateStore extends UpdateStore {
  static inject = ['database', 'model']
  static Config = Config
  private readonly _backend: DatabaseUpdateStoreBackend | ShardedSQLiteUpdateStoreBackend

  get concurrentPerEventWrites(): boolean {
    return this._backend instanceof ShardedSQLiteUpdateStoreBackend
  }

  constructor(ctx: Context, config: Config = {}) {
    defineModel(ctx)
    super(ctx)
    this._backend = config.sqliteShards?.enabled
      ? new ShardedSQLiteUpdateStoreBackend(
          ctx.database, config.sqliteShards,
          Math.max(0, Math.trunc(config.retention ?? 10_000)),
          Math.max(0, Math.trunc(config.retentionSeconds ?? DEFAULT_RETENTION_SECONDS)),
        )
      : new DatabaseUpdateStoreBackend(ctx.database, config)
    if (this._backend instanceof ShardedSQLiteUpdateStoreBackend) {
      ctx.effect(() => () => this._backend instanceof ShardedSQLiteUpdateStoreBackend
        ? this._backend.close() : undefined, 'update-store-database.sqlite-shards')
    }
    if (this._backend.retentionSeconds) {
      const logger = ctx.logger('update-store')
      const sweep = setInterval(() => {
        void this._backend.pruneExpired().then((removed) => {
          if (removed) {
            logger.info('清理 %d 条超过 %d 秒的 delivery', removed, this._backend.retentionSeconds)
          }
        }).catch((error) => {
          logger.warn('清理过期 delivery 失败：%s', error instanceof Error ? error.message : error)
        })
      }, RETENTION_SWEEP_INTERVAL_MS)
      sweep.unref?.()
      ctx.effect(() => () => clearInterval(sweep), 'update-store-database.retention-sweep')
    }
  }

  /** Drop deliveries past the configured age cap; exposed for tests and probes. */
  pruneExpired(now = Date.now()) { return this._backend.pruneExpired(now) }

  get(eventKey: string) { return this._backend.get(eventKey) }
  create(delivery: NewUpdateDelivery) { return this._backend.create(delivery) }
  markPublished(eventKey: string) { return this._backend.markPublished(eventKey) }
  claim(eventKey: string, claimedAt: number) { return this._backend.claim(eventKey, claimedAt) }
  setPayload(eventKey: string, payload: UpdateJson) { return this._backend.setPayload(eventKey, payload) }
  remove(eventKey: string) { return this._backend.remove(eventKey) }
  getPending(platformSessionId: string) { return this._backend.getPending(platformSessionId) }
  getAfter(platformSessionId: string, scope: string, pts: number, limit: number) {
    return this._backend.getAfter(platformSessionId, scope, pts, limit)
  }
  getSince(platformSessionId: string, date: number, limit: number) {
    return this._backend.getSince(platformSessionId, date, limit)
  }
  getChangedChannelScopes(platformSessionId: string, date: number) {
    return this._backend.getChangedChannelScopes(platformSessionId, date)
  }
  prune(platformSessionId: string, scope: string) { return this._backend.prune(platformSessionId, scope) }
}

export function defineModel(ctx: Context): void {
  ctx.model.extend('mtproto_update_delivery', {
    messageId: 'unsigned', eventKey: 'text', platformSessionId: 'string', scope: 'string',
    pts: 'unsigned', ptsCount: 'unsigned', seq: 'unsigned', date: 'unsigned', published: 'boolean',
    // Null for reservations created before claims were tracked and for rows
    // written without a publisher, so readers can release them on sight.
    claimedAt: { type: 'unsigned', nullable: true },
    payload: { type: 'binary', nullable: true },
  }, {
    primary: 'messageId', autoInc: true,
    unique: ['eventKey'],
    indexes: [
      ['platformSessionId', 'scope', 'messageId'],
      ['platformSessionId', 'published', 'seq', 'messageId'],
      ['platformSessionId', 'scope', 'pts', 'messageId'],
      ['platformSessionId', 'date', 'seq', 'messageId'],
    ],
  })
}

function encodeNewRow(delivery: NewUpdateDelivery): Omit<UpdateDeliveryRecord, 'messageId'> {
  return {
    ...delivery,
    payload: delivery.payload === null ? null : encodePayload(delivery.payload),
  }
}

function decodeRow(row: UpdateDeliveryRecord): UpdateDelivery {
  return {
    ...row,
    payload: row.payload === null ? null : decodePayload(row.payload),
  }
}

function encodePayload(payload: UpdateJson): ArrayBuffer {
  const bytes = encode(payload)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function decodePayload(payload: ArrayBuffer): UpdateJson {
  return decode(new Uint8Array(payload)) as UpdateJson
}

export default DatabaseUpdateStore
