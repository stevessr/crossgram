import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  IMMediaInput, IMMediaSource, IMMediaUploadHashes, IMMediaUploadPreparation, IMMediaUploadSink,
} from './platform.js'

const FILE_10M_BYTES = 10 * 1024 * 1024
const MAX_PREPARED_OUT_OF_ORDER_PARTS = 32
const MAX_PREPARED_OUT_OF_ORDER_BYTES = 16 * 1024 * 1024

export interface UploadedFile {
  platformSessionId: string
  fileId: string
  source: IMMediaSource
  native?: boolean
  cleanup(): Promise<void>
}

export interface StagedMedia {
  media: IMMediaInput
  upload: UploadedFile
  /** Telegram `upload.file.mtime` and photo/document `date`, in seconds. */
  timestamp: number
  /** Last stage or part accepted, in milliseconds, for abandoned-upload sweeps. */
  updatedAt: number
}

interface PreparedUpload {
  platformSessionId: string
  fileId: string
  media: IMMediaInput
  sink: IMMediaUploadSink
  hashes: IMMediaUploadHashes
  parts: Map<number, Buffer>
  bufferedBytes: number
  nextPart: number
  receivedBytes: number
  md5: ReturnType<typeof createHash>
  sha1: ReturnType<typeof createHash>
  file10MMd5: ReturnType<typeof createHash>
  file10MBytes: number
  /** Last part accepted, so an abandoned stream can be told from a slow one. */
  updatedAt: number
  tail: Promise<void>
  failed?: unknown
}

/** Result of one abandoned-upload sweep, for logging and tests. */
export interface UploadSweepResult {
  staged: number
  prepared: number
  directories: number
}

/** Veto for one upload a sweep would otherwise release. */
export type UploadKeepPredicate = (platformSessionId: string, fileId: string) => boolean

/**
 * How long an upload may sit without progress before it is treated as
 * abandoned. A client sends the media it staged within seconds; the generous
 * hour only exists so a slow legacy part upload (whose directory mtime is
 * refreshed by every part) is never cut off mid-transfer.
 */
export const UPLOAD_ABANDONED_TTL_MS = 60 * 60 * 1_000

/** Telegram uploads: prepared native sinks stay in memory; legacy clients use disk-backed parts. */
export class UploadManager {
  private readonly _staged = new Map<string, StagedMedia>()
  private readonly _prepared = new Map<string, PreparedUpload>()

  constructor(private readonly _root: string) {}

