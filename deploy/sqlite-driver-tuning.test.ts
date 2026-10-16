import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver, { adaptiveCacheKiB, adaptiveMmapBytes } from '@cordisjs/plugin-database-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'

const MIB = 1024 * 1024

const disposals: Array<() => Promise<void>> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function startDriver(config: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-sqlite-tuning-'))
  directories.push(directory)
  const path = join(directory, 'tuning.sqlite')
  const ctx = new Context()
  // The driver resolves `config.path` against the context base URL, the same
  // way the loader does for the production configuration file.
  ;(ctx as unknown as { baseUrl: URL }).baseUrl = pathToFileURL(directory + '/')
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path, ...config })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const driver = (ctx.database as unknown as { _driver: SQLiteDriver & { db: DatabaseSync; path: string } })._driver
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return driver
}

function pragma(driver: { db: DatabaseSync }, name: string) {
  const row = driver.db.prepare(`PRAGMA ${name}`).get() as Record<string, number>
  return Object.values(row)[0]
}

function writeRows(driver: { db: DatabaseSync }, count: number) {
  driver.db.exec('CREATE TABLE IF NOT EXISTS tuning_probe (id INTEGER PRIMARY KEY, payload BLOB)')
  const insert = driver.db.prepare('INSERT OR REPLACE INTO tuning_probe (id, payload) VALUES (?, ?)')
  driver.db.exec('BEGIN')
  for (let id = 0; id < count; id++) insert.run(id, new Uint8Array(4096))
  driver.db.exec('COMMIT')
}

describe('adaptive SQLite driver tuning', () => {
  it('waits for a concurrent writer instead of failing the query', async () => {
    const driver = await startDriver({ busyTimeout: 7500 })
    expect(pragma(driver, 'busy_timeout')).toBe(7500)
    expect(driver.db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
  })

  it('sizes the page cache from the available memory, not from the database', () => {
    const shared = { dbBytes: 800 * MIB, pageSize: 4096, ceilingKiB: 32768 }
    // A machine with 8GiB free gets the full ceiling; a box that is already
    // swapping gets an eighth of what is left instead of a fixed 32MiB.
    expect(adaptiveCacheKiB({ ...shared, availableKiB: 8 * 1024 * 1024 })).toBe(32768)
    expect(adaptiveCacheKiB({ ...shared, availableKiB: 65536 })).toBe(8192)
    expect(adaptiveCacheKiB({ ...shared, availableKiB: 4096 })).toBe(4096)
    // Never larger than the database itself, so a test database does not hold
    // megabytes of buffer for kilobytes of pages.
    expect(adaptiveCacheKiB({ dbBytes: 2048, pageSize: 4096, availableKiB: 8 * 1024 * 1024, ceilingKiB: 32768 })).toBe(4096)
    // Without a memory reading the ceiling still bounds the cache.
    expect(adaptiveCacheKiB({ ...shared, availableKiB: Infinity })).toBe(32768)
  })

  it('maps as much of the file as the ceiling allows, because mapped pages are reclaimable', () => {
    expect(adaptiveMmapBytes({ dbBytes: 800 * MIB, ceilingMiB: 192 })).toBe(192 * MIB)
    expect(adaptiveMmapBytes({ dbBytes: 8 * MIB, ceilingMiB: 192 })).toBe(8 * MIB)
    expect(adaptiveMmapBytes({ dbBytes: 800 * MIB, ceilingMiB: 0 })).toBe(0)
    expect(adaptiveMmapBytes({ dbBytes: 0, ceilingMiB: 192 })).toBe(0)
  })

  it('applies the durability and memory pragmas on a real connection', async () => {
    const driver = await startDriver()
    writeRows(driver, 512)
    expect(pragma(driver, 'synchronous')).toBe(1)
    expect(pragma(driver, 'temp_store')).toBe(2)
    expect(pragma(driver, 'wal_autocheckpoint')).toBe(2000)
    expect(pragma(driver, 'journal_size_limit')).toBe(32 * MIB)
    const cacheKiB = -pragma(driver, 'cache_size')
    expect(cacheKiB).toBeGreaterThanOrEqual(4096)
    expect(cacheKiB).toBeLessThanOrEqual(32768)
    const mmap = pragma(driver, 'mmap_size')
    expect(mmap).toBeGreaterThan(0)
    expect(mmap).toBeLessThanOrEqual(192 * MIB)
    expect(driver.tuning).toMatchObject({ cacheSizeKiB: cacheKiB, mmapBytes: mmap, autoTune: true })
  })

  it('re-applies the tuning on a timer so a machine under pressure recovers its memory', async () => {
    const driver = await startDriver({ tuneIntervalMs: 1000 })
    driver.db.exec('PRAGMA cache_size = -1024')
    expect(-pragma(driver, 'cache_size')).toBe(1024)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(-pragma(driver, 'cache_size')).toBe(driver.tuning.cacheSizeKiB)
  })

  it('keeps the previous behaviour when the operator asks for it', async () => {
    const full = await startDriver({ synchronous: 'full', mmapSizeMiB: 0, autoTune: false, autoOptimize: false })
    expect(pragma(full, 'synchronous')).toBe(2)
    expect(pragma(full, 'mmap_size')).toBe(0)
    expect(-pragma(full, 'cache_size')).toBe(2000)
    expect(full.tuning).toMatchObject({ autoTune: false, autoOptimize: false })
  })

  it('refreshes the planner statistics without scanning the whole table', async () => {
    const driver = await startDriver()
    writeRows(driver, 512)
    driver.db.exec('CREATE INDEX IF NOT EXISTS tuning_probe_payload ON tuning_probe (payload)')
    driver.optimize()
    driver.optimize()
    expect(pragma(driver, 'analysis_limit')).toBe(400)
    expect(driver.db.prepare("SELECT COUNT(*) AS count FROM sqlite_stat1").get()).toMatchObject({ count: expect.any(Number) })
  })
})
