import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import { defineModels } from './models.js'
import {
  decodeDialogFilterTitle, DialogFolderStore, encodeDialogFilterTitle,
  type StoredDialogFilter,
} from './dialog-folders.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return { ctx, store: new DialogFolderStore(ctx.database) }
}

function filter(title: string, peerId: string): StoredDialogFilter {
  return {
    kind: 'dialogFilter', groups: true, excludeArchived: true,
    title: encodeDialogFilterTitle({
      _: 'textWithEntities', text: title,
      entities: [{
        _: 'messageEntityCustomEmoji', offset: 0, length: 1, documentId: Long.fromNumber(42),
      }],
    }),
    pinnedPeerIds: [peerId], includePeerIds: [peerId], excludePeerIds: [],
  }
}

describe('DialogFolderStore', () => {
  it('persists filters, exact rich titles, deletion, and default-tab ordering', async () => {
    const { ctx, store } = await createStore()
    await expect(store.listFilters('session')).resolves.toEqual([{ filterId: 0 }])

    await store.putFilter('session', 2, filter('A', 'group-a'))
    await store.putFilter('session', 3, filter('B', 'group-b'))
    await expect(store.reorderFilters('session', [3, 0, 2, 999, 3])).resolves.toEqual([3, 0, 2])

    const resumed = new DialogFolderStore(ctx.database)
    const stored = await resumed.listFilters('session')
    expect(stored.map((entry) => entry.filterId)).toEqual([3, 0, 2])
    expect(decodeDialogFilterTitle(stored[0].filter!.title)).toEqual({
      _: 'textWithEntities', text: 'B',
      entities: [{
        _: 'messageEntityCustomEmoji', offset: 0, length: 1, documentId: Long.fromNumber(42),
      }],
    })

    await resumed.removeFilter('session', 3)
    expect((await store.listFilters('session')).map((entry) => entry.filterId)).toEqual([0, 2])
  })


  it('mirrors Space folders with stable IDs without overwriting local filters', async () => {
    const { ctx, store } = await createStore()
    await store.putFilter('matrix-session', 2, filter('Personal', 'personal'))
    await store.syncPlatformFolders('matrix-session', [
      { id: '!space:test', title: 'Work', conversationIds: ['!one:test', '!two:test', '!one:test'] },
    ])
    const first = await store.listFilters('matrix-session')
    expect(first.map((entry) => entry.filterId)).toEqual([0, 2, 3])
    expect(first[2]?.filter).toMatchObject({
      sourceId: '!space:test', includePeerIds: ['!one:test', '!two:test'],
    })
    await new DialogFolderStore(ctx.database).syncPlatformFolders('matrix-session', [
      { id: '!space:test', title: 'New title', conversationIds: ['!two:test'] },
      { id: '!other:test', title: 'Other', conversationIds: ['!two:test'] },
    ])
    const updated = await store.listFilters('matrix-session')
    expect(updated.find((entry) => entry.filter?.sourceId === '!space:test')?.filterId).toBe(3)
    expect(updated.find((entry) => entry.filter?.sourceId === '!space:test')?.filter?.includePeerIds)
      .toEqual(['!two:test'])
    expect(decodeDialogFilterTitle(updated.find((entry) => entry.filter?.sourceId === '!space:test')!.filter!.title))
      .toMatchObject({ text: 'New title' })
    expect(updated.find((entry) => entry.filter?.sourceId === '!other:test')?.filterId).toBe(4)
    await store.syncPlatformFolders('matrix-session', [])
    expect((await store.listFilters('matrix-session')).map((entry) => entry.filterId)).toEqual([0, 2])
    expect((await store.listFilters('another-session')).map((entry) => entry.filterId)).toEqual([0])
  })

  it('keeps Discord source order, stable filter IDs, and reuses removed folder IDs', async () => {
    const { store } = await createStore()
    await store.putFilter('discord-folders', 2, filter('Personal', 'mine'))
    await store.syncPlatformFolders('discord-folders', [
      { id: 'discord:guild-folder:z', title: 'Z', conversationIds: ['discord:guild:9'] },
      { id: 'discord:guild-folder:a', title: 'A', conversationIds: ['discord:guild:8'] },
    ])
    const initial = await store.listFilters('discord-folders')
    expect(initial.map((entry) => entry.filter?.sourceId).filter(Boolean))
      .toEqual(['discord:guild-folder:z', 'discord:guild-folder:a'])
    const originalIds = new Map(initial.filter((entry) => entry.filter?.sourceId)
      .map((entry) => [entry.filter!.sourceId!, entry.filterId]))
    await store.syncPlatformFolders('discord-folders', [
      { id: 'discord:guild-folder:a', title: 'Renamed', conversationIds: ['discord:guild:8'] },
      { id: 'discord:guild-folder:z', title: 'Z', conversationIds: ['discord:guild:7'] },
    ])
    const reordered = await store.listFilters('discord-folders')
    expect(reordered.map((entry) => entry.filter?.sourceId).filter(Boolean))
      .toEqual(['discord:guild-folder:a', 'discord:guild-folder:z'])
    for (const entry of reordered) if (entry.filter?.sourceId) {
      expect(entry.filterId).toBe(originalIds.get(entry.filter.sourceId))
    }
    expect(reordered.find((entry) => entry.filter?.sourceId === 'discord:guild-folder:a')?.filter)
      .toMatchObject({ includePeerIds: ['discord:guild:8'] })
    await store.syncPlatformFolders('discord-folders', [
      { id: 'discord:guild-folder:z', title: 'Z', conversationIds: [] },
      { id: 'discord:guild-folder:new', title: 'New', conversationIds: ['discord:guild:3'] },
    ])
    const final = await store.listFilters('discord-folders')
    expect(final.map((entry) => entry.filter?.sourceId).filter(Boolean))
      .toEqual(['discord:guild-folder:z', 'discord:guild-folder:new'])
    expect(final.find((entry) => entry.filter?.sourceId === 'discord:guild-folder:new')?.filterId)
      .toBe(originalIds.get('discord:guild-folder:a'))
    expect(final.find((entry) => entry.filter?.sourceId === 'discord:guild-folder:z')?.filter?.includePeerIds)
      .toEqual([])
    expect(final.find((entry) => entry.filterId === 2)?.filter?.sourceId).toBeUndefined()
  })

  it('serializes simultaneous native folder refreshes without allocating duplicate IDs', async () => {
    const { ctx, store } = await createStore()
    const folders = [
      { id: '!a:test', title: 'A', conversationIds: ['!one:test'] },
      { id: '!b:test', title: 'B', conversationIds: ['!two:test'] },
    ]
    await Promise.all([
      store.syncPlatformFolders('matrix-concurrent', folders),
      new DialogFolderStore(ctx.database).syncPlatformFolders('matrix-concurrent', folders),
    ])
    const result = await store.listFilters('matrix-concurrent')
    expect(result.map((item) => item.filterId)).toEqual([0, 2, 3])
    expect(result.map((item) => item.filter?.sourceId).filter(Boolean)).toEqual(['!a:test', '!b:test'])
  })

  it('updates existing Space folders even when custom filter IDs are exhausted', async () => {
    const { store } = await createStore()
    for (let id = 2; id < 255; id++) {
      await store.putFilter('matrix-full', id, filter('User', 'group'))
    }
    await store.syncPlatformFolders('matrix-full', [
      { id: '!z:test', title: 'Before', conversationIds: ['!room:test'] },
    ])
    await store.syncPlatformFolders('matrix-full', [
      { id: '!a:test', title: 'No free ID', conversationIds: ['!unused:test'] },
      { id: '!z:test', title: 'After', conversationIds: ['!room2:test'] },
    ])
    const result = await store.listFilters('matrix-full')
    expect(result).toHaveLength(255)
    expect(result.find((entry) => entry.filterId === 255)?.filter).toMatchObject({
      sourceId: '!z:test', includePeerIds: ['!room2:test'],
    })
    expect(result.some((entry) => entry.filter?.sourceId === '!a:test')).toBe(false)
  }, 15_000)

  it('archives and unarchives peers atomically and reports only real changes', async () => {
    const { ctx, store } = await createStore()
    await expect(store.setPeerFolders('session', [
      { peerId: 'group-a', folderId: 1 },
      { peerId: 'group-b', folderId: 1 },
      { peerId: 'group-a', folderId: 1 },
    ])).resolves.toEqual(new Set(['group-a', 'group-b']))
    await expect(store.archivedPeerIds('session')).resolves.toEqual(new Set(['group-a', 'group-b']))

    const resumed = new DialogFolderStore(ctx.database)
    await expect(resumed.setPeerFolders('session', [
      { peerId: 'group-a', folderId: 1 },
      { peerId: 'group-b', folderId: 0 },
    ])).resolves.toEqual(new Set(['group-b']))
    await expect(store.archivedPeerIds('session')).resolves.toEqual(new Set(['group-a']))
  })
})
