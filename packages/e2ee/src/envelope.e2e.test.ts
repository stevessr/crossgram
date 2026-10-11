import { describe, expect, it } from 'vitest'
import {
  generateDeviceIdentity, openMessage, publicDevice, sealMessage,
  type EncryptedEnvelope, type ReplayGuard,
} from './envelope.js'

/** Simulates an untrusted server which can store, read, replay and misroute JSON. */
class UntrustedRelay {
  private readonly stored: EncryptedEnvelope[] = []
  submit(value: EncryptedEnvelope): void {
    this.stored.push(JSON.parse(JSON.stringify(value)) as EncryptedEnvelope)
  }
  read(index: number): EncryptedEnvelope {
    return JSON.parse(JSON.stringify(this.stored[index])) as EncryptedEnvelope
  }
  dump(): string {
    return JSON.stringify(this.stored)
  }
}

class PersistentReplayStore implements ReplayGuard {
  private readonly seen = new Set<string>()
  async acceptOnce(id: string): Promise<boolean> {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    return true
  }
}

describe('E2EE untrusted-relay E2E boundaries', () => {
  it('server transports ciphertext only; second device needs its own envelope', async () => {
    const alice = generateDeviceIdentity('alice-1')
    const bobPhone = generateDeviceIdentity('bob-phone')
    const bobLaptop = generateDeviceIdentity('bob-laptop')
    const relay = new UntrustedRelay()
    const plaintext = 'private message over hostile infrastructure'
    const bytes = new TextEncoder().encode(plaintext)
    relay.submit(sealMessage(bytes, 'conversation-123', alice, publicDevice(bobPhone), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
    relay.submit(sealMessage(bytes, 'conversation-123', alice, publicDevice(bobLaptop), { senderAccountId: 'alice', recipientAccountId: 'bob' }))
    expect(relay.dump()).not.toContain(plaintext)
    const replay = new PersistentReplayStore()
    expect(new TextDecoder().decode(await openMessage(
      relay.read(0), 'conversation-123', bobPhone, publicDevice(alice), replay,
      { senderAccountId: 'alice', recipientAccountId: 'bob' }))).toBe(plaintext)
    await expect(openMessage(relay.read(0), 'conversation-123', bobLaptop, publicDevice(alice), replay, { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_CONTEXT_MISMATCH')
    expect(new TextDecoder().decode(await openMessage(
      relay.read(1), 'conversation-123', bobLaptop, publicDevice(alice), replay,
      { senderAccountId: 'alice', recipientAccountId: 'bob' }))).toBe(plaintext)
    await expect(openMessage(relay.read(0), 'conversation-123', bobPhone, publicDevice(alice), replay, { senderAccountId: 'alice', recipientAccountId: 'bob' }))
      .rejects.toThrow('E2EE_REPLAY_DETECTED')
  })
})
