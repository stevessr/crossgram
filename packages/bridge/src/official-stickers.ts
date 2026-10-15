import type { IMMediaSource } from './platform.js'
import type {
  IMSticker, IMStickerAsset, IMStickerPack, IMStickerPackPage,
  IMStickerProvider, StickerPageQuery, StickerProviderContext,
} from './sticker-provider.js'

export const TELEGRAM_OFFICIAL_STICKER_PROVIDER_ID = 'telegram-official-stickers'

export interface TelegramOfficialStickerFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  width?: number
  height?: number
  emoji?: string
  is_animated?: boolean
  is_video?: boolean
  thumbnail?: TelegramOfficialStickerThumbnail
  thumb?: TelegramOfficialStickerThumbnail
}

export interface TelegramOfficialStickerThumbnail {
  file_id: string
  file_unique_id: string
  file_size?: number
  width?: number
  height?: number
}

export interface TelegramOfficialStickerSet {
  name: string
  title: string
  stickers: TelegramOfficialStickerFile[]
}

export class TelegramOfficialStickerError extends Error {}

type CacheEntry = { expires: number, value: Promise<IMStickerPack | null> }

const POSITIVE_TTL_MS = 5 * 60_000
const NEGATIVE_TTL_MS = 2 * 60_000
const CACHE_LIMIT = 512

type FileLocator = { fileId: string }

/**
 * On-demand official Telegram sticker catalog backed by the Bot API. Clients
 * request official sets by short name (getStickerSet short=X); without this
 * provider those requests die with STICKERSET_INVALID because the bridge only
 * knows platform-native packs. Sets are fetched live and cached briefly; the
 * provider never lists packs, so it stays out of the installed catalog.
 */
export class TelegramOfficialStickerProvider implements IMStickerProvider {
  readonly capabilities = { canonicalLookup: true }

  private readonly _packs = new Map<string, CacheEntry>()
  private readonly _base: string

  constructor(
    private readonly _token: string,
    apiBase = 'https://api.telegram.org',
    private readonly _fetch: typeof fetch = fetch,
  ) {
    this._base = apiBase.replace(/\/$/u, '')
  }

  /** Nothing in the account-wide installed catalog; resolution is on demand. */
  async listPacks(_context: StickerProviderContext, _query?: StickerPageQuery): Promise<IMStickerPackPage> {
    return { packs: [] }
  }

  async resolveShortName(_context: StickerProviderContext, shortName: string): Promise<IMStickerPack | null> {
    if (!shortName || shortName.length > 128 || /[\u0000-\u001f\x7f/\\]/u.test(shortName)) return null
    let cached = this._packs.get(shortName)
    if (!cached || cached.expires < Date.now()) {
      const value = this._fetchSet(shortName)
      cached = { expires: Date.now() + POSITIVE_TTL_MS, value }
      this._packs.set(shortName, cached)
      if (this._packs.size > CACHE_LIMIT) this._packs.delete(this._packs.keys().next().value!)
      value.catch(() => {
        // Negative results expire sooner than positive ones.
        if (this._packs.get(shortName) === cached) cached!.expires = Date.now() + NEGATIVE_TTL_MS
      })
    }
    return cached.value
  }

  async getPack(context: StickerProviderContext, packId: string): Promise<IMStickerPack | null> {
    return this.resolveShortName(context, packId)
  }

  async getSticker(context: StickerProviderContext, stickerId: string): Promise<IMSticker | null> {
    const parsed = parseStickerId(stickerId)
    if (!parsed) return null
    const pack = await this.resolveShortName(context, parsed.shortName)
    return pack?.stickers.find((sticker) => sticker.stickerId === stickerId) ?? null
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const locator = sticker.locator as unknown as FileLocator | undefined
    if (!locator?.fileId) throw new Error(`Official Telegram sticker ${sticker.stickerId} has no file reference.`)
    return {
      source: this._source(locator.fileId, sticker.size),
      mimeType: sticker.mimeType,
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
    }
  }

