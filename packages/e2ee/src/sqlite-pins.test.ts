import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountDeviceFingerprint, exportDeviceBundle, getPinnedDevice, verifyAndPinDevice,
} from './devices.js'
import { generateDeviceIdentity } from './envelope.js'
import { SqliteDevicePinStore } from './sqlite-pins.js'

const directories: string[] = []
async function databasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crossgram-e2ee-pins-'))
  directories.push(dir)
  return join(dir, 'device-trust.sqlite')
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('client-side verified pin SQLite persistence', () => {
  it('persists verified identities across process restart and forbids silent key substitution', async () => {
    const filename = await databasePath()
    const approved = exportDeviceBundle(generateDeviceIdentity('bob-phone'))
    const impersonator = exportDeviceBundle(generateDeviceIdentity('bob-phone'))
    let pins = new SqliteDevicePinStore(filename)
    try {
      await verifyAndPinDevice(pins, 'bob', approved, accountDeviceFingerprint('bob', approved))
    } finally {
      pins.close()
    }
    pins = new SqliteDevicePinStore(filename)
    try {
      const stored = await getPinnedDevice(pins, 'bob', 'bob-phone')
      expect(exportDeviceBundle(stored)).toEqual(approved)
      await expect(verifyAndPinDevice(pins, 'bob', impersonator,
        accountDeviceFingerprint('bob', impersonator)))
        .rejects.toThrow('E2EE_DEVICE_KEY_CHANGED')
      await expect(verifyAndPinDevice(pins, 'other-account', approved,
        accountDeviceFingerprint('bob', approved)))
        .rejects.toThrow('E2EE_FINGERPRINT_MISMATCH')
      await pins.revoke('bob', 'bob-phone')
      await expect(getPinnedDevice(pins, 'bob', 'bob-phone'))
        .rejects.toThrow('E2EE_DEVICE_UNVERIFIED')
      await verifyAndPinDevice(pins, 'bob', impersonator,
        accountDeviceFingerprint('bob', impersonator))
      expect(exportDeviceBundle(await getPinnedDevice(pins, 'bob', 'bob-phone'))).toEqual(impersonator)
    } finally {
      pins.close()
    }
  })

  it('atomically handles conflicting pins across independent SQLite connections', async () => {
    const filename = await databasePath()
    const first = new SqliteDevicePinStore(filename)
    const second = new SqliteDevicePinStore(filename)
    const original = exportDeviceBundle(generateDeviceIdentity('same-device'))
    const attacker = exportDeviceBundle(generateDeviceIdentity('same-device'))
    try {
      const [a, b] = await Promise.all([
        first.pinIfAbsent('bob', original),
        second.pinIfAbsent('bob', attacker),
      ])
      expect(a).toEqual(b)
      expect([original, attacker]).toContainEqual(a)
      const pinned = await getPinnedDevice(first, 'bob', 'same-device')
      expect(exportDeviceBundle(pinned)).toEqual(a)
    } finally {
      first.close()
      second.close()
    }
  })

  it.skipIf(process.platform === 'win32')('refuses insecure owner or symlink paths', async () => {
    const filename = await databasePath()
    const dir = join(filename, '..')
    await chmod(dir, 0o755)
    expect(() => new SqliteDevicePinStore(filename)).toThrow('E2EE_UNSAFE_PIN_STORE_PATH')
    await chmod(dir, 0o700)
    const pins = new SqliteDevicePinStore(filename)
    pins.close()
    const alias = join(dir, 'alias.sqlite')
    await symlink(filename, alias)
    expect(() => new SqliteDevicePinStore(alias)).toThrow('E2EE_UNSAFE_PIN_STORE_PATH')
    await chmod(filename, 0o644)
    expect(() => new SqliteDevicePinStore(filename)).toThrow('E2EE_UNSAFE_PIN_STORE_PATH')
  })
})
