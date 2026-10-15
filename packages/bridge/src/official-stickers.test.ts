import { describe, expect, it, vi } from 'vitest'
import Long from 'long'
import { StickerRpc } from './sticker-rpc.js'
import { StickerProviderRegistry, type IMStickerProvider } from './sticker-provider.js'
import {
  TelegramOfficialStickerProvider, TELEGRAM_OFFICIAL_STICKER_PROVIDER_ID,
} from './official-stickers.js'
import type { IMPlatform, PlatformSession } from './platform.js'

const API_BASE = 'https://api.telegram.test'

function botFetch(responses: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    for (const [method, result] of Object.entries(responses)) {
      if (url.pathname.endsWith(`/${method}`) && url.searchParams.get('name') !== 'NoSuchPack') {
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
      }
    }
    return new Response(JSON.stringify({ ok: false, description: 'STICKERSET_INVALID' }), { status: 400 })
  })
}

function officialStickerSetFixture() {
  return {
    name: 'UtyaDuck',
    title: 'Utya Duck',
    stickers: [{
      file_id: 'file-1', file_unique_id: 'unique-1', emoji: '🐦', is_animated: false,
      width: 512, height: 512, file_size: 12345,
      thumbnail: { file_id: 'thumb-1', file_unique_id: 'thumb-unique-1', width: 128, height: 128, file_size: 4096 },
    }],
  }
}

describe('TelegramOfficialStickerProvider', () => {
  it('resolves short names live and caches them', async () => {
    const fetch = botFetch({ getStickerSet: officialStickerSetFixture() })
    const provider = new TelegramOfficialStickerProvider('token', API_BASE, fetch as unknown as typeof fetch)
    const context = { session: { platformId: 'telegram', platformSessionId: 's' } } as never
    const pack = await provider.resolveShortName(context, 'UtyaDuck')
    expect(pack).toMatchObject({ providerId: TELEGRAM_OFFICIAL_STICKER_PROVIDER_ID, packId: 'UtyaDuck', shortName: 'UtyaDuck' })
    expect(pack?.stickers).toHaveLength(1)
    expect(pack?.stickers[0]).toMatchObject({
      format: 'static', mimeType: 'image/webp', locator: { fileId: 'file-1' },
      thumbnail: { locator: { fileId: 'thumb-1' } },
    })
    await provider.resolveShortName(context, 'UtyaDuck')
    expect(fetch).toHaveBeenCalledTimes(1)

    // Unknown sets fail closed without retry storms.
    await expect(provider.resolveShortName(context, 'NoSuchPack')).rejects.toThrow('Telegram Bot API')
    // The negative cache serves the failure without another network call.
    await expect(provider.resolveShortName(context, 'NoSuchPack')).rejects.toThrow('Telegram Bot API')
    expect(fetch).toHaveBeenCalledTimes(2)

    // Dangerous short names never reach the API.
    await expect(provider.resolveShortName(context, '../bot')).resolves.toBeNull()
    expect((await provider.resolveShortName(context, 'a/b')) === null).toBe(true)
  })

  it('streams sticker bytes through getFile and the file endpoint', async () => {
    const fetch = botFetch({
      getStickerSet: officialStickerSetFixture(),
      getFile: { file_id: 'file-1', file_unique_id: 'unique-1', file_path: 'stickers/webp/duck.webp' },
    })
    fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/getFile?')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'stickers/webp/duck.webp' } }), { status: 200 })
      if (url.includes('/getStickerSet?')) return new Response(JSON.stringify({ ok: true, result: officialStickerSetFixture() }), { status: 200 })
      if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })
      return new Response(JSON.stringify({ ok: false }), { status: 404 })
    })
    const provider = new TelegramOfficialStickerProvider('token', API_BASE, fetch as unknown as typeof fetch)
    const context = { session: { platformId: 'telegram', platformSessionId: 's' } } as never
    const pack = await provider.resolveShortName(context, 'UtyaDuck')
    const sticker = pack!.stickers[0]
    const asset = await provider.openAsset(context, sticker)
    const chunks: Uint8Array[] = []
    for await (const chunk of asset.source.stream()) chunks.push(chunk)
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])])
  })
})

describe('StickerRpc official short-name fallback', () => {
  it('resolves unknown short names through resolveShortName and persists the set id', async () => {
    const registry = new StickerProviderRegistry()
    const official: IMStickerProvider = {
      capabilities: { canonicalLookup: true },
      listPacks: async () => ({ packs: [] }),
      getPack: async (_context, packId) => packId === 'UtyaDuck' ? {
        providerId: 'telegram-official-stickers', packId: 'UtyaDuck', shortName: 'UtyaDuck',
        title: 'Utya Duck', count: 1, version: 7,
        stickers: [{
          providerId: 'telegram-official-stickers', packId: 'UtyaDuck', stickerId: '["UtyaDuck","u1"]',
          title: 'duck', emoji: ['🐦'], format: 'static', mimeType: 'image/webp', version: 9,
        }],
      } : null,
      getSticker: async () => null,
      openAsset: async () => { throw new Error('unused') },
      resolveShortName: async (_context, shortName) => shortName === 'UtyaDuck' ? {
        providerId: 'telegram-official-stickers', packId: 'UtyaDuck', shortName: 'UtyaDuck',
        title: 'Utya Duck', count: 1, version: 7,
        stickers: [{
          providerId: 'telegram-official-stickers', packId: 'UtyaDuck', stickerId: '["UtyaDuck","u1"]',
          title: 'duck', emoji: ['🐦'], format: 'static', mimeType: 'image/webp', version: 9,
        }],
      } : null,
    }
    registry.register('telegram-official-stickers', official)
    const references: any[] = []
    const database = {
      upsert: async (table: string, rows: any[]) => { if (table === 'mtproto_sticker_set_reference') references.push(...rows) },
      get: async (table: string, query: Record<string, unknown>) => table === 'mtproto_sticker_set_reference'
        ? references.filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) : [],
    }
    const rpc = new StickerRpc(database as never, registry, { platformKind: 'telegram' } as IMPlatform,
      { platformId: 'telegram', platformSessionId: 's' } as PlatformSession)
    const result = await rpc.getStickerSet({
      _: 'messages.getStickerSet', stickerset: { _: 'inputStickerSetShortName', shortName: 'UtyaDuck' }, hash: 0,
    })
    expect(result._).toBe('messages.stickerSet')
    const set = (result as { set: { id: Long; accessHash?: Long } }).set
    expect(set.id.toNumber()).toBeGreaterThan(0)
    expect(references).toEqual([expect.objectContaining({
      providerId: 'telegram-official-stickers', providerPackId: 'UtyaDuck',
    })])

    // A follow-up request by Telegram set id now resolves from the reference.
    const byId = await rpc.getStickerSet({
      _: 'messages.getStickerSet',
      stickerset: { _: 'inputStickerSetID', id: set.id, accessHash: set.accessHash ?? Long.ZERO },
      hash: 0,
    })
    expect(byId._).toBe('messages.stickerSet')

    // Unknown short names still fail with the diagnostic suffix.
    await expect(rpc.getStickerSet({
      _: 'messages.getStickerSet', stickerset: { _: 'inputStickerSetShortName', shortName: 'Nope' }, hash: 0,
    })).rejects.toThrow('STICKERSET_INVALID short=Nope')
  })
})
