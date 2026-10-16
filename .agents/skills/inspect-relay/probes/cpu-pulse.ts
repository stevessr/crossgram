/**
 * Attribute an intermittent CPU pulse from inside the worker.
 *
 * Deploy this probe when the relay burns tens of percent of a core in bursts
 * (clients see "connecting" while the event loop is busy) and external
 * sampling only proves that the main thread is hot without naming the code.
 * The probe takes a real CPU profile through the inspector session Bun exposes
 * as `node:inspector` — no `--inspect` flag, restart, or rebuild needed — and
 * publishes the hottest frames together with the thread-level CPU split, the
 * event loop lag, the RSS, and the heap object counts. Those four together
 * separate an allocation loop from a blocking read from a hot microtask queue.
 *
 * It samples every ten seconds and only profiles once the process is already
 * burning, so it stays quiet on a healthy relay. `heapStats()` walks the heap,
 * so it is sampled once a minute instead of on every tick. Published results:
 *
 * - `heartbeat`: ratio, threads, rssMiB, lagPeakMs (every five minutes).
 * - `pulse`: the same plus `samples` and `frames` (self-time percentages) and
 *   the warning/error lines that were logged while the pulse was running.
 *
 * Raw profiles are written to `<debug results>/cpu-pulse/pulse-<epoch>.cpuprofile`
 * so callers can inspect callers of the hot frames; the {@link aggregate}
 * output is what the control plane prints.
 */
import { Session } from 'node:inspector'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'

const SAMPLE_MS = 10_000
const PULSE_RATIO = 0.35
const PULSE_STREAK = 2
const PROFILE_MS = 15_000
const HEARTBEAT_MS = 300_000
const HEAP_INTERVAL_MS = 60_000

interface HeapStats {
  objectTypeCounts?: Record<string, number>
}

interface ProfileNode {
  hitCount?: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}

function threadCpu(): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const tid of readdirSync('/proc/self/task')) {
    try {
      const stat = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8')
      const name = readFileSync(`/proc/self/task/${tid}/comm`, 'utf8').trim()
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      usage[name] = (usage[name] ?? 0) + Number(fields[11]) + Number(fields[12])
    } catch {
      // A thread can vanish between readdir and read; its CPU is not important.
    }
  }
  return usage
}

function diff(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const delta: Record<string, number> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = (after[key] ?? 0) - (before[key] ?? 0)
    if (value) delta[key] = value
  }
  return delta
}

export function aggregate(profile: { nodes: ProfileNode[] }): { total: number; frames: Array<[string, number]> } {
  const self = new Map<string, number>()
  let total = 0
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0
    if (!hits) continue
    total += hits
    const frame = node.callFrame
    const file = frame.url ? frame.url.split('/').slice(-2).join('/') : ''
    const name = `${frame.functionName || '(anonymous)'}  ${file}:${frame.lineNumber + 1}`
    self.set(name, (self.get(name) ?? 0) + hits)
  }
  return { total, frames: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25) }
}

async function capture(ms: number) {
  const session = new Session()
  session.connect()
  const post = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    session.post(
      method as Parameters<Session['post']>[0],
      params as Parameters<Session['post']>[1],
      (error, result) => (error ? reject(new Error(String(error))) : resolve(result)),
    )
  })
  try {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 1000 })
    await post('Profiler.start')
    await new Promise((resolve) => setTimeout(resolve, ms))
    const { profile } = await post('Profiler.stop')
    return profile
  } finally {
    session.disconnect()
  }
}

export async function apply(ctx: Context) {
  const jsc = await import('bun:jsc').catch(() => undefined)
  const heapCounts = (): Record<string, number> => {
    const counts = (jsc as { heapStats?: () => HeapStats } | undefined)?.heapStats?.()?.objectTypeCounts
    if (!counts) return {}
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12))
  }
  const resourceCounts = (): Record<string, number> => {
    const info = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo
    if (!info) return {}
    const counts: Record<string, number> = {}
    for (const name of info()) counts[name] = (counts[name] ?? 0) + 1
    return counts
  }
  const profileDir = join(ctx.debugScripts.resultsRoot, 'cpu-pulse')

  let previousCpu = process.cpuUsage()
  let previousAt = Date.now()
  let previousThreads = threadCpu()
  let previousHeap: Record<string, number> = {}
  let lastHeapAt = 0
  let streak = 0
  let profiling = false
  let pulses = 0
  let lastHeartbeat = Date.now()
  let lagPeak = 0

  ctx.effect(() => {
    // The delay between a timer's deadline and its callback is the queueing
    // delay a client experiences as "connecting".
    let expected = Date.now() + 100
    let timer: NodeJS.Timeout
    const step = () => {
      const lateness = Date.now() - expected
      if (lateness > lagPeak) lagPeak = lateness
      expected = Math.max(expected + 100, Date.now())
      timer = setTimeout(step, 100)
    }
    timer = setTimeout(step, 100)
    return () => clearTimeout(timer)
  })

  const sample = async () => {
    const now = Date.now()
    const elapsed = now - previousAt
    const cpu = process.cpuUsage(previousCpu)
    const threads = threadCpu()
    const wantHeap = now - lastHeapAt >= HEAP_INTERVAL_MS
    const heap = wantHeap ? heapCounts() : previousHeap
    const ratio = (cpu.user + cpu.system) / 1000 / elapsed
    const memory = process.memoryUsage()
    const payload = {
      at: new Date(now).toISOString(),
      ratio: +ratio.toFixed(3),
      threads: diff(previousThreads, threads),
      rssMiB: +(memory.rss / 1048576).toFixed(1),
      lagPeakMs: lagPeak,
      heapDelta: wantHeap ? diff(previousHeap, heap) : undefined,
      resources: resourceCounts(),
    }
    previousCpu = process.cpuUsage()
    previousAt = now
    previousThreads = threads
    if (wantHeap) {
      previousHeap = heap
      lastHeapAt = now
    }
    lagPeak = 0

    if (ratio < PULSE_RATIO) {
      streak = 0
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now
        await ctx.debugScript.publish({ kind: 'heartbeat', pulses, ...payload })
      }
      return
    }

    streak++
    if (streak < PULSE_STREAK || profiling) return
    profiling = true
    try {
      const profile = await capture(PROFILE_MS)
      pulses++
      const { total, frames } = aggregate(profile)
      const heapDelta = diff(previousHeap, heapCounts())
      previousHeap = heapCounts()
      lastHeapAt = Date.now()
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, `pulse-${now}.cpuprofile`), JSON.stringify(profile))
      const recentWarnings = ctx.logger.buffer
        .slice(-60)
        .filter((item) => item.type === 'warn' || item.type === 'error')
        .slice(-8)
        .map((item) => ({
          ts: item.ts,
          name: item.name,
          level: item.level,
          args: String(item.args).slice(0, 200),
        }))
      await ctx.debugScript.publish({
        kind: 'pulse',
        samples: total,
        frames: frames.map(([name, hits]) => `${((hits / total) * 100).toFixed(1)}%  ${name}`),
        recentWarnings,
        ...payload,
        heapDelta,
      })
    } catch (error) {
      await ctx.debugScript.publish({ kind: 'pulse-failed', error: String(error) })
    } finally {
      profiling = false
      streak = 0
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => void sample().catch(() => {}), SAMPLE_MS)
    return () => clearInterval(timer)
  })
}
