import { describe, expect, it } from 'vitest'
import { buildSpaceFolders, buildSpaceHierarchy } from './space-hierarchy.js'
import type { MatrixEvent } from './types.js'

function state(...events: MatrixEvent[]): Map<string, MatrixEvent> {
  return new Map(events.map((event) => [`${event.type}\0${event.state_key}`, event]))
}

const room = (type?: string): MatrixEvent => ({ type: 'm.room.create', state_key: '', content: { type } })
const child = (id: string, via: unknown, order?: unknown): MatrixEvent => ({
  type: 'm.space.child', state_key: id, content: { via, order },
})

describe('Matrix Space hierarchy projection', () => {
  it('keeps only valid, joined children beneath actual spaces and sorts by order', () => {
    const states = new Map([
      ['!root:test', state(room('m.space'), child('!later:test', ['test'], 'z'), child('!first:test', ['test'], 'a'),
        child('!missing:test', ['test']), child('!deleted:test', []), child('!plain:test', ['test']))],
      ['!first:test', state(room())],
      ['!later:test', state(room())],
      ['!plain:test', state(room())],
      ['!ordinary:test', state(room(), child('!later:test', ['test']))],
    ])
    const joined = new Set(['!root:test', '!first:test', '!later:test', '!plain:test', '!ordinary:test'])
    const hierarchy = buildSpaceHierarchy(states, joined)
    expect(hierarchy.children.get('!root:test')).toEqual(['!first:test', '!later:test', '!plain:test'])
    expect(hierarchy.parents.get('!later:test')).toBe('!root:test')
    expect(hierarchy.parents.has('!missing:test')).toBe(false)
    expect(hierarchy.parents.has('!deleted:test')).toBe(false)
  })

  it('uses a deterministic primary parent and prevents cycles and self links', () => {
    const states = new Map([
      ['!a:test', state(room('m.space'), child('!b:test', ['test']), child('!child:test', ['test']),
        child('!a:test', ['test']))],
      ['!b:test', state(room('m.space'), child('!a:test', ['test']), child('!child:test', ['test']))],
      ['!child:test', state(room())],
    ])
    const hierarchy = buildSpaceHierarchy(states, new Set(states.keys()))
    expect(hierarchy.parents.get('!b:test')).toBe('!a:test')
    expect(hierarchy.parents.has('!a:test')).toBe(false)
    expect(hierarchy.parents.get('!child:test')).toBe('!a:test')
    expect(hierarchy.children.get('!a:test')).toEqual(['!b:test', '!child:test'])
  })

  it('removes links when state events are redacted', () => {
    const states = new Map([['!space:test', state(room('m.space'), child('!room:test', ['test']))]])
    const joined = new Set(['!space:test', '!room:test'])
    expect(buildSpaceHierarchy(states, joined).parents.get('!room:test')).toBe('!space:test')
    states.get('!space:test')!.set('m.space.child\0!room:test', child('!room:test', undefined))
    expect(buildSpaceHierarchy(states, joined).parents.has('!room:test')).toBe(false)
  })
})


describe('Matrix Space folder projection', () => {
  it('flattens nesting and retains overlapping rooms in every applicable Space', () => {
    const states = new Map([
      ['!a:test', state(room('m.space'), { type: 'm.room.name', state_key: '', content: { name: 'Team' } },
        child('!b:test', ['test']), child('!shared:test', ['test']), child('!a:test', ['test']))],
      ['!b:test', state(room('m.space'), child('!a:test', ['test']), child('!room:test', ['test']))],
      ['!c:test', state(room('m.space'), child('!shared:test', ['test']), child('!absent:test', ['test']))],
      ['!shared:test', state(room())], ['!room:test', state(room())],
    ])
    const joined = new Set(states.keys())
    expect(buildSpaceFolders(states, joined)).toEqual([
      { id: '!a:test', title: 'Team', conversationIds: ['!room:test', '!shared:test'] },
      { id: '!b:test', title: '!b:test', conversationIds: ['!room:test', '!shared:test'] },
      { id: '!c:test', title: '!c:test', conversationIds: ['!shared:test'] },
    ])
  })

  it('removes redacted links and preserves empty Spaces without inventing chats', () => {
    const states = new Map([
      ['!space:test', state(room('m.space'), child('!room:test', ['test']))],
      ['!room:test', state(room())],
    ])
    expect(buildSpaceFolders(states, new Set(states.keys()))[0]!.conversationIds).toEqual(['!room:test'])
    states.get('!space:test')!.set('m.space.child\\0!room:test', child('!room:test', []))
    expect(buildSpaceFolders(states, new Set(states.keys()))[0]!.conversationIds).toEqual([])
  })
})
