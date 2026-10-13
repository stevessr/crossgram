import { Parser } from 'htmlparser2'
import type { IMTextEntity } from '@mtproto-relay/bridge'

type Style = Extract<IMTextEntity, { type: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'blockquote' | 'spoiler' }>['type']
const styles: Record<string, Style> = { b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline', ins: 'underline', s: 'strikethrough', del: 'strikethrough', strike: 'strikethrough', code: 'code', pre: 'pre', blockquote: 'blockquote', h1: 'bold', h2: 'bold', h3: 'bold', h4: 'bold', h5: 'bold', h6: 'bold' }
const blocks = new Set(['p', 'div', 'blockquote', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr'])
export function safeLink(url: string): boolean {
  try { return ['http:', 'https:', 'mailto:', 'ftp:', 'magnet:'].includes(new URL(url).protocol) }
  catch { return false }
}
export function matrixUserLink(href: string): string | undefined {
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' || url.hostname !== 'matrix.to' || !url.hash.startsWith('#/')) return
    const id = decodeURIComponent(url.hash.slice(2).split('?')[0]!)
    return /^@[^:\s]+:[^\s]+$/u.test(id) ? id : undefined
  } catch { return }
}

/** Parse inert Matrix HTML, never a DOM: offsets always refer to rendered UTF-16 text. */
export function parseMatrixHtml(html: string, mentions: ReadonlySet<string>): { text: string, entities: IMTextEntity[] } {
  let text = '', skipped = 0
  const entities: IMTextEntity[] = []
  const stack: Array<{ tag: string, offset: number, style?: Style, url?: string, language?: string, counter?: number }> = []
  const newline = () => { if (text && !text.endsWith('\n')) text += '\n' }
  const parser = new Parser({
    onopentag(tag, attributes) {
      if (skipped || ['script', 'style', 'iframe', 'object', 'mx-reply'].includes(tag) || stack.length >= 100) { skipped++; return }
      if (blocks.has(tag)) newline()
      const frame = { tag, offset: text.length, style: styles[tag], url: undefined as string | undefined, language: undefined as string | undefined, counter: undefined as number | undefined }
      if (tag === 'ol') frame.counter = Number.isSafeInteger(Number(attributes.start)) ? Number(attributes.start) : 1
      if (tag === 'li') {
        const list = [...stack].reverse().find(item => item.tag === 'ol' || item.tag === 'ul')
        text += list?.tag === 'ol' ? `${list.counter!++}. ` : '• '
        frame.offset = text.length
      }
      if (tag === 'br') text += '\n'
      if (tag === 'img') text += attributes.alt ?? ''
      if (tag === 'span' && Object.hasOwn(attributes, 'data-mx-spoiler')) frame.style = 'spoiler'
      if (tag === 'a' && safeLink(attributes.href ?? '')) frame.url = attributes.href
      if (tag === 'code' && stack.some(item => item.tag === 'pre')) {
        frame.style = undefined
        const pre = [...stack].reverse().find(item => item.tag === 'pre')!
        pre.language = /(?:^|\s)language-([\w+-]+)/u.exec(attributes.class ?? '')?.[1]
      }
      stack.push(frame)
    },
    ontext(value) {
      if (skipped) return
      if (!stack.some(item => item.tag === 'pre')) {
        value = value.replace(/[\t\r\n ]+/gu, ' ')
        if (!text || /[\n ]$/u.test(text)) value = value.replace(/^ /u, '')
      }
      text += value
    },
    onclosetag() {
      if (skipped) { skipped--; return }
      const frame = stack.pop()
      if (!frame) return
      const length = text.length - frame.offset
      if (length > 0) {
        if (frame.style) entities.push({ type: frame.style, offset: frame.offset, length, ...(frame.language ? { language: frame.language } : {}) })
        if (frame.url) {
          const userId = matrixUserLink(frame.url)
          entities.push(userId && mentions.has(userId)
            ? { type: 'mention', offset: frame.offset, length, userId }
            : { type: 'text-link', offset: frame.offset, length, url: frame.url })
        }
      }
      if (blocks.has(frame.tag)) newline()
      if (frame.tag === 'td' || frame.tag === 'th') text += '\t'
    },
  }, { decodeEntities: true })
  parser.end(html)
  text = text.replace(/[\n\t]+$/u, '')
  return { text, entities: entities.map(entity => ({ ...entity, length: Math.min(entity.length, text.length - entity.offset) }))
    .filter(entity => entity.length > 0).sort((a, b) => a.offset - b.offset || b.length - a.length) }
}

export function escapeHtml(text: string): string {
  const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return text.replace(/[&<>"']/gu, char => escaped[char]!)
}

/** Split crossing ranges into valid nested HTML without losing visible text. */
export function renderMatrixHtml(body: string, entities: readonly IMTextEntity[]): string {
  const tag = (entity: IMTextEntity): [string, string] | undefined => {
    const simple: Partial<Record<IMTextEntity['type'], string>> = { bold: 'strong', italic: 'em', underline: 'u', strikethrough: 'del', code: 'code', blockquote: 'blockquote' }
    const name = simple[entity.type]
    if (name) return [`<${name}>`, `</${name}>`]
    if (entity.type === 'pre') return [`<pre><code${entity.language ? ` class="language-${escapeHtml(entity.language)}"` : ''}>`, '</code></pre>']
    if (entity.type === 'spoiler') return ['<span data-mx-spoiler>', '</span>']
    if (entity.type === 'mention') return [`<a href="https://matrix.to/#/${encodeURIComponent(entity.userId)}">`, '</a>']
    if (entity.type === 'text-link' && safeLink(entity.url)) return [`<a href="${escapeHtml(entity.url)}">`, '</a>']
  }
  const ranges = entities.flatMap(entity => {
    const tags = tag(entity)
    return tags ? [{ entity, tags }] : []
  }).sort((a, b) => a.entity.offset - b.entity.offset || b.entity.length - a.entity.length)
  const points = [...new Set([0, body.length, ...ranges.flatMap(({ entity }) => [entity.offset, entity.offset + entity.length])])].sort((a, b) => a - b)
  let html = '', active: typeof ranges = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!, end = points[i + 1]!
    const next = ranges.filter(({ entity }) => entity.offset <= start && entity.offset + entity.length >= end)
    let common = 0
    while (common < active.length && active[common] === next[common]) common++
    for (let j = active.length - 1; j >= common; j--) html += active[j]!.tags[1]
    for (let j = common; j < next.length; j++) html += next[j]!.tags[0]
    const escaped = escapeHtml(body.slice(start, end))
    html += next.some(item => item.entity.type === 'pre') ? escaped : escaped.replace(/\n/gu, '<br>')
    active = next
  }
  for (const item of active.reverse()) html += item.tags[1]
  return html
}
