import { describe, expect, it } from 'vitest'
import type { IMMessagePoll } from '@mtproto-relay/bridge'
import { countClosedMatrixPoll } from './poll-results.js'
import type { MatrixEvent } from './types.js'

const poll: IMMessagePoll = {
  question: 'Choose',
  answers: [{ id: 'A', text: 'Option A' }, { id: 'B', text: 'Option B' }],
  maxSelections: 2,
  kind: 'disclosed',
}

function vote(
  sender: string,
  ts: number,
  selections: string[],
  id: string,
  unstable = false,
): MatrixEvent {
  return {
    event_id: id,
    sender,
    type: unstable ? 'org.matrix.msc3381.poll.response' : 'm.poll.response',
    origin_server_ts: ts,
    content: {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      ...(unstable
        ? { 'org.matrix.msc3381.poll.response': { answers: selections } }
        : { 'm.selections': selections }),
    },
  }
}

function end(ts: number, id: string): MatrixEvent {
  return {
    type: 'm.poll.end', event_id: id, origin_server_ts: ts, sender: '@alice:example.org',
    content: { 'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' } },
  }
}

describe('Matrix closed poll tallies', () => {
  it('does not expose results before a valid closing event', () => {
    expect(countClosedMatrixPoll('$poll', poll, [
      vote('@bob:example.org', 100, ['A'], '$1'),
    ])).toBeUndefined()
  })

  it('uses the most recent valid or spoiled vote per sender, ignoring later votes', () => {
    const result = countClosedMatrixPoll('$poll', poll, [
      vote('@bob:example.org', 100, ['A'], '$1'),
      vote('@bob:example.org', 200, ['B', 'B'], '$2'),
      vote('@carol:example.org', 300, ['A'], '$3'),
      vote('@carol:example.org', 400, ['unknown'], '$4'),
      vote('@dave:example.org', 450, ['A', 'B', 'A'], '$5'),
      vote('@eve:example.org', 480, [], '$6'),
      end(500, '$end'),
      vote('@bob:example.org', 501, ['A'], '$too-late'),
      end(600, '$duplicate-end'),
    ])
    expect(result).toMatchObject({
      endedAtMs: 500, totalVoters: 2, counts: { A: 1, B: 2 },
    })
  })

  it('understands the unstable response block and excludes redacted votes', () => {
    const removed = vote('@bob:example.org', 200, ['B'], '$removed')
    removed.unsigned = { redacted_because: { type: 'm.room.redaction', content: {} } }
    const tally = countClosedMatrixPoll('$poll', poll, [
      vote('@bob:example.org', 100, ['A'], '$1', true),
      removed,
      vote('@carol:example.org', 300, ['B'], '$2'),
      end(500, '$end'),
    ])
    expect(tally).toMatchObject({ totalVoters: 2, counts: { A: 1, B: 1 } })
  })

  it('ignores unrelated poll references and redacted closing events', () => {
    const revoked = end(200, '$revoked')
    revoked.unsigned = { redacted_because: { type: 'm.room.redaction', content: {} } }
    const unrelated = vote('@bob:example.org', 100, ['A'], '$elsewhere')
    unrelated.content = { 'm.relates_to': { rel_type: 'm.reference', event_id: '$other' },
      'm.selections': ['A'] }
    const result = countClosedMatrixPoll('$poll', poll, [revoked, unrelated, end(400, '$real')])
    expect(result).toMatchObject({ endedAtMs: 400, totalVoters: 0, counts: { A: 0, B: 0 } })
  })

  it('does not revive a previous vote after a malformed newer response', () => {
    const spoiled = vote('@bob:example.org', 150, ['B'], '$spoiled')
    spoiled.content = { 'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
      'm.poll.response': { answers: 42 } }
    expect(countClosedMatrixPoll('$poll', poll, [
      vote('@bob:example.org', 100, ['A'], '$previous'), spoiled, end(200, '$end'),
    ])).toMatchObject({ totalVoters: 0, counts: { A: 0, B: 0 } })
  })
})
