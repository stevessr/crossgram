import { describe, expect, it } from 'vitest'
import { MemoryEncryptedMailbox, type AuthenticatedDevice } from './mailbox.js'
import {
  MemoryReplayGuard, generateDeviceIdentity, openMessage, publicDevice, sealMessage,
} from './envelope.js'
import {
  MemoryDevicePinStore, bundleFingerprint, exportDeviceBundle, openFromPinnedDevice,
  sealToPinnedDevices, verifyAndPinDevice,
} from './devices.js'

const alice: AuthenticatedDevice = { accountId: 'alice', deviceId: 'alice-desktop' }
const bobPhone: AuthenticatedDevice = { accountId: 'bob', deviceId: 'bob-phone' }
const bobLaptop: AuthenticatedDevice = { accountId: 'bob', deviceId: 'bob-laptop' }
const mallory: AuthenticatedDevice = { accountId: 'mallory', deviceId: 'bob-phone' }

describe('opaque E2EE mailbox transport', () => {
  it('connects pinned sender and two pinned recipients through an untrusted JSON relay', async () => {
    const sender = generateDeviceIdentity(alice.deviceId)
    const receiverPhone = generateDeviceIdentity(bobPhone.deviceId)
    const receiverLaptop = generateDeviceIdentity(bobLaptop.deviceId)
    const receiverPins = new MemoryDevicePinStore()
    const senderPins = new MemoryDevicePinStore()
    const senderBundle = exportDeviceBundle(sender)
    await verifyAndPinDevice(senderPins, 'alice', senderBundle, bundleFingerprint(senderBundle))
    for (const receiver of [receiverPhone, receiverLaptop]) {
      const bundle = exportDeviceBundle(receiver)
      await verifyAndPinDevice(receiverPins, 'bob', bundle, bundleFingerprint(bundle))
    }
    let time = 12345
    const relay = new MemoryEncryptedMailbox(async (from, to, conversation) =>
      from.accountId === 'alice' && to.accountId === 'bob' && conversation === 'native:chat:1',
    60_000, () => time)
    const privateText = 'this message must never appear as server plaintext'
    const outgoing = await sealToPinnedDevices(new TextEncoder().encode(privateText),
      'native:chat:1', sender, receiverPins, 'bob', [bobPhone.deviceId, bobLaptop.deviceId], 'alice')
    expect(outgoing).toHaveLength(2)

    const ids = []
    for (const [i, recipient] of [bobPhone, bobLaptop].entries()) {
      const result = await relay.publish(alice, recipient, JSON.parse(JSON.stringify(outgoing[i])))
      ids.push(result.id)
      expect(result.duplicate).toBe(false)
    }
    expect(JSON.stringify(await relay.list(bobPhone))).not.toContain(privateText)
    expect((await relay.list(bobPhone)).length).toBe(1)
    expect((await relay.list(bobLaptop)).length).toBe(1)

    const acceptedPhone = await relay.list(bobPhone)
    const opened = await openFromPinnedDevice(acceptedPhone[0].envelope,
      'native:chat:1', receiverPhone, senderPins, 'alice', new MemoryReplayGuard(), 'bob')
    expect(new TextDecoder().decode(opened)).toBe(privateText)
    expect(await relay.acknowledge(bobPhone, ids)).toBe(1)
    expect(await relay.list(bobPhone)).toEqual([])
    expect((await relay.list(bobLaptop)).length).toBe(1)
    expect((await relay.publish(alice, bobPhone, outgoing[0])).duplicate).toBe(true)

    await expect(openMessage(outgoing[1], 'native:chat:1', receiverPhone,
      publicDevice(sender), new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'bob' })).rejects.toThrow('E2EE_CONTEXT_MISMATCH')
    expect(new TextDecoder().decode(await openFromPinnedDevice((await relay.list(bobLaptop))[0].envelope,
      'native:chat:1', receiverLaptop, senderPins, 'alice', new MemoryReplayGuard(), 'bob'))).toBe(privateText)
    time += 60_001
    expect(await relay.list(bobLaptop)).toEqual([])
  })

  it('rejects forged sender sessions, recipient mismatches, and unauthorized conversations', async () => {
    const aliceKey = generateDeviceIdentity(alice.deviceId)
    const bobKey = generateDeviceIdentity(bobPhone.deviceId)
    const envelope = sealMessage(new TextEncoder().encode('secret'), 'known', aliceKey, publicDevice(bobKey), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    const relay = new MemoryEncryptedMailbox(async (from, to, conversation) =>
      from.accountId === 'alice' && to.accountId === 'bob' && conversation === 'known')
    await expect(relay.publish({ accountId: 'alice', deviceId: 'other' }, bobPhone, envelope))
      .rejects.toThrow('E2EE_MAILBOX_DEVICE_MISMATCH')
    await expect(relay.publish(alice, { accountId: 'bob', deviceId: 'other' }, envelope))
      .rejects.toThrow('E2EE_MAILBOX_DEVICE_MISMATCH')
    await expect(relay.publish(mallory, bobPhone, envelope))
      .rejects.toThrow('E2EE_MAILBOX_DEVICE_MISMATCH')
    await expect(relay.publish({ accountId: 'other', deviceId: alice.deviceId }, bobPhone, envelope))
      .rejects.toThrow('E2EE_MAILBOX_UNAUTHORIZED')
    await expect(relay.publish(alice, bobPhone, { ...envelope, conversationId: 'unknown' }))
      .rejects.toThrow('E2EE_MAILBOX_UNAUTHORIZED')
    expect(await relay.list(bobPhone)).toEqual([])
  })

  it('acknowledges only the authenticated recipient; returns defensive copies', async () => {
    const a = generateDeviceIdentity(alice.deviceId)
    const b = generateDeviceIdentity(bobPhone.deviceId)
    const mailbox = new MemoryEncryptedMailbox(async () => true)
    const data = sealMessage(new Uint8Array([1, 2, 3]), 'chat', a, publicDevice(b), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    const accepted = await mailbox.publish(alice, bobPhone, data)
    const foreign = { accountId: 'stranger', deviceId: bobPhone.deviceId }
    expect(await mailbox.acknowledge(foreign, [accepted.id])).toBe(0)
    expect(await mailbox.acknowledge(mallory, [accepted.id])).toBe(0)
    const list = await mailbox.list(bobPhone)
    list[0].envelope.signature = 'tampered'
    expect((await mailbox.list(bobPhone))[0].envelope.signature).toBe(data.signature)
    expect(await mailbox.acknowledge(bobPhone, [accepted.id])).toBe(1)
    expect(await mailbox.acknowledge(bobPhone, [accepted.id])).toBe(0)
  })

  it('bounded queue rejects overflow and invalid limits', async () => {
    const a = generateDeviceIdentity(alice.deviceId)
    const b = generateDeviceIdentity(bobPhone.deviceId)
    const mailbox = new MemoryEncryptedMailbox(async () => true)
    for (let i = 0; i < 100; i++) {
      await mailbox.publish(alice, bobPhone, sealMessage(new Uint8Array([i]), 'chat', a, publicDevice(b), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
    }
    expect((await mailbox.list(bobPhone)).length).toBe(50)
    expect((await mailbox.list(bobPhone, 100)).length).toBe(100)
    await expect(mailbox.publish(alice, bobPhone, sealMessage(new Uint8Array([101]), 'chat', a, publicDevice(b), { senderAccountId: 'alice', recipientAccountId: 'bob' })))
      .rejects.toThrow('E2EE_MAILBOX_FULL')
    await expect(mailbox.list(bobPhone, 101)).rejects.toThrow('E2EE_INVALID_MAILBOX_LIMIT')
    await expect(mailbox.acknowledge(bobPhone, ['../escape'])).rejects.toThrow('E2EE_INVALID_DELIVERY_IDS')
  })
})
