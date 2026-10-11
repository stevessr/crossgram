import { mkdir, open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Dedicated private directory also protects SQLite WAL/SHM sidecars. */
export async function prepareStorage(path: string): Promise<string> {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await lstat(parent)
  if (!directory.isDirectory() || (directory.mode & 0o077)) {
    throw new Error('Telegram storage requires a dedicated directory with mode 0700')
  }
  const file = await open(absolute, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  await file.close()
  const stat = await lstat(absolute)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Telegram session must be a regular private file (0600)')
  }
  return absolute
}
