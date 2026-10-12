import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStoreBackend } from '@mtproto-relay/update-store'
import DatabaseUpdateStore from './index.js'
import { ShardedSQLiteUpdateStoreBackend, type SQLiteShardOptions } from './sharded-sqlite.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function record(eventKey: string, platformSessionId: string, pts: number, scope = 'account') {
  return {
    eventKey, platformSessionId, scope, pts, ptsCount: 1, seq: pts,
    date: pts + 100, published: false, claimedAt: null, payload: null,
  }
}

async function start(mainPath: string, shards?: SQLiteShardOptions) {
  const ctx = new Context()
  const database = ctx.plugin(Database)
  const sqlite = ctx.plugin(SQLiteDriver, { path: pathToFileURL(mainPath).href })
  const provider = ctx.plugin(DatabaseUpdateStore, {
    retention: 1_000,
    ...(shards ? { sqliteShards: shards } : {}),
  })
  let updates!: UpdateStoreBackend
  let source!: DatabaseUpdateStore
  const consumer = Object.assign((child: Context) => {
    updates = child.updateStore
    source = child.updateStore as DatabaseUpdateStore
  }, { inject: ['updateStore'] })
  const childFiber = ctx.plugin(consumer)
  await Promise.all([database, sqlite])
  await provider.await()
  await childFiber.await()
  await expect.poll(() => updates).toBeDefined()
  const stop = async () => {
    await childFiber.dispose()
    await provider.dispose()
    await sqlite.dispose()
    await database.dispose()
    await ctx.fiber.dispose()
  }
  cleanups.push(stop)
  return { ctx, updates, source, stop }
}

