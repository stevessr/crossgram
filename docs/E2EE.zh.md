# CrossGram E2EE foundation (experimental; NOT enabled)

## Current security boundary

CrossGram is an MTProto **server** for bridging QQ, Matrix, Discord and other
platform accounts into Telegram clients. Its MTProto auth key encrypts traffic
**to the CrossGram server**. The bridge converts messages to platform-specific
requests and can currently read the content. That is *not* end-to-end encryption.

Native Telegram Secret Chats are also not supported yet, even though their
TL constructors are present in the bundled Telegram schema. Sending ciphertext
to QQ/Discord does not magically make their remote clients able to decrypt it.
In particular, adding server-side Matrix Olm/Megolm decryption would make the
CrossGram server the Matrix crypto endpoint, not provide E2EE from the Telegram
client to the Matrix user's own device.

## Implemented prototype

`packages/e2ee/src/envelope.ts` is a **device-side proof of concept** for
client-owned keys and an opaque, authenticated ciphertext envelope. It uses
Node.js OpenSSL implementations of X25519, Ed25519, HKDF-SHA-256 and AES-256-GCM.

- Per-device signing and agreement key pairs must be generated **on the client**.
- The caller must obtain and verify the recipient's device keys via a separate,
  authenticated channel (e.g. QR / safety-number comparison, protected directory).
- Every message has a fresh ephemeral X25519 key, salt and nonce. The sender
  signs all envelope fields with its pinned Ed25519 device identity.
- Conversation ID, both device IDs and recipient public key fingerprint are
  authenticated associated data, preventing cross-chat/recipient substitution.
- The receiving client verifies the pinned sender signature, checks AEAD
  authenticity and uses an **atomic, durable** replay guard.
- A multi-device recipient receives **one separately encrypted envelope per
  authorized device**; arbitrary extra devices must never be silently trusted.
- Existing bridge messages and external platform payloads remain unchanged.

**This does not ship an operational E2EE chat feature.** This code is not wired
into Telegram clients, Bridge RPCs, databases or remote network adapters. It
does not implement Telegram Secret Chats, Matrix Megolm, Signal Double Ratchet,
device key transparency, backup/recovery, per-message forward secrecy,
post-compromise security, attachments or group membership rekeying. In this
scheme compromising a recipient's long-term X25519 private key can decrypt
recorded envelopes. Ephemeral sender keys alone do **not** fix this.

`MemoryReplayGuard` is only for tests/demos: accepting previously seen
messages after a restart is possible unless a durable guard atomically records
accepted envelope IDs. This module should not be deployed without an independent
cryptographic review and production state-management implementation.

## Before any production rollout

1. **Threat model & scope:** choose CrossGram-native contacts versus bridging
   external chats. In the latter case, explicit bridge endpoints are trusted
   plaintext gateways, so a full device-to-device E2EE claim is not possible.
2. **Protocol selection:** prefer a widely deployed, reviewed E2EE session
   implementation (such as a compatible Telegram Secret Chat stack for
   supported device-to-device native peers, or a mature Double Ratchet/MLS
   implementation) instead of expanding this demo into a new protocol.
3. **Identity and trust:** authenticated account/device binding; safety number
   UI, explicit key-change warnings, anti-equivocation/key transparency and
   no silent device auto-enrollment.
4. **Transport & durability:** a server-blind ciphertext mailbox, durable
   idempotent per-device delivery, offline queue and replay tracking. Only
   enrolled native recipients can be targeted; external adapter users must
   not be represented as decrypting E2EE devices.
5. **Client changes:** update desktop and Android forks to encrypt before
   `messages.sendMessage` or a dedicated authenticated transport API, decrypt
   after receipt, and keep plaintext out of telemetry, logs, previews and
   server-side search. Disable incompatible features explicitly.
6. **Advanced security:** Double Ratchet for forward secrecy/post-compromise
   recovery, signed prekeys and one-time prekeys for asynchronous setup,
   per-device revocation, group key changes, encrypted file streaming,
   backups, rollback/migration and independent review.
7. **Tests:** real sender/recipient process tests, offline delivery and
   synchronization, hostile server mutation/replay tests, restart scenarios
   on SQLite/Postgres, CI compatibility with each supported client fork.

## Development validation

- Unit: `yarn vitest run packages/e2ee/src/envelope.test.ts`
- E2E relay simulation: `yarn vitest run --config vitest.mtproto-e2e.config.mts packages/e2ee/src/envelope.e2e.test.ts`
- Typecheck: `yarn typecheck`

These tests exercise the local primitive, not full client-to-client E2EE.
