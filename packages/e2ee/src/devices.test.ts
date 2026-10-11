import { describe, expect, it } from 'vitest'
import {
  bundleFingerprint, exportDeviceBundle, getPinnedDevice, MemoryDevicePinStore,
  openFromPinnedDevice, parseDeviceBundle, sealToPinnedDevices, verifyAndPinDevice,
} from './devices.js'
import {
  generateDeviceIdentity, openMessage, publicDevice, MemoryReplayGuard,
} from './envelope.js'

describe('CrossGram E2EE public-device identity exchange', () => {
  it('roundtrips portable public bundles without serializing private keys', () => {
    const alice = generateDeviceIdentity('alice-desktop')
    const wire = exportDeviceBundle(alice)
    expect(Object.keys(wire).sort()).toEqual(['deviceId', 'ed25519', 'v', 'x25519'])
    const serialized = JSON.stringify(wire)
    expect(serialized).not.toContain('PRIVATE KEY')
    expect(parseDeviceBundle(JSON.parse(serialized)).deviceId).toBe(alice.deviceId)
    expect(bundleFingerprint(wire)).toBe(bundleFingerprint(exportDeviceBundle(publicDevice(alice))))
  })

  it('rejects malformed, extra-field, truncated or swapped-algorithm public keys', () => {
    const alice = exportDeviceBundle(generateDeviceIdentity('alice'))
    for (const invalid of [
      {}, { ...alice, v: 2 }, { ...alice, unknown: 'secret' },
      { ...alice, ed25519: '!' }, { ...alice, ed25519: alice.x25519 },
      { ...alice, x25519: alice.ed25519 }, { ...alice, deviceId: '' },
      { ...alice, ed25519: alice.ed25519 + 'A' },
    ]) expect(() => parseDeviceBundle(invalid)).toThrow()
  })

  it('only pins after independently checked fingerprint, then refuses key substitution', async () => {
    const store = new MemoryDevicePinStore()
    const bob = exportDeviceBundle(generateDeviceIdentity('bob-phone'))
    const attacker = exportDeviceBundle(generateDeviceIdentity('bob-phone'))
    await expect(verifyAndPinDevice(store, 'bob-account', attacker, bundleFingerprint(bob)))
      .rejects.toThrow('E2EE_FINGERPRINT_MISMATCH')
    await expect(getPinnedDevice(store, 'bob-account', bob.deviceId))
      .rejects.toThrow('E2EE_DEVICE_UNVERIFIED')
    await verifyAndPinDevice(store, 'bob-account', bob, bundleFingerprint(bob))
    await verifyAndPinDevice(store, 'bob-account', bob, bundleFingerprint(bob))
    await expect(verifyAndPinDevice(store, 'bob-account', attacker, bundleFingerprint(attacker)))
      .rejects.toThrow('E2EE_DEVICE_KEY_CHANGED')
    expect(bundleFingerprint(exportDeviceBundle(
      await getPinnedDevice(store, 'bob-account', bob.deviceId),
    ))).toBe(bundleFingerprint(bob))
  })

  it('isolates pins by local account ID and does not auto-enroll any device', async () => {
    const store = new MemoryDevicePinStore()
    const bob = exportDeviceBundle(generateDeviceIdentity('bob-phone'))
    await verifyAndPinDevice(store, 'bob-account-1', bob, bundleFingerprint(bob))
    await expect(getPinnedDevice(store, 'bob-account-2', bob.deviceId))
      .rejects.toThrow('E2EE_DEVICE_UNVERIFIED')
    await store.revoke('bob-account-1', bob.deviceId)
    await expect(getPinnedDevice(store, 'bob-account-1', bob.deviceId))
      .rejects.toThrow('E2EE_DEVICE_UNVERIFIED')
  })

  it('encrypts per pinned receiver and decrypts only on the right device', async () => {
    const sender = generateDeviceIdentity('alice-desktop')
    const bobPhone = generateDeviceIdentity('bob-phone')
    const bobLaptop = generateDeviceIdentity('bob-laptop')
    const store = new MemoryDevicePinStore()
    for (const device of [bobPhone, bobLaptop]) {
      const bundle = exportDeviceBundle(device)
      await verifyAndPinDevice(store, 'bob-account', bundle, bundleFingerprint(bundle))
    }
    const message = new TextEncoder().encode('你好，端到端加密')
    const envelopes = await sealToPinnedDevices(message, 'chat:alice-bob', sender, store,
      'bob-account', ['bob-phone', 'bob-laptop'], 'alice-account')
    expect(envelopes).toHaveLength(2)
    expect(envelopes[0].ciphertext).not.toBe(envelopes[1].ciphertext)
    for (const [index, recipient] of [bobPhone, bobLaptop].entries()) {
      const opened = await openMessage(envelopes[index], 'chat:alice-bob', recipient,
        publicDevice(sender), new MemoryReplayGuard(), { senderAccountId: 'alice-account', recipientAccountId: 'bob-account' })
      expect(new TextDecoder().decode(opened)).toBe('你好，端到端加密')
    }
    await expect(openMessage(envelopes[0], 'chat:alice-bob', bobLaptop,
      publicDevice(sender), new MemoryReplayGuard(), { senderAccountId: 'alice-account', recipientAccountId: 'bob-account' })).rejects.toThrow('E2EE_CONTEXT_MISMATCH')
  })

  it('authenticates inbound messages against locally pinned senders and revocation', async () => {
    const sender = generateDeviceIdentity('alice')
    const attacker = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const pins = new MemoryDevicePinStore()
    const aliceBundle = exportDeviceBundle(sender)
    await verifyAndPinDevice(pins, 'alice-account', aliceBundle, bundleFingerprint(aliceBundle))
    const bobPins = new MemoryDevicePinStore()
    const bobBundle = exportDeviceBundle(bob)
    await verifyAndPinDevice(bobPins, 'bob-account', bobBundle, bundleFingerprint(bobBundle))
    const trustedEnvelope = (await sealToPinnedDevices(new TextEncoder().encode('verified'),
      'private', sender, bobPins, 'bob-account', ['bob'], 'alice-account'))[0]
    expect(new TextDecoder().decode(await openFromPinnedDevice(trustedEnvelope, 'private',
      bob, pins, 'alice-account', new MemoryReplayGuard(), 'bob-account'))).toBe('verified')

    const forgedEnvelope = (await sealToPinnedDevices(new Uint8Array([1]), 'private', attacker,
      bobPins, 'bob-account', ['bob'], 'alice-account'))[0]
    await expect(openFromPinnedDevice(forgedEnvelope, 'private', bob, pins,
      'alice-account', new MemoryReplayGuard(), 'bob-account')).rejects.toThrow('E2EE_SIGNATURE_INVALID')
    await pins.revoke('alice-account', 'alice')
    await expect(openFromPinnedDevice(trustedEnvelope, 'private', bob, pins,
      'alice-account', new MemoryReplayGuard(), 'bob-account')).rejects.toThrow('E2EE_DEVICE_UNVERIFIED')
  })

  it('fails the whole fan-out before sealing if any target device is unverified', async () => {
    const store = new MemoryDevicePinStore()
    const sender = generateDeviceIdentity('sender')
    const trusted = exportDeviceBundle(generateDeviceIdentity('trusted'))
    await verifyAndPinDevice(store, 'target', trusted, bundleFingerprint(trusted))
    await expect(sealToPinnedDevices(new TextEncoder().encode('secret'), 'chat', sender, store,
      'target', ['trusted', 'unknown'], 'alice-account')).rejects.toThrow('E2EE_DEVICE_UNVERIFIED')
    await expect(sealToPinnedDevices(new Uint8Array(), 'chat', sender, store,
      'target', [], 'alice-account')).rejects.toThrow('E2EE_NO_RECIPIENT_DEVICES')
    await expect(sealToPinnedDevices(new Uint8Array(), 'chat', sender, store,
      'target', ['trusted', 'trusted'], 'alice-account')).rejects.toThrow('E2EE_DUPLICATE_RECIPIENT_DEVICE')
  })
})
