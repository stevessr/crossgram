import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import type { MtprotoClientInfo } from '@mtproto-relay/mtproto'

export interface RouteRecord {
  version: 1
  phone: string
  apiId: number
  apiHash: string
  clientInfo?: MtprotoClientInfo
  dcId?: number
  seedSession?: string
  pendingImport?: { id: string, bytes: string }
  importedFrom?: string
  importTicketHash?: string
}

export interface ExportTicket {
  parent: string
  expiresAt: number
  userId: string
  dcId: number
  record: RouteRecord
}

/** All metadata, SQLite sessions and sidecars remain inside a private directory. */
export class RouteStore {
  readonly directory: string
  constructor(directory: string) { this.directory = resolve(directory) }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.directory)
    if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error('Gateway storage directory must have mode 0700')
  }
  private path(key: string, extension: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid gateway storage key')
    return join(this.directory, `${key}.${extension}`)
  }
  async load(key: string): Promise<RouteRecord | undefined> {
    let file
    try { file = await open(this.path(key, 'json'), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16384) throw new Error('Unsafe gateway route metadata')
      const record = JSON.parse(await file.readFile('utf8')) as RouteRecord
      if (record.version !== 1 || !/^[1-9]\d{4,14}$/.test(record.phone) || !Number.isSafeInteger(record.apiId) || record.apiId < 1 ||
        !/^[a-f\d]{32}$/i.test(record.apiHash)) throw new Error('Invalid gateway route metadata')
      return record
    } finally { await file.close() }
  }
  async save(key: string, record: RouteRecord) { return this.writeJson(key, 'json', record) }
  private async writeJson(key: string, extension: string, record: unknown) {
    const target = this.path(key, extension)
    const temporary = `${target}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() }
    finally { await file.close() }
    try { await rename(temporary, target) } finally { await rm(temporary, { force: true }) }
  }
  async exportTicket(ticket: ExportTicket): Promise<Uint8Array> {
    const files = (await readdir(this.directory)).filter(name => name.endsWith('.ticket'))
    // Bound disk growth even when a client repeatedly exports without importing.
    for (const name of files) {
      const key = name.slice(0, -7)
      try {
        const value = await this.readTicket(key)
        if (value.expiresAt < Date.now()) await rm(this.path(key, 'ticket'), { force: true })
      } catch { /* Corrupt private tickets cannot authorize a client. */ }
    }
    if ((await readdir(this.directory)).filter(name => name.endsWith('.ticket')).length >= 100) throw new Error('Gateway export ticket limit')
    const token = randomBytes(32)
    const key = createHash('sha256').update(token).digest('hex')
    await this.writeJson(key, 'ticket', ticket)
    return token
  }
  private async readTicket(key: string): Promise<ExportTicket> {
    const file = await open(this.path(key, 'ticket'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 32768) throw new Error('Unsafe gateway ticket')
      return JSON.parse(await file.readFile('utf8')) as ExportTicket
    } finally { await file.close() }
  }
  async importTicket(token: Uint8Array, userId: string, dcId?: number): Promise<ExportTicket> {
    if (token.length !== 32) throw new Error('Invalid gateway authorization token')
    const key = createHash('sha256').update(token).digest('hex')
    const value = await this.readTicket(key)
    if (value.expiresAt < Date.now() || value.userId !== userId || (dcId !== undefined && value.dcId !== dcId) || !await this.load(value.parent)) {
      throw new Error('Invalid or expired gateway authorization token')
    }
    // Atomic claim: only one concurrent importer can consume this token.
    const claimed = this.path(key, `${randomUUID()}.claimed`)
    await rename(this.path(key, 'ticket'), claimed)
    await rm(claimed, { force: true })
    return value
  }
  async sessionPath(key: string): Promise<string> {
    const path = this.path(key, 'sqlite')
    const file = await open(path, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { const stat = await file.stat(); if (!stat.isFile() || stat.mode & 0o077) throw new Error('Unsafe gateway session file') }
    finally { await file.close() }
    return path
  }
  async hasSession(key: string): Promise<boolean> {
    try { return (await lstat(this.path(key, 'sqlite'))).size > 0 }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  async family(key: string): Promise<string[]> {
    const records = await Promise.all((await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
      const id = name.slice(0, -5)
      return [id, await this.load(id)] as const
    }))
    const result = new Set([key])
    let changed = true
    while (changed) {
      changed = false
      for (const [id, record] of records) if (record?.importedFrom && result.has(record.importedFrom) && !result.has(id)) { result.add(id); changed = true }
    }
    return [...result]
  }
  async remove(key: string) {
    await Promise.all(['json', 'sqlite', 'sqlite-wal', 'sqlite-shm'].map(ext => rm(this.path(key, ext), { force: true })))
  }
}
