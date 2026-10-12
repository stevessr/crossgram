import type {
  IMConversation, IMMedia, IMMessage, IMMessageInput, IMMessagePart, IMTextEntity, IMTransferOptions, IMUser,
} from '@mtproto-relay/bridge'

export type OneBotRecord = Record<string, unknown>
export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}
export interface OneBotMediaLocator extends Record<string, string> {
  url: string
}

export function record(value: unknown): OneBotRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as OneBotRecord : {}
}

export function oneBotId(value: unknown): string {
  if (typeof value === 'string' && value.length) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return ''
}

export function conversationId(kind: 'private' | 'group', id: string): string {
  return `${kind}:${id}`
}

export function parseConversationId(id: string): { kind: 'private' | 'group', id: string } {
  const separator = id.indexOf(':')
  const kind = id.slice(0, separator)
  const value = id.slice(separator + 1)
  if ((kind !== 'private' && kind !== 'group') || separator < 0 || !/^\d+$/.test(value)) {
    throw new Error(`Invalid OneBot conversation ID: ${id}`)
  }
  return { kind, id: value }
}

function unescapeCq(value: string, parameter = false): string {
  const escaped = parameter ? value.replace(/&#44;/g, ',') : value
  return escaped.replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function cqSegments(input: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  const pattern = /\[CQ:([a-zA-Z][a-zA-Z0-9_-]*)(?:,([^\]]*))?\]/g
  let last = 0
  for (const match of input.matchAll(pattern)) {
    const index = match.index
    if (index > last) segments.push({ type: 'text', data: { text: unescapeCq(input.slice(last, index)) } })
    const data: Record<string, unknown> = {}
    for (const item of (match[2] ?? '').split(',')) {
      const equal = item.indexOf('=')
      if (equal > 0) data[item.slice(0, equal)] = unescapeCq(item.slice(equal + 1), true)
    }
    segments.push({ type: match[1]!, data })
    last = index + match[0].length
  }
  if (last < input.length) segments.push({ type: 'text', data: { text: unescapeCq(input.slice(last)) } })
  return segments
}

export function normalizeSegments(value: unknown): OneBotSegment[] {
  if (typeof value === 'string') return cqSegments(value)
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const element = record(item)
    return typeof element.type === 'string' ? [{ type: element.type, data: record(element.data) }] : []
  })
}

export function mapOneBotUser(value: unknown, fallbackId?: string): IMUser<OneBotMediaLocator> {
  const sender = record(value)
  const id = oneBotId(sender.user_id ?? sender.qq ?? fallbackId)
  const name = String(sender.card || sender.remark || sender.nickname || sender.nick || id)
  return { id, firstName: name, metadata: { onebotId: id } }
}

export function mapOneBotConversation(value: unknown, kind: 'private' | 'group', fallbackName?: string): IMConversation<OneBotMediaLocator> {
  const data = record(value)
  const id = oneBotId(kind === 'group' ? data.group_id : data.user_id)
  const title = String(kind === 'group' ? data.group_name || fallbackName || id : data.remark || data.nickname || fallbackName || id)
  return {
    id: conversationId(kind, id),
    kind: kind === 'group' ? 'group' : 'direct',
    title,
    metadata: { onebotId: id },
  }
}

