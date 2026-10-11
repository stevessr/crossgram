# Experimental native Telegram RPC gateway

This is a dual-termination gateway, not a transparent byte-level MTProxy.
The downstream client trusts CrossGram's RSA key; CrossGram independently establishes
and persists an official Telegram authorization using mtcute. The gateway can see
login codes, RPC arguments, messages and media. Password login forwards Telegram's
SRP challenge/proof, not a plaintext two-step-verification password.

## Routing and configuration

Keep disabled until local tests and an explicitly approved private-account test pass.
Load this plugin alongside the existing MTProto bridge:

```yaml
- id: telegram-gateway
  name: '@mtproto-relay/telegram-gateway'
  config:
    enabled: true
    storage: /var/lib/crossgram/telegram-gateway
    allowedPhones: ['15551234567'] # replace with your own approved test number
    maxSessions: 20
    sendCodeIntervalMs: 60000
```

Add the entry to the service's active `app.yml`; no default configuration is changed.
The storage directory must be private (0700), owned by the service user. Route metadata,
opaque authorization tickets and SQLite sessions are credentials; exclude the whole
directory from Git, public HTTP routes, log uploads and unencrypted backups.

Existing local bindings and numbers registered in the bridge database keep using the
local bridge. Other numbers must be explicitly allow-listed. Selection is sticky per
permanent downstream authorization key, never shared merely by phone number. To change
an account, log out or create a new authorization. Removing a phone from configuration
and reloading the plugin denies persisted routes for that phone.

Supported paths: phone-code login, SRP password verification, structured RPC errors,
raw RPC/vector/Bool forwarding, raw update push, logical DC routing, opaque cross-key
DC authorization transfer, media upload/download, upstream SQLite session restoration,
and logout cleanup of imported descendants. All advertised Telegram DC addresses are
rewritten to the gateway endpoint. Downstream DH carries the logical DC identifier;
it is retained for permanent and PFS keys across reconnects. File downloads disable
Telegram's separate encrypted CDN protocol and use ordinary file DCs.

## Explicit boundaries

- Native Telegram QR login is **not implemented**. Initial unselected QR login remains
  CrossGram-local; routed native QR operations fail explicitly rather than exposing an
  upstream token that could select the wrong account.
- This does not add WSS support to Desktop. CF CDN requires a WSS-capable client/transport;
  merely replacing a TCP address with a CDN domain is insufficient.
- This does not claim complete compatibility with every Telegram layer, call transport,
  encrypted secret-chat flow or client-specific authorization-management operation.
- Tests use local MTProto upstream servers, not Telegram production. No production
  account login or deployment is implied by a passing suite.

## Validation

```sh
yarn vitest run packages/telegram-gateway/src packages/mtproto/src/session/auth-key-store.test.ts
yarn vitest run --config vitest.mtproto-e2e.config.mts packages/test-suite/src/telegram-gateway.e2e.test.ts --maxWorkers=1
yarn typecheck
yarn build
```

The encrypted-socket suite verifies independent downstream/upstream DH keys, invalid
codes, real SRP proofs (including wrong-password rejection), update push, DC2 auth
transfer, byte-exact media transfer and gateway restart without another code request.
