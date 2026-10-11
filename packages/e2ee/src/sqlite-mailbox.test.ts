import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountDeviceFingerprint, bundleFingerprint, exportDeviceBundle, MemoryDevicePinStore,
  openFromPinnedDevice, verifyAndPinDevice } from './devices.js'
import { MemoryReplayGuard, generateDeviceIdentity, publicDevice, sealMessage } from './envelope.js'
import { SqliteEncryptedMailbox } from './sqlite-mailbox.js'

const directories: string[] = []
async function sqlitePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crossgram-e2ee-mailbox-'))
  directories.push(dir)
  return join(dir, 'mailbox.sqlite')
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const alice = { accountId: 'alice', deviceId: 'desktop' }
const bob = { accountId: 'bob', deviceId: 'mobile' }
const stranger = { accountId: 'stranger', deviceId: 'mobile' }
const allowed = async (from: typeof alice, to: typeof bob, conversation: string) =>
  from.accountId === 'alice' && to.accountId === 'bob' && conversation === 'room:secret'

describe('SQLite encrypted mailbox prototype', () => {
  it('survives restart, requires pinned sender, persists ACK and duplicate tombstone', async () => {
    const filename = await sqlitePath()
    const sender = generateDeviceIdentity(alice.deviceId)
    const recipient = generateDeviceIdentity(bob.deviceId)
    const plaintext = 'do not persist this in cleartext'
    const sealed = sealMessage(new TextEncoder().encode(plaintext), 'room:secret', sender, publicDevice(recipient), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    const pinStore = new MemoryDevicePinStore()
    const bundle = exportDeviceBundle(sender)
    await verifyAndPinDevice(pinStore, 'alice', bundle, accountDeviceFingerprint('alice', bundle))
    let first = new SqliteEncryptedMailbox(filename, allowed)
    const queued = await first.publish(alice, bob, sealed)
    expect(queued.duplicate).toBe(false)
    first.close()

    let reopened = new SqliteEncryptedMailbox(filename, allowed)
    const waiting = await reopened.list(bob)
    expect(waiting).toHaveLength(1)
    expect(JSON.stringify(waiting)).not.toContain(plaintext)
    expect(waiting[0].id).toBe(queued.id)
    expect(new TextDecoder().decode(await openFromPinnedDevice(waiting[0].envelope,
      'room:secret', recipient, pinStore, 'alice', new MemoryReplayGuard(), 'bob'))).toBe(plaintext)
    expect(await reopened.acknowledge(stranger, [queued.id])).toBe(0)
    expect(await reopened.acknowledge(bob, [queued.id])).toBe(1)
    reopened.close()

    first = new SqliteEncryptedMailbox(filename, allowed)
    expect(await first.list(bob)).toHaveLength(0)
    expect((await first.publish(alice, bob, sealed)).duplicate).toBe(true)
    first.close()
  })

  it('enforces ACL, route binding, bounded queues and recipient-only ACK', async () => {
    const db = new SqliteEncryptedMailbox(':memory:', allowed)
    try {
      const sender = generateDeviceIdentity(alice.deviceId)
      const recipient = generateDeviceIdentity(bob.deviceId)
      const first = sealMessage(new Uint8Array([1]), 'room:secret', sender, publicDevice(recipient), { senderAccountId: 'alice', recipientAccountId: 'bob' })
      await expect(db.publish({ accountId: 'stranger', deviceId: alice.deviceId }, bob, first))
        .rejects.toThrow('E2EE_MAILBOX_UNAUTHORIZED')
      await expect(db.publish(alice, { accountId: 'bob', deviceId: 'other' }, first))
        .rejects.toThrow('E2EE_MAILBOX_DEVICE_MISMATCH')
      await expect(db.publish(alice, bob, { ...first, conversationId: 'forbidden' }))
        .rejects.toThrow('E2EE_MAILBOX_UNAUTHORIZED')
      const saved = await db.publish(alice, bob, first)
      expect(await db.acknowledge(stranger, [saved.id])).toBe(0)
      expect(await db.list(bob)).toHaveLength(1)
      expect((await db.publish(alice, bob, first)).duplicate).toBe(true)
      await expect(db.acknowledge(bob, ['../../escape'])).rejects.toThrow('E2EE_INVALID_DELIVERY_IDS')
      for (let i = 1; i < 100; i++) {
        const message = sealMessage(new Uint8Array([i]), 'room:secret', sender, publicDevice(recipient), { senderAccountId: 'alice', recipientAccountId: 'bob' })
        await db.publish(alice, bob, message)
      }
      expect((await db.list(bob, 100)).length).toBe(100)
      await expect(db.publish(alice, bob,
        sealMessage(new Uint8Array([101]), 'room:secret', sender, publicDevice(recipient), { senderAccountId: 'alice', recipientAccountId: 'bob' })))
        .rejects.toThrow('E2EE_MAILBOX_FULL')
      expect(await db.acknowledge(bob, [saved.id, saved.id])).toBe(1)
    } finally {
      db.close()
    }
  })

  it('expires ciphertext and deduplication markers according to configured retention', async () => {
    let now = 10_000
    const db = new SqliteEncryptedMailbox(':memory:', allowed, 1000, () => now)
    try {
      const a = generateDeviceIdentity(alice.deviceId)
      const b = generateDeviceIdentity(bob.deviceId)
      const message = sealMessage(new TextEncoder().encode('expiring'), 'room:secret', a, publicDevice(b), { senderAccountId: 'alice', recipientAccountId: 'bob' })
      expect((await db.publish(alice, bob, message)).duplicate).toBe(false)
      now += 500
      expect((await db.publish(alice, bob, message)).duplicate).toBe(true)
      now += 501
      expect(await db.list(bob)).toEqual([])
      expect((await db.publish(alice, bob, message)).duplicate).toBe(false)
    } finally {
      db.close()
    }
  })
})
