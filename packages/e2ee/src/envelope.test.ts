import { describe, expect, it } from 'vitest'
import {
  MemoryReplayGuard, deviceFingerprint, generateDeviceIdentity,
  openMessage, parseEnvelope, publicDevice, sealMessage,
  type EncryptedEnvelope,
} from './envelope.js'

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

describe('CrossGram experimental E2EE envelope', () => {
  it('roundtrips messages in both directions with independently pinned identities', async () => {
    const alice = generateDeviceIdentity('alice-laptop')
    const bob = generateDeviceIdentity('bob-phone')
    const guard = new MemoryReplayGuard()
    const first = sealMessage(encode('hello 你好'), 'chat:42', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    expect(first.v).toBe(2)
    expect(JSON.stringify(first)).not.toContain('hello 你好')
    expect(decode(await openMessage(first, 'chat:42', bob, publicDevice(alice), guard, { senderAccountId: 'alice', recipientAccountId: 'bob' }))).toBe('hello 你好')
    const reply = sealMessage(encode('world'), 'chat:42', bob, publicDevice(alice), { senderAccountId: 'bob', recipientAccountId: 'alice' })
    expect(decode(await openMessage(reply, 'chat:42', alice, publicDevice(bob), guard, { senderAccountId: 'bob', recipientAccountId: 'alice' }))).toBe('world')
  })

  it('randomizes both ciphertext and ephemeral key on repeated plaintext', () => {
    const alice = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const x = sealMessage(encode('repeat'), 'private-chat', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    const y = sealMessage(encode('repeat'), 'private-chat', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    expect(x.ciphertext).not.toBe(y.ciphertext)
    expect(x.ephemeralPublicKey).not.toBe(y.ephemeralPublicKey)
  })

  it('rejects server-side field modification or forgery', async () => {
    const alice = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const message = sealMessage(encode('top-secret'), 'a', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    const tamper: Array<keyof EncryptedEnvelope> = [
      'senderAccountId', 'recipientAccountId', 'conversationId',
      'senderDeviceId', 'recipientDeviceId', 'recipientKeyId',
      'ephemeralPublicKey', 'salt', 'nonce', 'ciphertext', 'tag', 'signature',
    ]
    for (const field of tamper) {
      const changed = { ...message, [field]: field.endsWith('Id') ? 'other' : 'AAAA' }
      await expect(openMessage(changed, 'a', bob, publicDevice(alice), new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'bob' })).rejects.toThrow()
    }
  })

  it('fails closed if recipient or signer identity is substituted', async () => {
    const alice = generateDeviceIdentity('alice')
    const mallory = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const otherBob = generateDeviceIdentity('bob')
    const message = sealMessage(encode('secret'), 'dialog', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    await expect(openMessage(message, 'dialog', bob, publicDevice(mallory), new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_SIGNATURE_INVALID')
    await expect(openMessage(message, 'dialog', otherBob, publicDevice(alice), new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_RECIPIENT_KEY_MISMATCH')
    await expect(openMessage(message, 'different', bob, publicDevice(alice), new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_CONTEXT_MISMATCH')
  })

  it('rejects cross-account relabeling even with the correct devices and conversation', async () => {
    const alice = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const original = sealMessage(encode('bound to account identities'), 'room:42',
      alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })

    await expect(openMessage(original, 'room:42', bob, publicDevice(alice),
      new MemoryReplayGuard(), { senderAccountId: 'attacker', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_CONTEXT_MISMATCH')
    await expect(openMessage(original, 'room:42', bob, publicDevice(alice),
      new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'other-recipient' }))
      .rejects.toThrow('E2EE_CONTEXT_MISMATCH')
    await expect(openMessage({ ...original, senderAccountId: 'attacker' }, 'room:42',
      bob, publicDevice(alice), new MemoryReplayGuard(),
      { senderAccountId: 'attacker', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_SIGNATURE_INVALID')
    await expect(openMessage({ ...original, recipientAccountId: 'other-recipient' },
      'room:42', bob, publicDevice(alice), new MemoryReplayGuard(),
      { senderAccountId: 'alice', recipientAccountId: 'other-recipient' }))
      .rejects.toThrow('E2EE_SIGNATURE_INVALID')
    expect(() => parseEnvelope({ ...original, v: 1 })).toThrow('E2EE_MALFORMED_ENVELOPE')
  })

  it('rejects exact replay after successful verification and decryption', async () => {
    const alice = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const guard = new MemoryReplayGuard()
    const message = sealMessage(encode('once'), 'dialog', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    await openMessage(message, 'dialog', bob, publicDevice(alice), guard, { senderAccountId: 'alice', recipientAccountId: 'bob' })
    await expect(openMessage(message, 'dialog', bob, publicDevice(alice), guard, { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_REPLAY_DETECTED')
  })

  it('provides a stable human-verifiable fingerprint, not a substitute for verification', () => {
    const alice = generateDeviceIdentity('alice')
    const otherAlice = generateDeviceIdentity('alice')
    expect(deviceFingerprint(publicDevice(alice))).toHaveLength(64)
    expect(deviceFingerprint(publicDevice(alice))).not.toBe(deviceFingerprint(publicDevice(otherAlice)))
  })

  it('rejects malformed envelopes and overlarge plaintext', () => {
    const alice = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const message = sealMessage(encode('valid'), 'dialog', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    expect(parseEnvelope(message)).toEqual(message)
    expect(() => parseEnvelope({ ...message, v: 9 })).toThrow('E2EE_MALFORMED_ENVELOPE')
    expect(() => parseEnvelope({ ...message, extra: 'surprise' })).toThrow('E2EE_MALFORMED_ENVELOPE')
    expect(() => parseEnvelope({ ...message, ciphertext: '?bad' })).toThrow('E2EE_INVALID_ENCODING')
    expect(() => parseEnvelope({ ...message, nonce: 'AA' })).toThrow('E2EE_INVALID_ENCODING')
    expect(() => parseEnvelope({ ...message, tag: 'AA' })).toThrow('E2EE_INVALID_ENCODING')
    expect(() => parseEnvelope({ ...message, signature: 'AA' })).toThrow('E2EE_INVALID_ENCODING')
    expect(() => sealMessage(new Uint8Array(256 * 1024 + 1), 'dialog', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .toThrow('E2EE_MESSAGE_TOO_LARGE')
  })

  it('permits zero-byte authenticated messages', async () => {
    const alice = generateDeviceIdentity('alice')
    const bob = generateDeviceIdentity('bob')
    const message = sealMessage(new Uint8Array(), 'dialog', alice, publicDevice(bob), { senderAccountId: 'alice', recipientAccountId: 'bob' })
    expect((await openMessage(message, 'dialog', bob, publicDevice(alice), new MemoryReplayGuard(), { senderAccountId: 'alice', recipientAccountId: 'bob' })).length).toBe(0)
  })
})
