/**
 * Durable, fail-closed replay ledger for POSIX desktop/dev experiments.
 *
 * Uses O_EXCL for atomic consumption even across different client processes.
 * Each accepted envelope occupies an empty file; do NOT use for high-volume
 * production messaging. Prefer a transaction-backed durable KV store in the
 * real client. Never mount this directory in the CrossGram relay server.
 *
 * Portability: POSIX directory fsync is needed for crash durability. On
 * unsupported filesystems or Windows this class throws instead of claiming
 * durable delivery.
 */
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReplayGuard } from './envelope.js'

export class PosixFileReplayGuard implements ReplayGuard {
  constructor(private readonly root: string) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('E2EE_INVALID_REPLAY_PATH')
  }

  async acceptOnce(messageId: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(messageId)) throw new Error('E2EE_INVALID_REPLAY_ID')
    if (process.platform === 'win32') throw new Error('E2EE_REPLAY_BACKEND_UNSUPPORTED')
    const directory = join(this.root, messageId.slice(0, 2))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const filename = join(directory, messageId.slice(2))
    let handle
    try {
      handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    // Never erase an already-created replay marker on sync failure: doing so
    // would allow a retry to decrypt the same ciphertext a second time.
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    const parent = await open(directory, constants.O_RDONLY)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    return true
  }
}
