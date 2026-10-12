interface PromiseCacheEntry<T> {
  promise: Promise<T>
  settled: boolean
}

/**
 * Deduplicates recent successful operations without retaining their results
 * forever. Pending operations are never evicted, so exceeding the limit under
 * extreme concurrency cannot cause the same side effect to run twice.
 */
export class RecentPromiseCache<T> {
  private readonly entries = new Map<string, PromiseCacheEntry<T>>()
  // Only settled results are eligible for eviction. A separate insertion-
  // ordered index finds the oldest one in O(1), even while thousands of
  // operations remain pending in the primary map.
  private readonly settledEntries = new Map<string, PromiseCacheEntry<T>>()

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError('maximum must be a positive integer')
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return
    this.touch(key, entry)
    return entry.promise
  }

  set(key: string, promise: Promise<T>): void {
    const entry: PromiseCacheEntry<T> = { promise, settled: false }
    this.entries.delete(key)
    this.settledEntries.delete(key)
    this.entries.set(key, entry)
    void promise.then(() => {
      if (this.entries.get(key) !== entry) return
      entry.settled = true
      this.touch(key, entry)
      this.trim()
    }, () => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
        this.settledEntries.delete(key)
      }
    })
    this.trim()
  }

  private touch(key: string, entry: PromiseCacheEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (entry.settled) {
      this.settledEntries.delete(key)
      this.settledEntries.set(key, entry)
    }
  }

  private trim(): void {
    while (this.entries.size > this.maximum && this.settledEntries.size) {
      const key = this.settledEntries.keys().next().value!
      this.settledEntries.delete(key)
      this.entries.delete(key)
    }
  }
}
