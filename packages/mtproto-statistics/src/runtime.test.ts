import { describe, expect, it, vi } from 'vitest'
import { getHeapStatistics } from 'node:v8'
import { RuntimeMonitor } from './runtime.js'

describe('RuntimeMonitor', () => {
  it('samples finite CrossGram process, event-loop, memory, and GC fields', () => {
    const monitor = new RuntimeMonitor()
    try {
      const snapshot = monitor.sample()
      expect(snapshot.rssBytes).toBeGreaterThan(0)
      expect(snapshot.heapTotalBytes).toBeGreaterThan(0)
      expect(snapshot.heapLimitBytes).toBeGreaterThan(snapshot.heapTotalBytes)
      expect(snapshot.heapAvailableBytes).toBeGreaterThan(0)
      expect(snapshot.nativeContexts).toBeGreaterThan(0)
      expect(snapshot.peakMallocedBytes).toBeGreaterThanOrEqual(snapshot.mallocedBytes)
      for (const value of Object.values(snapshot)) expect(Number.isFinite(value)).toBe(true)
    } finally {
      monitor.dispose()
    }
  })

  it('caches expensive heap traversal while continuing to sample CPU and event-loop metrics', () => {
    let now = 1_000
    const readHeapStatistics = vi.fn(getHeapStatistics)
    const monitor = new RuntimeMonitor({
      heapStatisticsSampleIntervalMs: 60_000,
      getHeapStatistics: readHeapStatistics,
      now: () => now,
    })
    try {
      const first = monitor.sample()
      now += 59_000
      const second = monitor.sample()
      expect(readHeapStatistics).toHaveBeenCalledOnce()
      expect(second.cpuPercent).toBeGreaterThanOrEqual(0)
      expect(second.eventLoopUtilization).toBeGreaterThanOrEqual(0)
      expect(second.heapLimitBytes).toBe(first.heapLimitBytes)
      expect(second.mallocedBytes).toBe(first.mallocedBytes)

      now += 1_001
      monitor.sample()
      expect(readHeapStatistics).toHaveBeenCalledTimes(2)
    } finally {
      monitor.dispose()
    }
  })

  it('rejects invalid heap statistics sampling intervals', () => {
    expect(() => new RuntimeMonitor({ heapStatisticsSampleIntervalMs: 0 })).toThrow(
      'Heap statistics sample interval must be a positive finite number',
    )
  })
})
