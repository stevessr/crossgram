/**
 * Atomic replay markers for POSIX desktop experiments only.
 *
 * This is not a scalable production backend: each envelope consumes a file,
 * markers are never pruned, and the caller must provide a PRIVATE, already
 * existing, durable root directory owned by the end-user. Never store this on
 * the CrossGram relay. For production use a local transaction-backed ledger.
 */
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReplayGuard } from './envelope.js'

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('E2EE_REPLAY_DIRECTORY_UNSAFE')
  }
}

/**
 * Marker writes are O_EXCL-atomic across processes. Directory sync is required
 * to avoid accepting a successfully decrypted message whose marker disappears
 * after a crash. Fail closed on unsupported OS / filesystem.
 */
export class PosixFileReplayGuard implements ReplayGuard {
  constructor(private readonly root: string) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('E2EE_INVALID_REPLAY_PATH')
  }

  async acceptOnce(messageId: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(messageId)) throw new Error('E2EE_INVALID_REPLAY_ID')
    if (process.platform === 'win32') throw new Error('E2EE_REPLAY_BACKEND_UNSUPPORTED')
    await privateDirectory(this.root)
    const directory = join(this.root, messageId.slice(0, 2))
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await privateDirectory(directory)
    // Even when another process created the bucket, sync the root: otherwise
    // it could still be uncommitted when we accept a replay marker.
    await syncDirectory(this.root)
    const filename = join(directory, messageId.slice(2))
    let handle
    try {
      handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    // Never erase a created replay marker on sync failures. Retry must fail
    // closed rather than inadvertently accepting a duplicate ciphertext.
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(directory)
    return true
  }
}
