/**
 * Server-only opaque ciphertext mailbox.
 * Import via @mtproto-relay/e2ee/server, never into end-user clients.
 * All authorization identities must be derived from trusted server sessions.
 */
export * from './mailbox.js'
export * from './sqlite-mailbox.js'
