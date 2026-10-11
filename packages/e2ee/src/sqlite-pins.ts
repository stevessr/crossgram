/**
 * End-user-device-only, durable SQLite implementation of DevicePinStore.
 *
 * The CrossGram relay MUST NOT instantiate or access this store. Private
 * local directory ownership and mode are mandatory for file-backed stores.
 * Pinning is atomic and never silently overwrites an existing device key.
 */
import { constants, closeSync, lstatSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { exportDeviceBundle, parseDeviceBundle, type DevicePinStore, type PublicDeviceBundle } from './devices.js'

interface StoredPin {
  bundle_json: string
}

function assertPrivatePath(path: string, isDirectory: boolean): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()
    || (isDirectory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0
    || (!isDirectory && stat.nlink !== 1)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('E2EE_UNSAFE_PIN_STORE_PATH')
  }
}

function validateId(value: string): void {
  if (typeof value !== 'string' || !value.trim()
    || Buffer.byteLength(value, 'utf8') > 256) throw new Error('E2EE_INVALID_ID')
}

function canonicalBundle(bundle: PublicDeviceBundle): PublicDeviceBundle {
  return exportDeviceBundle(parseDeviceBundle(bundle))
}

/**
 * For file-backed storage the owning app must create a private directory
 * first (e.g. chmod 0700) and handle its encryption-at-rest policy.
 * Memory mode is allowed only for tests. SQLite uses WAL + FULL sync.
 */
export class SqliteDevicePinStore implements DevicePinStore {
  private readonly db: DatabaseSync

  constructor(filename: string) {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new Error('E2EE_INVALID_PIN_STORE_PATH')
    }
    if (filename !== ':memory:') {
      if (process.platform === 'win32') throw new Error('E2EE_PIN_BACKEND_UNSUPPORTED')
      const path = resolve(filename)
      assertPrivatePath(dirname(path), true)
      try {
        const fd = openSync(path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600)
        closeSync(fd)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      assertPrivatePath(path, false)
    }
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA busy_timeout = 5000')
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2ee_verified_device_pin (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        bundle_json TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id)
      )
    `)
  }

  close(): void {
    this.db.close()
  }

  async get(accountId: string, deviceId: string): Promise<PublicDeviceBundle | undefined> {
    validateId(accountId)
    validateId(deviceId)
    const row = this.db.prepare(`
      SELECT bundle_json FROM e2ee_verified_device_pin
      WHERE account_id = ? AND device_id = ?
    `).get(accountId, deviceId) as StoredPin | undefined
    if (!row) return undefined
    const bundle = canonicalBundle(JSON.parse(row.bundle_json) as PublicDeviceBundle)
    if (bundle.deviceId !== deviceId) throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
    return bundle
  }

  /**
   * INSERT OR IGNORE and SELECT execute within one write transaction.
   * A concurrent key substitution can never overwrite the winner's pin.
   */
  async pinIfAbsent(accountId: string, input: PublicDeviceBundle): Promise<PublicDeviceBundle> {
    validateId(accountId)
    const bundle = canonicalBundle(input)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO e2ee_verified_device_pin
        (account_id, device_id, bundle_json) VALUES (?, ?, ?)
      `).run(accountId, bundle.deviceId, JSON.stringify(bundle))
      const row = this.db.prepare(`
        SELECT bundle_json FROM e2ee_verified_device_pin
        WHERE account_id = ? AND device_id = ?
      `).get(accountId, bundle.deviceId) as StoredPin | undefined
      if (!row) throw new Error('E2EE_PIN_STORE_WRITE_FAILED')
      const persisted = canonicalBundle(JSON.parse(row.bundle_json) as PublicDeviceBundle)
      if (persisted.deviceId !== bundle.deviceId) throw new Error('E2EE_INVALID_DEVICE_BUNDLE')
      this.db.exec('COMMIT')
      return persisted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Called only after an authenticated local user action, not by relay RPCs. */
  async revoke(accountId: string, deviceId: string): Promise<void> {
    validateId(accountId)
    validateId(deviceId)
    this.db.prepare(`
      DELETE FROM e2ee_verified_device_pin
      WHERE account_id = ? AND device_id = ?
    `).run(accountId, deviceId)
  }
}