  async openThumbnail(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null> {
    const locator = sticker.thumbnail?.locator as unknown as FileLocator | undefined
    if (!locator?.fileId || !sticker.thumbnail) return null
    return {
      source: this._source(locator.fileId, sticker.thumbnail.size),
      mimeType: sticker.thumbnail.mimeType,
      size: sticker.thumbnail.size,
      width: sticker.thumbnail.width,
      height: sticker.thumbnail.height,
    }
  }

  private async _fetchSet(shortName: string): Promise<IMStickerPack | null> {
    const result = await this._call<TelegramOfficialStickerSet>('getStickerSet', { name: shortName })
    const stickers: IMSticker[] = []
    for (const sticker of result.stickers ?? []) {
      const format = sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
      const mimeType = format === 'animated' ? 'application/x-tgsticker' : format === 'video' ? 'video/webm' : 'image/webp'
      const thumbnail = sticker.thumbnail ?? sticker.thumb
      stickers.push({
        providerId: TELEGRAM_OFFICIAL_STICKER_PROVIDER_ID,
        packId: shortName,
        stickerId: JSON.stringify([shortName, sticker.file_unique_id]),
        title: sticker.emoji || result.title,
        emoji: sticker.emoji ? [sticker.emoji] : undefined,
        format, mimeType,
        size: sticker.file_size,
        width: sticker.width,
        height: sticker.height,
        version: stickerVersion(sticker),
        locator: { fileId: sticker.file_id },
        ...(thumbnail ? {
          thumbnail: {
            mimeType: 'image/webp',
            size: thumbnail.file_size ?? 0,
            width: thumbnail.width ?? 0,
            height: thumbnail.height ?? 0,
            locator: { fileId: thumbnail.file_id },
          },
        } : {}),
      })
    }
    return {
      providerId: TELEGRAM_OFFICIAL_STICKER_PROVIDER_ID,
      packId: shortName,
      shortName,
      title: result.title ?? shortName,
      stickers,
      count: stickers.length,
      version: packVersion(shortName, stickers),
    }
  }

  private async _call<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this._base}/bot${this._token}/${method}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    let response: Response
    try {
      response = await this._fetch(url)
    } catch {
      throw new TelegramOfficialStickerError('Telegram Bot API request failed.')
    }
    let body: { ok?: boolean, result?: T, description?: string }
    try {
      body = await response.json() as { ok?: boolean, result?: T, description?: string }
    } catch {
      throw new TelegramOfficialStickerError(`Telegram Bot API request failed (HTTP ${response.status}).`)
    }
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new TelegramOfficialStickerError(`Telegram Bot API ${method} failed (HTTP ${response.status}).`)
    }
    return body.result
  }

  private _source(fileId: string, size?: number): IMMediaSource {
    const api = this
    return {
      size,
      async *stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
        const file = await api._call<{ file_path?: string }>('getFile', { file_id: fileId })
        if (!file.file_path) throw new TelegramOfficialStickerError('Telegram did not return a downloadable sticker file.')
        const response = await api._fetch(`${api._base}/file/bot${api._token}/${file.file_path}`, { signal: options?.signal })
        if (!response.ok || !response.body) {
          throw new TelegramOfficialStickerError(`Telegram sticker download failed (HTTP ${response.status}).`)
        }
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return
            yield value
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      },
    }
  }
}

function parseStickerId(stickerId: string): { shortName: string, fileUniqueId: string } | undefined {
  try {
    const [shortName, fileUniqueId] = JSON.parse(stickerId) as unknown[]
    if (typeof shortName === 'string' && typeof fileUniqueId === 'string') return { shortName, fileUniqueId }
  } catch {}
  return undefined
}

function stickerVersion(sticker: TelegramOfficialStickerFile): number {
  let hash = 2166136261
  const canonical = JSON.stringify([
    sticker.file_unique_id, sticker.emoji ?? null, sticker.is_animated ?? false,
    sticker.is_video ?? false, sticker.width ?? null, sticker.height ?? null, sticker.file_size ?? null,
  ])
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function packVersion(shortName: string, stickers: IMSticker[]): number {
  let hash = 2166136261
  const canonical = JSON.stringify([shortName, stickers.map((sticker) => [sticker.stickerId, sticker.version ?? 0])])
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
