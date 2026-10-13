import { describe, expect, it } from 'vitest'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { addPublicKey } from '@mtcute/core/utils.js'
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import * as bridge from '@mtproto-relay/bridge'
import { startApp, waitForPlatformLogin } from './harness.js'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function emptyCaption(): tl.RawPageCaption {
  return { _: 'pageCaption', text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } }
}

function newMessage(updates: tl.RawUpdates): tl.RawMessage {
  const update = updates.updates.find((item) =>
    item._ === 'updateNewMessage' || item._ === 'updateNewChannelMessage') as
    | tl.RawUpdateNewMessage
    | tl.RawUpdateNewChannelMessage
    | undefined
  if (!update) throw new Error('the article send returned no message')
  return update.message as tl.RawMessage
}

/** Bounds one step so a stall names itself instead of only the test timeout. */
async function step<T>(name: string, work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`article e2e stalled in ${name}`)), timeoutMs)
      timer.unref?.()
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A Telegram client posts an article: it uploads its pictures, references them
 * from the article's blocks, and sends an empty body with a rich message. The
 * relay has to turn that into one platform message and hand the article back.
 */
describe('bridge article e2e', () => {
  it('relays an article to the platform and projects it back as an article', async () => {
    const { ctx, port, rsaKey, stop } = await startApp()
    try {
      const login = await waitForPlatformLogin(ctx, 'static')
      addPublicKey(new NodeCryptoProvider(), rsaKey.publicKeyPem, false)
      const dc = { id: 1, ipAddress: '127.0.0.1', port }
      const client = new TelegramClient({
        apiId: 1,
        apiHash: 'crossgram-rich-article-e2e',
        storage: new MemoryStorage(),
        defaultDcs: { main: dc, media: dc },
        updates: {},
        logLevel: 0,
        initConnectionOptions: {
          deviceModel: 'Crossgram article E2E',
          systemVersion: `${process.platform} ${process.arch}`,
          appVersion: '0.1.0',
          systemLangCode: 'en',
          langPack: '',
          langCode: 'en',
        },
      })
      try {
        await step('login', client.start({
          phone: `+${login.auth.virtualPhone}`,
          code: () => bridge.generateLoginCode(login.auth.totpSecret),
        }))

        const target = await step('dialogs', (async () => {
          const dialogs = []
          for await (const dialog of client.iterDialogs({ limit: 100 })) dialogs.push(dialog)
          return dialogs.find((dialog) => (
            (dialog.peer as unknown as { title?: string }).title?.startsWith('Group A')
          ))
        })())
        if (!target) throw new Error('the reference platform exposed no writable group dialog')
        const peer = (target.peer as unknown as { inputPeer: tl.TypeInputPeer }).inputPeer

        const photos: tl.RawInputPhoto[] = []
        for (const [index, name] of ['first.png', 'second.png'].entries()) {
          const fileId = Long.fromNumber(9_000 + index)
          await step(`upload parts ${name}`, client.call({
            _: 'upload.saveFilePart', fileId, filePart: 0, bytes: TINY_PNG,
          }))
          const uploaded = await step(`upload media ${name}`, client.call({
            _: 'messages.uploadMedia',
            peer,
            media: {
              _: 'inputMediaUploadedPhoto',
              file: { _: 'inputFile', id: fileId, parts: 1, name, md5Checksum: '' },
            },
          })) as tl.RawMessageMediaPhoto
          if (uploaded._ !== 'messageMediaPhoto' || uploaded.photo._ !== 'photo') {
            throw new Error('the relay did not materialise an uploaded article picture')
          }
          photos.push({
            _: 'inputPhoto',
            id: uploaded.photo.id,
            accessHash: uploaded.photo.accessHash,
            fileReference: uploaded.photo.fileReference,
          })
        }

        const sent = newMessage(await step('article send', client.call({
          _: 'messages.sendMessage',
          peer,
          message: '',
          randomId: Long.fromNumber(4242),
          richMessage: {
            _: 'inputRichMessage',
            blocks: [
              { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'article lead' } },
              { _: 'pageBlockPhoto', photoId: photos[0]!.id, caption: emptyCaption() },
              { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'article tail' } },
              { _: 'pageBlockPhoto', photoId: photos[1]!.id, caption: emptyCaption() },
            ],
            photos,
          },
        })) as tl.RawUpdates)

        expect(sent.media).toBeUndefined()
        expect(sent.richMessage?.blocks.map((block) => block._)).toEqual([
          'pageBlockParagraph', 'pageBlockPhoto', 'pageBlockParagraph', 'pageBlockPhoto',
        ])
        expect(sent.richMessage?.photos).toHaveLength(2)

        // The article is durable, not just an echo of the send.
        const history = await step('article history', client.call({
          _: 'messages.getHistory',
          peer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 5, maxId: 0, minId: 0, hash: Long.ZERO,
        })) as tl.messages.RawMessages
        const stored = history.messages.find((item) =>
          item._ === 'message' && item.id === sent.id) as tl.RawMessage | undefined
        expect(stored?.richMessage?.blocks).toHaveLength(4)
        expect(stored?.richMessage?.photos).toHaveLength(2)
      } finally {
        await client.destroy()
      }
    } finally {
      await stop()
    }
  }, 30_000)
})
