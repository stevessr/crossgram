# Native Telegram user-account adapter (initial text-only implementation)

Connects **from the Crossgram server to official Telegram using MTProto**. It is
not the Bot API, a Telegram proxy, or a change to the Desktop WSS transport.
Existing Crossgram clients can use their existing server connection and select
the `telegram` platform after this adapter has been configured and authorized.

Supported: user identity, direct/group/channel dialogs, bounded history pages,
text sending and replies, new/edited incoming messages, downstream read markers.
Sending images/files, downloading attachments, message deletion, reactions,
secret chats, forum topic separation and cross-device read events are not
implemented. Incoming attachments/service actions are explicit text placeholders.
The delivery queue retries failed handlers in order, but is in memory; sustained
upstream traffic with a failing handler can grow the queue. This is not a durable
Telegram update journal. Do not treat this MVP as a lossless archival solution.

## Authorize privately before enabling the daemon

Obtain your own API ID/hash at https://my.telegram.org/apps (see official mtcute
sign-in documentation: https://mtcute.dev/guide/intro/sign-in).
Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_STORAGE` privately for the
service user, for example in a root-only environment file. `TELEGRAM_STORAGE`
should be `/var/lib/crossgram/data/telegram/session.sqlite` in a **dedicated 0700
directory**, owned by the service user. The adapter refuses public directories,
public session files and final-component session symlinks. Session DB and WAL/SHM
files grant account access: do not commit or send them to anyone.

With those variables exported, run as the same OS user as Crossgram in a private
interactive SSH terminal:

```sh
yarn workspace @mtproto-relay/platform-telegram login
```

Enter phone number, login code and any 2FA password only in that terminal. The
password prompt does not echo input. No authentication fields are served over
WebUI. Stop the adapter before running this command against an existing database;
never run two clients against the same session file simultaneously.

Then add a Cordis entry (keep existing platform entries unchanged):

```yaml
- id: telegram
  name: '@mtproto-relay/platform-telegram'
  config:
    apiId: !!js Number(process.env.TELEGRAM_API_ID)
    apiHash: !!js process.env.TELEGRAM_API_HASH
    storage: !!js process.env.TELEGRAM_STORAGE
```

The daemon calls `getMe()` and fails closed if authorization is missing/revoked;
it never requests a code, prompts on stdin, or starts an unsolicited login flow.
Native Telegram access may need a separately configured upstream network route;
the Crossgram client's CF Tunnel/WSS connection does not proxy this upstream leg.

## Validation

```sh
yarn exec vitest run packages/platform-telegram/src/index.test.ts
yarn exec tsc -p packages/platform-telegram/tsconfig.json --pretty false
yarn build
yarn exec vitest run --config vitest.mtproto-e2e.config.mts packages/test-suite/src/telegram.e2e.test.ts --maxWorkers=1
```

Unit tests use real mtcute message models with fake Telegram RPC methods. The E2E
uses a real authenticated encrypted MTProto socket, bridge DB and reconnectable
client; official Telegram upstream is mocked, so it is **not** proof of a live
Telegram account login or delivery. Validate that separately after authorization
using an explicitly approved test conversation.
