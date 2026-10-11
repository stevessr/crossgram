import type { IMMessagePoll } from '@mtproto-relay/bridge'
import type { MatrixEvent } from './types.js'

export interface MatrixPollTally {
  /** Confirmed first non-redacted closing event. */
  endedAtMs: number
  /** Number of members whose latest eligible vote contains at least one valid choice. */
  totalVoters: number
  counts: Record<string, number>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function parentId(content: unknown): string | undefined {
  const relation = object(object(content)?.['m.relates_to'])
  return relation?.rel_type === 'm.reference' && typeof relation.event_id === 'string'
    ? relation.event_id : undefined
}

function isPollEnd(type: string): boolean {
  return type === 'm.poll.end' || type === 'org.matrix.msc3381.poll.end'
}

function isPollResponse(type: string): boolean {
  return type === 'm.poll.response' || type === 'org.matrix.msc3381.poll.response'
}

function selections(content: unknown): unknown {
  const data = object(content)
  if (!data) return
  if (Array.isArray(data['m.selections'])) return data['m.selections']
  const stable = object(data['m.poll.response'])
  if (stable) return stable.answers
  return object(data['org.matrix.msc3381.poll.response'])?.answers
}

/**
 * Only the complete reference relation set is suitable for authoritative counts.
 * The caller must exhaust pagination before applying this result. Deliberately
 * ignores the untrusted m.poll.results hint in the closing event.
 */
export function countClosedMatrixPoll(
  pollEventId: string,
  poll: IMMessagePoll,
  relations: readonly MatrixEvent[],
): MatrixPollTally | undefined {
  const active = relations.filter((event) =>
    !event.unsigned?.redacted_because && parentId(event.content) === pollEventId)
  const ends = active.filter((event) => isPollEnd(event.type)
    && Number.isFinite(event.origin_server_ts))
  if (!ends.length) return
  const endedAtMs = Math.min(...ends.map((event) => event.origin_server_ts!))
  const latest = new Map<string, MatrixEvent>()
  for (const event of active) {
    if (!isPollResponse(event.type) || !event.sender || !Number.isFinite(event.origin_server_ts)
      || event.origin_server_ts! > endedAtMs) continue
    const prior = latest.get(event.sender)
    if (!prior || event.origin_server_ts! > prior.origin_server_ts!
      || (event.origin_server_ts === prior.origin_server_ts
        && (event.event_id ?? '') > (prior.event_id ?? ''))) {
      latest.set(event.sender, event)
    }
  }

  const counts: Record<string, number> = Object.create(null)
  const knownIds = new Set(poll.answers.map((answer) => answer.id))
  for (const id of knownIds) counts[id] = 0
  let totalVoters = 0
  for (const vote of latest.values()) {
    const raw = selections(vote.content)
    // Invalid newer votes explicitly override previous valid votes; do not
    // accidentally resurrect a prior selection when the latest vote is spoiled.
    if (!Array.isArray(raw)) continue
    const limited = raw.slice(0, poll.maxSelections)
    if (limited.some((id) => typeof id !== 'string' || !knownIds.has(id))) continue
    const unique = new Set<string>(limited)
    if (!unique.size) continue
    totalVoters++
    for (const id of unique) counts[id]++
  }
  return { endedAtMs, totalVoters, counts }
}
