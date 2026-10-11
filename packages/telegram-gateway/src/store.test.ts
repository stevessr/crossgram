import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouteStore, type RouteRecord } from './store.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-store-'))
  directories.push(directory)
  const store = new RouteStore(directory)
  await store.init()
  return store
}
const parent = 'a'.repeat(64)
const record: RouteRecord = { version: 1, phone: '15551234567', apiId: 123, apiHash: 'a'.repeat(32), dcId: 2 }

it('persists private route metadata and detects orphan sessions', async () => {
  const store = await setup()
  await store.save(parent, record)
  expect(await store.load(parent)).toEqual(record)
  expect((await stat(join(store.directory, `${parent}.json`))).mode & 0o077).toBe(0)
  expect(await store.hasSession(parent)).toBe(false)
  const path = await store.sessionPath(parent)
  await writeFile(path, 'orphan session')
  expect(await store.hasSession(parent)).toBe(true)
  await store.remove(parent)
  expect(await store.hasSession(parent)).toBe(false)
})

it('rejects expired, wrong-DC and wrong-user tickets without consuming valid tickets', async () => {
  const store = await setup()
  await store.save(parent, record)
  const ticket = { parent, record, userId: '42', dcId: 2, expiresAt: Date.now() + 60000 }
  const expired = await store.exportTicket({ ...ticket, expiresAt: Date.now() - 1 })
  await expect(store.importTicket(expired, '42', 2)).rejects.toThrow()
  const token = await store.exportTicket(ticket)
  await expect(store.importTicket(token, '43', 2)).rejects.toThrow()
  await expect(store.importTicket(token, '42', 3)).rejects.toThrow()
  expect(await store.importTicket(token, '42', 2)).toEqual(ticket)
  await expect(store.importTicket(token, '42', 2)).rejects.toThrow()
})

it('allows exactly one concurrent ticket claimant and revokes tickets with the parent', async () => {
  const store = await setup()
  await store.save(parent, record)
  const ticket = { parent, record, userId: '42', dcId: 2, expiresAt: Date.now() + 60000 }
  const token = await store.exportTicket(ticket)
  const results = await Promise.allSettled([store.importTicket(token, '42', 2), store.importTicket(token, '42', 2)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const revoked = await store.exportTicket(ticket)
  await store.remove(parent)
  await expect(store.importTicket(revoked, '42', 2)).rejects.toThrow()
})

it('finds recursive imported authorization descendants without touching unrelated sessions', async () => {
  const store = await setup()
  await store.save(parent, record)
  await store.save('b'.repeat(64), { ...record, importedFrom: parent })
  await store.save('c'.repeat(64), { ...record, importedFrom: 'b'.repeat(64) })
  await store.save('d'.repeat(64), record)
  expect((await store.family(parent)).sort()).toEqual([parent, 'b'.repeat(64), 'c'.repeat(64)])
})