export function mapOneBotMessage(value: unknown, conversation: IMConversation<OneBotMediaLocator>, selfId?: string): IMMessage<OneBotMediaLocator> {
  const event = record(value)
  const sender = mapOneBotUser(event.sender, oneBotId(event.user_id) || selfId)
  const parts: IMMessagePart<OneBotMediaLocator>[] = []
  let replyToId: string | undefined
  for (const segment of normalizeSegments(event.message ?? event.raw_message)) {
    const data = segment.data
    switch (segment.type) {
      case 'text': {
        const text = String(data.text ?? '')
        if (text) parts.push({ type: 'text', text })
        break
      }
      case 'at': {
        const qq = oneBotId(data.qq)
        const label = qq === 'all' ? '@全体成员' : `@${qq}`
        const entities: IMTextEntity[] = qq && qq !== 'all'
          ? [{ type: 'mention', offset: 0, length: label.length, userId: qq, numericId: qq }]
          : []
        parts.push({ type: 'text', text: label, entities })
        break
      }
      case 'reply':
        replyToId = oneBotId(data.id) || replyToId
        break
      case 'image':
      case 'record':
      case 'video':
      case 'file': {
        const file = String(data.file || '')
        const url = String(data.url || (file.startsWith('http://') || file.startsWith('https://') ? file : ''))
        const image = segment.type === 'image'
        const media: IMMedia<OneBotMediaLocator> = {
          id: file || url || `${segment.type}:${oneBotId(event.message_id)}`,
          kind: image ? 'image' : 'file',
          name: image ? 'image' : segment.type === 'record' ? 'voice' : segment.type,
          ...(segment.type === 'record' ? { voice: true } : {}),
          ...(url ? { locator: { url } } : {}),
        }
        parts.push({ type: 'media', media })
        break
      }
      case 'face':
        parts.push({ type: 'text', text: `[表情:${String(data.id ?? '')}]` })
        break
      default:
        // Keep unknown OneBot segments visible rather than silently losing messages.
        parts.push({ type: 'text', text: `[${segment.type}]` })
    }
  }
  if (!parts.length) parts.push({ type: 'text', text: String(event.raw_message || '') })
  const time = Number(event.time)
  return {
    id: oneBotId(event.message_id),
    conversationId: conversation.id,
    senderId: sender.id,
    sender,
    outgoing: Boolean(selfId && sender.id === selfId),
    timestamp: Number.isFinite(time) && time > 0 ? Math.trunc(time) : Math.trunc(Date.now() / 1000),
    content: { parts },
    ...(replyToId ? { replyToId } : {}),
    metadata: { onebotMessageId: oneBotId(event.message_id) },
  }
}

export async function toOneBotSegments(input: IMMessageInput, options: IMTransferOptions = {}): Promise<OneBotSegment[]> {
  const output: OneBotSegment[] = []
  if (input.replyToId) output.push({ type: 'reply', data: { id: input.replyToId } })
  for (const part of input.parts) {
    if (part.type === 'text') {
      const mentions = (part.entities ?? []).filter((e): e is Extract<IMTextEntity, { type: 'mention' }> => e.type === 'mention')
        .sort((a, b) => a.offset - b.offset)
      let cursor = 0
      for (const entity of mentions) {
        if (entity.offset < cursor || entity.offset + entity.length > part.text.length) continue
        if (entity.offset > cursor) output.push({ type: 'text', data: { text: part.text.slice(cursor, entity.offset) } })
        output.push({ type: 'at', data: { qq: entity.numericId ?? entity.userId } })
        cursor = entity.offset + entity.length
      }
      if (cursor < part.text.length) output.push({ type: 'text', data: { text: part.text.slice(cursor) } })
    } else if (part.type === 'media') {
      if (part.media.kind !== 'image') throw new Error('OneBot V11 standard send API only supports image media')
      // Avoid unlimited in-memory file accumulation for the OneBot base64:// transport.
      const chunks: Uint8Array[] = []
      let total = 0
      for await (const bytes of part.media.source.stream({ signal: options.signal })) {
        total += bytes.length
        if (total > 10 * 1024 * 1024) throw new Error('OneBot image exceeds the 10 MiB inline upload limit')
        chunks.push(bytes)
      }
      const encoded = Buffer.concat(chunks.map((x) => Buffer.from(x))).toString('base64')
      output.push({ type: 'image', data: { file: `base64://${encoded}` } })
    } else {
      throw new Error('OneBot V11 adapter does not support sending native stickers')
    }
  }
  return output
}