describe('account-sharded SQLite delivery store', () => {
  it('migrates existing MessagePack updates into independent account files without losing IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-migrate-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const mainPath = join(dir, 'cordis.db')
    const directory = join(dir, 'shards')
    const old = await start(mainPath)
    await old.updates.create(record('alpha:1', 'alpha', 2))
    await old.updates.create(record('beta:1', 'beta', 3))
    await old.updates.create(record('alpha:2', 'alpha', 4, 'channel:test'))
    const payload = { _: 'updates', updates: [{ _: 'updateNewMessage', text: '原样保留' }], chats: [], users: [] }
    await old.updates.setPayload('alpha:2', payload)
    const original = await old.updates.get('alpha:2')
    await old.stop()
    cleanups.pop()

    const sharded = await start(mainPath, {
      enabled: true, directory,
      accounts: {
        alpha: { path: join(dir, 'custom-alpha.db'), batchWindowMs: 25, maxBatchSize: 8 },
        beta: { batchWindowMs: 10, maxBatchSize: 8 },
      },
    })
    const moved = await sharded.updates.get('alpha:2')
    expect(moved).toMatchObject({
      eventKey: 'alpha:2', platformSessionId: 'alpha', messageId: original!.messageId,
      payload,
    })
    expect((await sharded.updates.getPending('beta')).map((item) => item.eventKey)).toEqual(['beta:1'])
    expect(await sharded.ctx.database.get('mtproto_update_delivery', {})).toEqual([])
    expect((await readdir(directory)).filter((name) => name.endsWith('.db'))).toHaveLength(1)
    const alphaDb = new DatabaseSync(join(dir, 'custom-alpha.db'))
    expect(alphaDb.prepare('SELECT count(*) AS total FROM delivery').get()).toEqual({ total: 2 })
    expect(alphaDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    alphaDb.close()
    await sharded.stop()
    cleanups.pop()

    const restarted = await start(mainPath, { enabled: true, directory, accounts: {
      alpha: { path: join(dir, 'custom-alpha.db') },
    } })
    expect((await restarted.updates.get('alpha:2'))?.payload).toEqual(payload)
    expect((await restarted.updates.getAfter('beta', 'account', 0, 10)).map((row) => row.eventKey))
      .toEqual(['beta:1'])
  })

  it('batches simultaneous writes independently, preserves ordering, and observes committed state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-batch-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const mainPath = join(dir, 'main.db')
    const shards = {
      enabled: true, directory: join(dir, 'accounts'),
      batchWindowMs: 50, maxBatchSize: 16,
      accounts: { quiet: { batchWindowMs: 0, maxBatchSize: 1 } },
    }
    const { source, updates } = await start(mainPath, shards)
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) => updates.create(record('busy:' + index, 'busy', index + 1))),
    )
    expect(created.map((row) => row.messageId)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    )
    await Promise.all([
      updates.create(record('quiet:1', 'quiet', 1)),
      updates.markPublished('busy:1'),
      updates.claim('busy:2', 1_700_000_000),
      updates.setPayload('busy:3', { _: 'updates', updates: [], chats: [], users: [] }),
    ])
    const backend = (source as unknown as { _backend: ShardedSQLiteUpdateStoreBackend })._backend
    expect(backend.statistics().busy.committedOperations).toBeGreaterThanOrEqual(15)
    expect(backend.statistics().busy.committedBatches)
      .toBeLessThan(backend.statistics().busy.committedOperations)
    expect(await updates.get('busy:1')).toMatchObject({ published: true })
    expect(await updates.get('busy:2')).toMatchObject({ claimedAt: 1_700_000_000 })
    expect((await updates.getPending('busy')).map((row) => row.eventKey)).not.toContain('busy:1')
    expect((await updates.getSince('busy', 0, 3)).map((row) => row.messageId)).toEqual([1, 2, 3])
    expect(backend.statistics().quiet.committedOperations).toBe(1)
  })

  it('enforces per-account file ownership and prevents accidental reuse of SQLite files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-identity-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'same.db')
    const { updates } = await start(join(dir, 'main.db'), {
      enabled: true, directory: join(dir, 'shards'),
      accounts: { alpha: { path: file }, beta: { path: file } },
    })
    await updates.create(record('alpha:1', 'alpha', 1))
    await expect(updates.create(record('beta:1', 'beta', 2)))
      .rejects.toThrow(/path reused/)
    expect((await updates.getPending('alpha')).map((row) => row.eventKey)).toEqual(['alpha:1'])
  })

  it('bounds huge incoming bursts to the configured maximum transaction size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-burst-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const { updates, source } = await start(join(dir, 'main.db'), {
      enabled: true, directory: join(dir, 'accounts'),
      batchWindowMs: 500, maxBatchSize: 4,
    })
    await Promise.all(Array.from({ length: 13 }, (_, i) =>
      updates.create(record('burst:' + i, 'burst', i + 1)),
    ))
    const backend = (source as unknown as { _backend: ShardedSQLiteUpdateStoreBackend })._backend
    expect(backend.statistics().burst).toEqual({
      committedBatches: 4, committedOperations: 13,
    })
    expect((await updates.getAfter('burst', 'account', 0, 20)).map((row) => row.pts))
      .toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
  })

  it('avoids allocating database files and caches for read-only or offline accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-idle-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const directory = join(dir, 'shards')
    const { updates, stop } = await start(join(dir, 'main.db'), {
      enabled: true, directory, batchWindowMs: 10,
    })
    expect(await updates.getPending('offline-account')).toEqual([])
    expect(await updates.getAfter('offline-account', 'account', 0, 10)).toEqual([])
    expect(await updates.getSince('offline-account', 0, 10)).toEqual([])
    expect(await updates.getChangedChannelScopes('offline-account', 0)).toEqual([])
    await updates.prune('offline-account', 'account')
    expect(await readdir(directory)).toEqual([])
    await updates.create(record('online:1', 'online-account', 1))
    expect((await readdir(directory)).filter((name) => name.endsWith('.db'))).toHaveLength(1)
    await stop()
    cleanups.pop()
    await expect(updates.create(record('after-stop', 'online-account', 2)))
      .rejects.toThrow(/closed/)
  })

  it('applies page-cache budgets individually to hot and cold adapter accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-cache-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const { updates, source } = await start(join(dir, 'main.db'), {
      enabled: true, directory: join(dir, 'shards'),
      cacheSizeKiB: 512, mmapSizeMiB: 0,
      accounts: {
        hot: { cacheSizeKiB: 4096, mmapSizeMiB: 8 },
      },
    })
    await Promise.all([
      updates.create(record('hot:1', 'hot', 1)),
      updates.create(record('cold:1', 'cold', 1)),
    ])
    const backend = (source as unknown as {
      _backend: { _shards: Map<string, { db: DatabaseSync }> }
    })._backend
    expect(backend._shards.get('hot')?.db.prepare('PRAGMA cache_size').get())
      .toEqual({ cache_size: -4096 })
    expect(backend._shards.get('cold')?.db.prepare('PRAGMA cache_size').get())
      .toEqual({ cache_size: -512 })
    expect(backend._shards.get('cold')?.db.prepare('PRAGMA mmap_size').get())
      .toEqual({ mmap_size: 0 })
  })

  it('refuses to use the Cordis main database as an account shard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-no-main-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const mainPath = join(dir, 'main.db')
    const { ctx, updates } = await start(mainPath, {
      enabled: true, directory: join(dir, 'accounts'),
      accounts: { alpha: { path: mainPath } },
    })
    await ctx.database.prepared()
    await expect(updates.create(record('alpha:1', 'alpha', 1)))
      .rejects.toThrow(/non-shard database/)
    const check = new DatabaseSync(mainPath)
    expect(check.prepare(
      "SELECT name FROM sqlite_master WHERE name='shard_metadata'",
    ).get()).toBeUndefined()
    check.close()
  })

  it('retains count caps, channel aggregation and expiry separately for each account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crossgram-shards-retention-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const database = ctx.plugin(Database)
    const sqlite = ctx.plugin(SQLiteDriver, { path: pathToFileURL(join(dir, 'main.db')).href })
    const provider = ctx.plugin(DatabaseUpdateStore, {
      retention: 2, retentionSeconds: 20,
      sqliteShards: { enabled: true, directory: join(dir, 'accounts'), batchWindowMs: 0 },
    })
    let updates!: UpdateStoreBackend
    let store!: DatabaseUpdateStore
    const consumer = ctx.plugin(Object.assign((child: Context) => {
      updates = child.updateStore
      store = child.updateStore as DatabaseUpdateStore
    }, { inject: ['updateStore'] }))
    await Promise.all([database, sqlite])
    await provider.await()
    await consumer.await()
    await expect.poll(() => updates).toBeDefined()
    cleanups.push(async () => {
      await consumer.dispose()
      await provider.dispose()
      await sqlite.dispose()
      await database.dispose()
      await ctx.fiber.dispose()
    })
    for (const key of ['a:1', 'a:2', 'a:3']) {
      await updates.create(record(key, 'a', Number(key.slice(-1)), 'channel:1'))
      await updates.setPayload(key, { _: 'updates', updates: [], chats: [], users: [] })
    }
    await updates.create({ ...record('b:1', 'b', 2, 'channel:1'), date: 150 })
    expect((await updates.getAfter('a', 'channel:1', 0, 20)).map((row) => row.eventKey))
      .toEqual(['a:2', 'a:3'])
    expect((await updates.getAfter('b', 'channel:1', 0, 20)).map((row) => row.eventKey))
      .toEqual(['b:1'])
    expect(await updates.getChangedChannelScopes('a', 0)).toEqual([
      { scope: 'channel:1', pts: 3, firstDeliveryId: 2 },
    ])
    expect(await store.pruneExpired(124_000)).toBe(2)
    expect(await updates.get('a:2')).toBeUndefined()
    expect(await updates.get('a:3')).toBeUndefined()
    expect(await updates.get('b:1')).toBeDefined()
  })
})
