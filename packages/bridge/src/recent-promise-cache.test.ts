import { describe, expect, it } from 'vitest'
import { RecentPromiseCache } from './recent-promise-cache.js'

describe('RecentPromiseCache', () => {
  it('keeps recent successful results and evicts the oldest settled entry', async () => {
    const cache = new RecentPromiseCache<number>(2)
    cache.set('first', Promise.resolve(1))
    cache.set('second', Promise.resolve(2))
    cache.set('third', Promise.resolve(3))
    await Promise.resolve()

    expect(cache.size).toBe(2)
    expect(cache.get('first')).toBeUndefined()
    await expect(cache.get('second')).resolves.toBe(2)
    await expect(cache.get('third')).resolves.toBe(3)
  })

  it('drops failed results so a retry can execute again', async () => {
    const cache = new RecentPromiseCache<number>(2)
    const failure = Promise.reject(new Error('temporary failure'))
    cache.set('request', failure)
    await expect(failure).rejects.toThrow('temporary failure')
    await Promise.resolve()

    expect(cache.get('request')).toBeUndefined()
  })

  it('never evicts an in-flight operation even when the settled limit is exceeded', async () => {
    const cache = new RecentPromiseCache<number>(1)
    let resolve!: (value: number) => void
    const pending = new Promise<number>((done) => { resolve = done })
    cache.set('pending', pending)
    cache.set('settled', Promise.resolve(2))
    await Promise.resolve()

    expect(cache.get('pending')).toBe(pending)
    expect(cache.get('settled')).toBeUndefined()
    resolve(1)
    await expect(pending).resolves.toBe(1)
    expect(cache.size).toBe(1)
  })

  it('trims thousands of overlapping pending operations without evicting an in-flight key', async () => {
    const cache = new RecentPromiseCache<number>(4)
    const resolve: Array<(value: number) => void> = []
    const pending = Array.from({ length: 2_000 }, (_, index) => new Promise<number>((done) => {
      resolve[index] = done
    }))
    for (let index = 0; index < pending.length; index++) {
      cache.set(`pending-${index}`, pending[index]!)
    }
    expect(cache.size).toBe(2_000)
    // Settled entries are the only ones eligible for immediate eviction.
    cache.set('short-lived', Promise.resolve(-1))
    await Promise.resolve()
    expect(cache.get('short-lived')).toBeUndefined()
    expect(cache.get('pending-0')).toBe(pending[0])

    // A full completion burst leaves only the newest four settled promises.
    for (let index = 0; index < pending.length; index++) resolve[index]!(index)
    await Promise.all(pending)
    expect(cache.size).toBe(4)
    expect(cache.get('pending-0')).toBeUndefined()
    await expect(cache.get('pending-1999')).resolves.toBe(1_999)
  })

  it('does not let completion of a replaced promise delete or evict its replacement', async () => {
    const cache = new RecentPromiseCache<number>(1)
    let failOld!: (reason: Error) => void
    const old = new Promise<number>((_resolve, reject) => { failOld = reject })
    cache.set('same', old)
    const current = Promise.resolve(42)
    cache.set('same', current)
    await current
    failOld(new Error('obsolete'))
    await expect(old).rejects.toThrow('obsolete')
    expect(cache.get('same')).toBe(current)
    await expect(cache.get('same')).resolves.toBe(42)
  })

  it('refreshes recency when a duplicate request reads an existing result', async () => {
    const cache = new RecentPromiseCache<number>(2)
    cache.set('first', Promise.resolve(1))
    cache.set('second', Promise.resolve(2))
    await Promise.resolve()
    await cache.get('first')
    cache.set('third', Promise.resolve(3))
    await Promise.resolve()

    expect(cache.get('second')).toBeUndefined()
    await expect(cache.get('first')).resolves.toBe(1)
    await expect(cache.get('third')).resolves.toBe(3)
  })
})