  async savePart(
    platformSessionId: string,
    fileId: string,
    part: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!Number.isSafeInteger(part) || part < 0) throw new RangeError('file part must be a non-negative integer')
    const key = this._stageKey(platformSessionId, fileId)
    const prepared = this._prepared.get(key)
    if (prepared) return this._savePreparedPart(prepared, part, bytes)
    if (this._staged.get(key)?.upload.native) return
    const directory = this._directory(platformSessionId, fileId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, partName(part)), bytes)
  }

  async open(platformSessionId: string, fileId: string, parts: number): Promise<UploadedFile> {
    if (!Number.isSafeInteger(parts) || parts <= 0) throw new RangeError('file parts must be a positive integer')
    const directory = this._directory(platformSessionId, fileId)
    const entries = await readdir(directory).catch(() => [])
    const expected = Array.from({ length: parts }, (_, part) => partName(part))
    const available = new Set(entries)
    const missing = expected.find((name) => !available.has(name))
    if (missing) throw new Error(`uploaded file part is missing: ${Number(missing)}`)
    const sizes = await Promise.all(expected.map((name) => stat(join(directory, name)).then((item) => item.size)))
    const size = sizes.reduce((sum, value) => sum + value, 0)
    return {
      platformSessionId,
      fileId,
      source: {
        size,
        async *stream(options = {}) {
          for (const name of expected) {
            if (options.signal?.aborted) throw options.signal.reason ?? new Error('upload aborted')
            for await (const chunk of createReadStream(join(directory, name), { signal: options.signal })) {
              yield chunk
            }
          }
        },
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  }

  async remove(platformSessionId: string, fileId: string): Promise<void> {
    const key = this._stageKey(platformSessionId, fileId)
    this._staged.delete(key)
    const prepared = this._prepared.get(key)
    if (prepared) {
      this._prepared.delete(key)
      await prepared.sink.abort(new Error('upload removed'))
    }
    await rm(this._directory(platformSessionId, fileId), { recursive: true, force: true })
  }

  stage(staged: StagedMedia): void {
    this._staged.set(this._stageKey(staged.upload.platformSessionId, staged.upload.fileId), staged)
  }

  stagePrepared(platformSessionId: string, fileId: string, media: IMMediaInput): StagedMedia {
    const upload: UploadedFile = {
      platformSessionId,
      fileId,
      source: media.source,
      native: true,
      cleanup: async () => {},
    }
    // `timestamp` is the Telegram mtime in seconds; a prepared stage used to
    // publish milliseconds here, which reached clients as a year-56000 date.
    const staged: StagedMedia = {
      media, upload, timestamp: Math.floor(Date.now() / 1000), updatedAt: Date.now(),
    }
    this.stage(staged)
    return staged
  }

  async prepare(
    platformSessionId: string,
    fileId: string,
    hashes: IMMediaUploadHashes,
    preparation: IMMediaUploadPreparation,
  ): Promise<'ready' | 'stream'> {
    const key = this._stageKey(platformSessionId, fileId)
    const previous = this._prepared.get(key)
    if (previous) await previous.sink.abort(new Error('upload preparation replaced'))
    this._prepared.delete(key)
    this._staged.delete(key)
    await rm(this._directory(platformSessionId, fileId), { recursive: true, force: true })
    if (!preparation.sink) {
      this.stagePrepared(platformSessionId, fileId, preparation.media)
      return 'ready'
    }
    if (preparation.media.source.size !== undefined && preparation.media.source.size !== hashes.size) {
      await preparation.sink.abort(new Error('prepared upload source size mismatch'))
      throw new Error('prepared upload source size mismatch')
    }
    const prepared: PreparedUpload = {
      platformSessionId,
      fileId,
      media: preparation.media,
      sink: preparation.sink,
      hashes,
      parts: new Map(),
      bufferedBytes: 0,
      nextPart: 0,
      receivedBytes: 0,
      md5: createHash('md5'),
      sha1: createHash('sha1'),
      file10MMd5: createHash('md5'),
      file10MBytes: 0,
      updatedAt: Date.now(),
      tail: Promise.resolve(),
    }
    this._prepared.set(key, prepared)
    return 'stream'
  }

  getStaged(platformSessionId: string, fileId: string): StagedMedia | undefined {
    return this._staged.get(this._stageKey(platformSessionId, fileId))
  }

  async complete(upload: UploadedFile): Promise<void> {
    const key = this._stageKey(upload.platformSessionId, upload.fileId)
    if (this._staged.get(key)?.upload === upload) this._staged.delete(key)
    await upload.cleanup()
  }

  /**
   * Release uploads nobody finished.
   *
   * Only a send reaches `complete()`, and `remove()` has no caller on the
   * abandonment paths, so a client that stages media and never sends it leaves
   * its `StagedMedia` entry behind, a prepared upload whose client disconnected
   * keeps a sink plus up to `MAX_PREPARED_OUT_OF_ORDER_BYTES` of parts, and a
   * legacy part upload that was abandoned leaves the directory `savePart()`
   * wrote. Production had accumulated 920 MiB of those directories over two
   * months before this sweep existed.
   *
   * A directory is kept while a surviving entry still owns it, and the ones
   * without any owner are judged by their own mtime: a legacy upload in flight
   * has no entry at all, but every accepted part refreshes that mtime.
   *
   * `keep` lets an owner veto a release for an upload it still needs, such as
   * the media of an article draft the client has not sent yet.
   */
  async sweep(
    maxIdleMs: number,
    now = Date.now(),
    options: { keep?: UploadKeepPredicate } = {},
  ): Promise<UploadSweepResult> {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs < 0) {
      throw new RangeError('maxIdleMs must be a non-negative finite number')
    }
    const cutoff = now - maxIdleMs
    const keep = options.keep
    let staged = 0
    let prepared = 0
    let directories = 0

    for (const [key, entry] of [...this._staged]) {
      if (entry.updatedAt >= cutoff) continue
      if (keep?.(entry.upload.platformSessionId, entry.upload.fileId)) continue
      this._staged.delete(key)
      staged++
    }
    for (const [key, entry] of [...this._prepared]) {
      if (entry.updatedAt >= cutoff) continue
      if (keep?.(entry.platformSessionId, entry.fileId)) continue
      this._prepared.delete(key)
      try {
        await entry.sink.abort(new Error('upload abandoned'))
      } catch {
        // An already-broken sink must not keep the entry alive.
      }
      prepared++
    }

    const liveDirectories = new Set(
      [...this._staged.keys(), ...this._prepared.keys()].map((key) => {
        const separator = key.indexOf('\u0000')
        return this._directory(key.slice(0, separator), key.slice(separator + 1))
      }),
    )
    for (const sessionDirectory of await readdir(this._root).catch(() => [] as string[])) {
      const sessionPath = join(this._root, sessionDirectory)
      for (const fileDirectory of await readdir(sessionPath).catch(() => [] as string[])) {
        const directory = join(sessionPath, fileDirectory)
        if (liveDirectories.has(directory)) continue
        const info = await stat(directory).catch(() => undefined)
        if (!info || info.mtimeMs >= cutoff) continue
        await rm(directory, { recursive: true, force: true })
        directories++
      }
    }
    return { staged, prepared, directories }
  }

  private async _savePreparedPart(prepared: PreparedUpload, part: number, bytes: Uint8Array): Promise<void> {
    prepared.updatedAt = Date.now()
    const run = prepared.tail.then(async () => {
      if (prepared.failed) throw prepared.failed
      if (part < prepared.nextPart) return
      const value = Buffer.from(bytes)
      const duplicate = prepared.parts.get(part)
      if (duplicate) {
        if (!duplicate.equals(value)) throw new Error(`uploaded file part changed during retry: ${part}`)
        return
      }
      if (
        part !== prepared.nextPart
        && (prepared.parts.size >= MAX_PREPARED_OUT_OF_ORDER_PARTS
          || prepared.bufferedBytes + value.length > MAX_PREPARED_OUT_OF_ORDER_BYTES)
      ) {
        throw new Error('prepared upload out-of-order window exceeded')
      }
      prepared.parts.set(part, value)
      prepared.bufferedBytes += value.length
      await this._drainPrepared(prepared)
    })
    prepared.tail = run.catch(async (error) => {
      if (!prepared.failed) {
        prepared.failed = error
        const key = this._stageKey(prepared.platformSessionId, prepared.fileId)
        if (this._prepared.get(key) === prepared) this._prepared.delete(key)
        await prepared.sink.abort(error)
      }
      throw error
    })
    return prepared.tail
  }

  private async _drainPrepared(prepared: PreparedUpload): Promise<void> {
    while (true) {
      const chunk = prepared.parts.get(prepared.nextPart)
      if (!chunk) return
      if (prepared.receivedBytes + chunk.length > prepared.hashes.size) {
        throw new Error(`upload exceeded declared size ${prepared.hashes.size}`)
      }
      prepared.parts.delete(prepared.nextPart++)
      prepared.bufferedBytes -= chunk.length
      prepared.receivedBytes += chunk.length
      prepared.md5.update(chunk)
      prepared.sha1.update(chunk)
      if (prepared.file10MBytes < FILE_10M_BYTES) {
        const length = Math.min(FILE_10M_BYTES - prepared.file10MBytes, chunk.length)
        prepared.file10MMd5.update(chunk.subarray(0, length))
        prepared.file10MBytes += length
      }
      await prepared.sink.write(chunk)
      if (prepared.receivedBytes !== prepared.hashes.size) continue
      this._verifyPreparedHashes(prepared)
      await prepared.sink.complete()
      const key = this._stageKey(prepared.platformSessionId, prepared.fileId)
      if (this._prepared.get(key) === prepared) this._prepared.delete(key)
      this.stagePrepared(prepared.platformSessionId, prepared.fileId, prepared.media)
      return
    }
  }

  private _verifyPreparedHashes(prepared: PreparedUpload): void {
    const actual = {
      md5: prepared.md5.digest('hex'),
      sha1: prepared.sha1.digest('hex'),
      file10MMd5: prepared.file10MMd5.digest('hex'),
    }
    for (const name of ['md5', 'sha1', 'file10MMd5'] as const) {
      if (actual[name] !== prepared.hashes[name].toLowerCase()) {
        throw new Error(`prepared upload ${name} mismatch`)
      }
    }
  }

  private _directory(platformSessionId: string, fileId: string): string {
    return join(this._root, digest(platformSessionId), digest(fileId))
  }

  private _stageKey(platformSessionId: string, fileId: string): string {
    return `${platformSessionId}\u0000${fileId}`
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function partName(part: number): string {
  return String(part).padStart(10, '0')
}
