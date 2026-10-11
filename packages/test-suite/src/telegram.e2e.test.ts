import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Long from 'long'
import { Dialog } from '@mtcute/node'
import { TelegramPlatform } from '@mtproto-relay/platform-telegram'
import { backend, message } from '../../platform-telegram/src/fixtures.js'
import { openE2eClient } from '@mtproto-relay/mtproto-e2e-client'
import { startApp, waitForPlatformLogin } from './harness.js'

// Real encrypted MTProto connection and bridge DB. Telegram upstream is deliberately mocked.
it('relays Telegram dialogs, history, replies, reads and live messages over MTProto, then reconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-relay-e2e-'))
  const { client: upstream, adapterClient } = backend()
  const adapter = new TelegramPlatform(adapterClient)
  const app = await startApp({ platform: { id: 'telegram', adapter } })
  let connection: Awaited<ReturnType<typeof openE2eClient>> | undefined
  try {
    await waitForPlatformLogin(app.ctx, 'telegram')
    const options = {
      root: directory, profile: 'telegram', host: '127.0.0.1', port: app.port,
      publicKeyPem: app.rsaKey.publicKeyPem,
      approval: { kind: 'http' as const, origin: `http://127.0.0.1:${app.ctx.server.port}`, platformId: 'telegram' },
    }
    connection = await openE2eClient(options)
    const result = await connection.client.call({ _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, limit: 5, hash: Long.ZERO })
    if (result._ === 'messages.dialogsNotModified') throw new Error('unexpected dialogs cache')
    const dialogs = Dialog.parseTlDialogs(result)
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].peer.displayName).toBe('Friend')
    const peer = dialogs[0].peer
    const history = await connection.client.getHistory(peer, { limit: 5 })
    expect(history.map(message => message.text)).toContain('hello')
    const sent = await connection.client.sendText(peer, 'relay reply', { replyTo: history[0].id })
    expect(sent.text).toBe('relay reply')
    expect(upstream.sendText).toHaveBeenCalledWith(77, 'relay reply', { replyTo: 10 })
    await connection.client.readHistory(peer, { maxId: history[0].id })
    expect(upstream.readHistory).toHaveBeenCalledWith(77, { maxId: 10 })
    upstream.onNewMessage.emit(message(12, 'live upstream'))
    await expect.poll(async () => {
      const result = await connection!.client.getHistory(peer, { limit: 10 })
      return result.map(message => message.text)
    }).toContain('live upstream')
    await connection.close(); connection = undefined
    connection = await openE2eClient({ ...options, approval: undefined })
    expect(await connection.client.call({ _: 'updates.getState' })).toMatchObject({ _: 'updates.state' })
  } finally {
    await connection?.close()
    await app.stop()
    await adapter.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
