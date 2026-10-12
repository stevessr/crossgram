# `@mtproto-relay/platform-discord`

Discord user-account (userbot/selfbot) adapter for CrossGram.

> [!CAUTION]
> Automating a normal user account violates the Discord Terms of Service and can result in account restriction or termination. Use this adapter only if you understand and accept that risk. A separate account is strongly recommended.

## Setup

Configure the plugin with the user account token:

```yaml
- id: discord
  name: '@mtproto-relay/platform-discord'
  config:
    token: YOUR_USER_TOKEN
    proxy: http://127.0.0.1:7890
```

`proxy` is optional and accepts `http://` or `https://` URLs, including authenticated forms such as `http://user:password@127.0.0.1:7890`. It is applied to Discord REST calls, the Gateway WebSocket, and CDN media downloads.

Private messages, group DMs, guild text/announcement channels, and threads visible to the account are exposed to Telegram. The adapter uses Discord's private user API to synchronize the account's read state.

Discord's **server folders** (groups of guild icons in the left sidebar) are projected as read-only Telegram chat folders. A folder lists its visible guild conversations, preserves Discord's folder order, and updates on user-settings Gateway events. The adapter accepts legacy `guild_folders` and newer protobuf settings, falling back to an on-demand API read when necessary. Discord **channel categories** inside an individual server remain part of that server's forum topics; they are not separate Telegram chat-list folders. If Discord settings cannot be fetched, CrossGram preserves the previously synchronized filters until a successful refresh.

Run the live adapter e2e against a disposable channel with:

```bash
DISCORD_USER_TOKEN=... DISCORD_E2E_CHANNEL_ID=... yarn workspace @mtproto-relay/platform-discord test:e2e
```
