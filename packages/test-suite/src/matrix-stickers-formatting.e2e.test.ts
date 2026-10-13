import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import Long from 'long'
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import * as bridge from '@mtproto-relay/bridge'
import { MatrixPlatform } from '../../platform-matrix/src/index.js'
import { MatrixStickerProvider } from '../../platform-matrix/src/stickers.js'
import { startApp, waitForPlatformLogin } from './harness.js'

/** Real encrypted MTProto -> bridge -> Matrix HTTP, no production messages. */
describe('Matrix sticker catalogs and rich formatting over MTProto', () => {
  it('loads room/global sets on a cold client and carries formatting in both directions', async () => {
    const pack = (name: string) => ({ images: { [name]: { url: `mxc://test/${name}`, info: { mimetype: 'image/png', w: 64, h: 64 } } } })
    const state = [
      { type: 'm.room.name', state_key: '', content: { name: 'Matrix fixture' } },
      { type: 'm.room.image_pack', state_key: 'local', content: pack('local') },
      { type: 'im.ponies.room_emotes', state_key: 'global', content: pack('global') },
    ]
    const event = { type: 'm.room.message', event_id: '$rich', sender: '@me:test', origin_server_ts: 1700000000000,
      content: { msgtype: 'm.text', body: '**😀bold** _italic_ ~~strike~~', format: 'org.matrix.custom.html',
        formatted_body: '<strong>😀bold</strong> <em>italic</em> <del>strike</del> <u>under</u> <code>code</code> <span data-mx-spoiler>secret</span> <a href="https://example.org">link</a>' } }
    const sent: any[] = []
    const server = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url!, 'http://fixture').pathname)
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.setHeader('content-type', 'application/json')
      const reply = (body: unknown) => res.end(JSON.stringify(body))
      if (path.endsWith('/account/whoami')) return reply({ user_id: '@me:test' })
      if (path.includes('/profile/')) return reply({ displayname: 'Me' })
      if (path.endsWith('/sync')) return reply({ next_batch: 's1', account_data: { events: [
        { type: 'im.ponies.emote_rooms', content: { rooms: { '!room:test': { global: {} } } } },
        { type: 'm.image_pack.rooms', content: { rooms: {} } },
        { type: 'im.ponies.user_emotes', content: pack('personal') },
        { type: 'm.image_pack', content: {} },
      ] }, rooms: { join: { '!room:test': { state: { events: state }, timeline: { events: [event] } } } } })
      if (path.endsWith('/state')) return reply(state)
      if (path.endsWith('/event/$rich')) return reply(event)
      if (path.endsWith('/messages')) return reply({ chunk: [event], end: 'end' })
      if (path.endsWith('/m.annotation')) return reply({ chunk: [] })
      if (path.includes('/send/m.room.message/')) { sent.push(JSON.parse(Buffer.concat(chunks).toString())); return reply({ event_id: '$sent' }) }
      res.statusCode = 404; reply({ errcode: 'M_NOT_FOUND' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const platform = new MatrixPlatform({ homeserver: `http://127.0.0.1:${(server.address() as any).port}`, accessToken: 'fixture', userId: '@me:test' })
    platform.subscribe = async () => () => {}
    const app = await startApp({ platform: { id: 'matrix', adapter: platform } })
    const dc = { id: 1, ipAddress: '127.0.0.1', port: app.port }
    const client = new TelegramClient({ apiId: 1, apiHash: 'matrix-format-fixture', storage: new MemoryStorage(), defaultDcs: { main: dc, media: dc }, updates: {}, logLevel: 0,
      initConnectionOptions: { deviceModel: 'Matrix fixture', systemVersion: 'test', appVersion: '1', systemLangCode: 'en', langPack: '', langCode: 'en' } })
    try {
      app.ctx.imSticker.register(new MatrixStickerProvider(platform.client, 'matrix:stickers', 'matrix', id => platform.getStickerSources(id)), 'matrix:stickers')
      const login = await waitForPlatformLogin(app.ctx, 'matrix')
      await client.start({ phone: `+${login.auth.virtualPhone}`, code: () => bridge.generateLoginCode(login.auth.totpSecret) })
      const dialogs = await client.call({ _: 'messages.getDialogs', offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO })
      if (dialogs._ === 'messages.dialogsNotModified') throw new Error('No dialogs')
      const chat = dialogs.chats.find(c => c._ === 'channel' && c.title === 'Matrix fixture')
      if (chat?._ !== 'channel') throw new Error('No room')
      const channel = { _: 'inputChannel' as const, channelId: chat.id, accessHash: chat.accessHash! }
      const peer = { _: 'inputPeerChannel' as const, channelId: chat.id, accessHash: chat.accessHash! }
      const full = await client.call({ _: 'channels.getFullChannel', channel })
      if (full.fullChat._ !== 'channelFull' || !full.fullChat.stickerset) throw new Error('No room pack')
      const set = full.fullChat.stickerset
      const request = { _: 'messages.getStickerSet' as const, stickerset: { _: 'inputStickerSetID' as const, id: set.id, accessHash: set.accessHash }, hash: 0 }
      for (let i = 0; i < 2; i++) {
        if (i) app.ctx.imSticker.touch('matrix:stickers')
        const loaded = await client.call(request)
        if (loaded._ !== 'messages.stickerSet') throw new Error('No set content')
        expect(loaded.documents).toHaveLength(3)
      }
      const all = await client.call({ _: 'messages.getAllStickers', hash: Long.ZERO })
      if (all._ !== 'messages.allStickers') throw new Error('No catalog')
      expect(all.sets).toHaveLength(2)
      const history = await client.call({ _: 'messages.getHistory', peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: Long.ZERO })
      if (history._ === 'messages.messagesNotModified') throw new Error('No history')
      const rich = history.messages.find(m => m._ === 'message')
      if (rich?._ !== 'message') throw new Error('No message')
      expect(rich.message).toBe('😀bold italic strike under code secret link')
      expect(rich.entities?.map(e => e._)).toEqual(expect.arrayContaining(['messageEntityBold', 'messageEntityItalic', 'messageEntityStrike', 'messageEntityUnderline', 'messageEntityCode', 'messageEntitySpoiler', 'messageEntityTextUrl']))
      await client.call({ _: 'messages.sendMessage', peer, message: '😀bold italic strike under code secret link', randomId: Long.fromNumber(98765), entities: rich.entities })
      expect(sent).toHaveLength(1)
      expect(sent[0].formatted_body).toContain('<strong>😀bold</strong>')
      expect(sent[0].formatted_body).toContain('<span data-mx-spoiler>secret</span>')
      expect(sent[0].formatted_body).toContain('<a href="https://example.org">link</a>')
      expect(sent[0].formatted_body).toContain('<em>italic</em>')
      expect(sent[0].formatted_body).toContain('<del>strike</del>')
      expect(sent[0].formatted_body).toContain('<u>under</u>')
      expect(sent[0].formatted_body).toContain('<code>code</code>')
      await client.call({ _: 'messages.sendMessage', peer, message: 'quote\n  code\nnext', randomId: Long.fromNumber(98766), entities: [
        { _: 'messageEntityBlockquote', offset: 0, length: 5 },
        { _: 'messageEntityPre', offset: 6, length: 11, language: 'typescript' },
      ] })
      expect(sent[1].formatted_body).toContain('<blockquote>quote</blockquote>')
      expect(sent[1].formatted_body).toContain('<pre><code class="language-typescript">  code\nnext</code></pre>')
      await client.call({ _: 'messages.editMessage', peer, id: rich.id, message: 'plain replacement', entities: [] })
      expect(sent[2]['m.new_content']).toMatchObject({ body: 'plain replacement' })
      expect(sent[2]['m.new_content']).not.toHaveProperty('formatted_body')
      expect(sent[2]).not.toHaveProperty('formatted_body')
    } finally {
      await client.destroy(); await app.stop(); await platform.stop()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 30_000)
})
