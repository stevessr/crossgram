import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateDeviceIdentity, openMessage, publicDevice, sealMessage,
} from './envelope.js'
import { PosixFileReplayGuard } from './replay-ledger.js'

const directories: string[] = []
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crossgram-e2ee-replay-'))
  directories.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('durable POSIX E2EE replay prevention', () => {
  it('rejects malicious IDs and paths without accessing the filesystem', async () => {
    const guard = new PosixFileReplayGuard('/not/a/client/keychain')
    await expect(guard.acceptOnce('../escape')).rejects.toThrow('E2EE_INVALID_REPLAY_ID')
    await expect(guard.acceptOnce('a'.repeat(65))).rejects.toThrow('E2EE_INVALID_REPLAY_ID')
  })

  it.skipIf(process.platform === 'win32')('rejects world-readable directories and symlink roots', async () => {
    const root = await directory()
    const guard = new PosixFileReplayGuard(root)
    const id = 'e'.repeat(64)
    await chmod(root, 0o755)
    await expect(guard.acceptOnce(id)).rejects.toThrow('E2EE_REPLAY_DIRECTORY_UNSAFE')
    await chmod(root, 0o700)
    const link = join(root, 'alias')
    await symlink(root, link)
    await expect(new PosixFileReplayGuard(link).acceptOnce(id))
      .rejects.toThrow('E2EE_REPLAY_DIRECTORY_UNSAFE')
  })

  it.skipIf(process.platform === 'win32')('remains closed across reopen and concurrent processes', async () => {
    const root = await directory()
    const id = '1'.repeat(64)
    const workers = Array.from({ length: 8 }, () => new PosixFileReplayGuard(root))
    const accepted = await Promise.all(workers.map(worker => worker.acceptOnce(id)))
    expect(accepted.filter(Boolean)).toHaveLength(1)
    const reopened = new PosixFileReplayGuard(root)
    expect(await reopened.acceptOnce(id)).toBe(false)
    const buckets = await readdir(root)
    expect(buckets).toEqual(['11'])
  })

  it.skipIf(process.platform === 'win32')('blocks exact signed-message replays after a client restart', async () => {
    const root = await directory()
    const sender = generateDeviceIdentity('alice')
    const recipient = generateDeviceIdentity('bob')
    const envelope = sealMessage(new TextEncoder().encode('once'), 'c', sender, publicDevice(recipient))
    const plaintext = await openMessage(envelope, 'c', recipient, publicDevice(sender), new PosixFileReplayGuard(root))
    expect(new TextDecoder().decode(plaintext)).toBe('once')
    await expect(openMessage(envelope, 'c', recipient, publicDevice(sender), new PosixFileReplayGuard(root)))
      .rejects.toThrow('E2EE_REPLAY_DETECTED')
  })
})
