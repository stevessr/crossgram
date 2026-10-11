import type { IMTextEntity } from '@mtproto-relay/bridge'
import type { MatrixRoomMessageContent } from './types.js'

type MentionEntity = Extract<IMTextEntity, { type: 'mention' }>

/**
 * Render Telegram/Crossgram mention entities into both Matrix's notification
 * metadata and Matrix-compatible HTML links. Entity offsets are UTF-16 units.
 * Plain text is retained unchanged for clients that do not render HTML.
 */
export function textContent(
  body: string,
  replyToId?: string,
  entities?: readonly IMTextEntity[],
): MatrixRoomMessageContent {
  const mentions = (entities ?? [])
    .filter((entity): entity is MentionEntity =>
      entity.type === 'mention'
      && Number.isSafeInteger(entity.offset) && entity.offset >= 0
      && Number.isSafeInteger(entity.length) && entity.length > 0
      && entity.offset + entity.length <= body.length
      && isMatrixUserId(entity.userId))
    .sort((a, b) => a.offset - b.offset || b.length - a.length)

  const selected: MentionEntity[] = []
  for (const mention of mentions) {
    if (selected.length && mention.offset < selected[selected.length - 1]!.offset + selected[selected.length - 1]!.length) continue
    selected.push(mention)
  }

  const content: MatrixRoomMessageContent = { msgtype: 'm.text', body }
  if (selected.length) {
    let html = ''
    let cursor = 0
    for (const mention of selected) {
      html += escapeHtml(body.slice(cursor, mention.offset))
      html += '<a href="https://matrix.to/#/' + encodeURIComponent(mention.userId) + '">'
        + escapeHtml(body.slice(mention.offset, mention.offset + mention.length)) + '</a>'
      cursor = mention.offset + mention.length
    }
    content.format = 'org.matrix.custom.html'
    content.formatted_body = html + escapeHtml(body.slice(cursor))
    content['m.mentions'] = { user_ids: [...new Set(selected.map((mention) => mention.userId))] }
  }
  if (replyToId) content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyToId } }
  return content
}

/** The explicit Matrix notification targets are authoritative, even without HTML. */
export function matrixMentionUserIds(content: MatrixRoomMessageContent): string[] {
  const ids = content['m.mentions']?.user_ids
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && isMatrixUserId(id)))]
}

/**
 * Reconstruct clickable text mention ranges when Matrix clients provide a
 * matrix.to link or write the MXID directly into the plain-text body. The
 * explicit m.mentions list is authoritative; guessed @words must not notify.
 * A notification target without a discoverable text span is retained in the
 * message metadata by MatrixPlatform instead of inventing an invalid range.
 */
export function matrixTextEntities(content: MatrixRoomMessageContent): IMTextEntity[] | undefined {
  const body = content.body ?? ''
  const mentioned = new Set(matrixMentionUserIds(content))
  if (!body || !mentioned.size) return undefined
  const entities: MentionEntity[] = []
  const linked = new Set<string>()

  if (content.format === 'org.matrix.custom.html' && content.formatted_body) {
    const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu
    let match: RegExpExecArray | null
    let cursor = 0
    while ((match = anchors.exec(content.formatted_body)) !== null) {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(match[1]!)
      const id = href ? matrixUserIdFromLink(decodeHtml(href[1] ?? href[2] ?? '')) : undefined
      if (!id || !mentioned.has(id)) continue
      const label = decodeHtml(match[2]!.replace(/<br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, ''))
      if (!label) continue
      const offset = body.indexOf(label, cursor)
      if (offset < 0) continue
      entities.push({ type: 'mention', offset, length: label.length, userId: id })
      linked.add(id)
      cursor = offset + label.length
    }
  }

  // Older/plain Matrix clients may include only m.mentions + literal MXIDs.
  for (const id of mentioned) {
    if (linked.has(id)) continue
    let cursor = 0
    while (cursor < body.length) {
      const offset = body.indexOf(id, cursor)
      if (offset < 0) break
      cursor = offset + id.length
      if (entities.some((entity) => rangesOverlap(entity.offset, entity.length, offset, id.length))) continue
      entities.push({ type: 'mention', offset, length: id.length, userId: id })
    }
  }
  return entities.length ? entities.sort((a, b) => a.offset - b.offset) : undefined
}

function isMatrixUserId(id: string): boolean {
  return /^@[^:\s]+:[^\s]+$/u.test(id)
}

function matrixUserIdFromLink(href: string): string | undefined {
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' || url.hostname !== 'matrix.to' || !url.hash.startsWith('#/')) return
    const id = decodeURIComponent(url.hash.slice(2).split('?')[0]!)
    return isMatrixUserId(id) ? id : undefined
  } catch {
    return undefined
  }
}

function rangesOverlap(aStart: number, aLength: number, bStart: number, bLength: number): boolean {
  return aStart < bStart + bLength && bStart < aStart + aLength
}

function escapeHtml(text: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }
  return text.replace(/[&<>"']/gu, (char) => escapes[char]!)
}

function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (encoded, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint) : encoded
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
      as Record<string, string>)[entity.toLowerCase()] ?? encoded
  })
}
