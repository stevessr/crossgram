import type { MatrixEvent } from './types.js'

/** A room can appear in several Matrix Spaces; the bridge currently has one parentId. */
export interface MatrixSpaceHierarchy {
  parents: Map<string, string>
  children: Map<string, string[]>
}

/**
 * Project authoritative m.space.child state for joined rooms into a deterministic
 * single-parent forest. Empty/redacted child events must not retain old links.
 */
export function buildSpaceHierarchy(
  states: ReadonlyMap<string, ReadonlyMap<string, MatrixEvent>>,
  joinedRoomIds: ReadonlySet<string>,
): MatrixSpaceHierarchy {
  const candidates = new Map<string, Array<{ parentId: string, order?: string }>>()

  for (const [parentId, state] of states) {
    if (!joinedRoomIds.has(parentId)) continue
    const create = state.get('m.room.create\0')?.content as { type?: string } | undefined
    if (create?.type !== 'm.space') continue

    for (const event of state.values()) {
      if (event.type !== 'm.space.child' || !event.state_key) continue
      const childId = event.state_key
      if (childId === parentId || !joinedRoomIds.has(childId)) continue
      const content = event.content as { via?: unknown, order?: unknown } | undefined
      if (!content || !Array.isArray(content.via) || content.via.length === 0
        || !content.via.every((via) => typeof via === 'string' && via.length > 0)) continue
      const order = typeof content.order === 'string'
        && content.order.length <= 50 && /^[\x20-\x7e]*$/.test(content.order)
        ? content.order : undefined
      const list = candidates.get(childId) ?? []
      list.push({ parentId, order })
      candidates.set(childId, list)
    }
  }

  const parents = new Map<string, string>()
  // The Matrix relation is a graph. The bridge's parentId model is a tree:
  // choose one stable parent and drop edges that would introduce cycles.
  const edges = [...candidates.entries()]
    .flatMap(([childId, options]) => options.map((option) => ({ childId, parentId: option.parentId })))
    .sort((a, b) => a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1
      : a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0)
  for (const { childId, parentId } of edges) {
    if (parents.has(childId) || wouldCreateCycle(childId, parentId, parents)) continue
    parents.set(childId, parentId)
  }

  const orderedChildren = new Map<string, Array<{ id: string, order?: string }>>()
  for (const [childId, parentId] of parents) {
    const order = candidates.get(childId)?.find((item) => item.parentId === parentId)?.order
    const list = orderedChildren.get(parentId) ?? []
    list.push({ id: childId, order })
    orderedChildren.set(parentId, list)
  }

  const children = new Map<string, string[]>()
  for (const [parentId, list] of orderedChildren) {
    list.sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined) {
        const comparison = a.order < b.order ? -1 : a.order > b.order ? 1 : 0
        if (comparison) return comparison
      } else if (a.order !== undefined || b.order !== undefined) {
        return a.order !== undefined ? -1 : 1
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    children.set(parentId, list.map((entry) => entry.id))
  }
  return { parents, children }
}

function wouldCreateCycle(childId: string, parentId: string, parents: ReadonlyMap<string, string>): boolean {
  let current: string | undefined = parentId
  while (current) {
    if (current === childId) return true
    current = parents.get(current)
  }
  return false
}
