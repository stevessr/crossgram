import Long from 'long'
import type { tl } from '@mtcute/core'
import type { IMMediaInput, IMMessageInputPart } from './platform.js'

/**
 * Telegram "rich messages" (articles) arrive as `inputRichMessage`,
 * `inputRichMessageMarkdown` or `inputRichMessageHTML`. No platform this relay
 * talks to stores an article, so an article is relayed as one ordered body of
 * text and media, and the platform decides how much of the structure it can
 * show: QQ renders the text and the pictures in place, adapters with real
 * formatting keep the entities.
 */

/** One media item an article names, as its block refers to it. */
export interface RichMediaReference {
  kind: 'photo' | 'document'
  /** `pageBlockPhoto.photoId` and friends: the id the declared vector entries carry. */
  id: Long
  /** The declared `inputPhoto`/`inputDocument`, when the request carried one. */
  input?: tl.TypeInputPhoto | tl.TypeInputDocument
  /** Caption of the referencing block, appended after the media. */
  caption?: RichTextContent
}

/** Media the relay resolved for one article reference. */
export interface ResolvedRichMedia {
  media: IMMediaInput
  /** Raw object for a stored article (client drafts); absent for a plain send. */
  rawPhoto?: tl.RawPhoto
  rawDocument?: tl.RawDocument
}

export type RichMediaResolver = (
  reference: RichMediaReference,
) => Promise<ResolvedRichMedia | undefined>

export interface RichMessageConversion {
  /** Ordered relay content: text segments and media, alternating in article order. */
  parts: RichMessagePart[]
  /**
   * Blocks an article keeps once stored, such as a client draft. Media blocks
   * stay only when the resolver produced a raw object for them, so the list
   * always agrees with `photos`/`documents`.
   */
  blocks: tl.TypePageBlock[]
  photos: tl.RawPhoto[]
  documents: tl.RawDocument[]
  /** Whole article text, without media, for previews and length limits. */
  text: string
}

/**
 * One ordered piece of article content.
 *
 * Text parts keep their Telegram entities so the caller can map them with the
 * same rules it uses for an ordinary message.
 */
export type RichMessagePart =
  | { type: 'text', text: string, entities: tl.TypeMessageEntity[] }
  | { type: 'media', media: IMMediaInput }

/** Rich text rendered as one paragraph, with Telegram entities rebased onto it. */
export interface RichTextContent {
  text: string
  entities: tl.TypeMessageEntity[]
}

interface DeclaredMedia {
  kind: 'photo' | 'document'
  input?: tl.TypeInputPhoto | tl.TypeInputDocument
  /** File key of a markdown/HTML request, which its body names instead of an id. */
  key?: string
}

/**
 * Resolve a rich message into relay content.
 *
 * Returns `undefined` when the request carries no usable content, which a
 * caller reports as an empty message rather than sending an empty body.
 */
export async function convertRichMessage(
  input: tl.TypeInputRichMessage,
  resolve: RichMediaResolver,
): Promise<RichMessageConversion | undefined> {
  const declared = declaredRichMedia(input)
  const blocks = normalizeRichBlocks(input, declared)
  const parts: RichMessagePart[] = []
  const photos: tl.RawPhoto[] = []
  const documents: tl.RawDocument[] = []
  const keptBlocks: tl.TypePageBlock[] = []
  let pending: RichTextContent[] = []

  const flush = () => {
    if (!pending.length) return
    const merged = joinRichText(pending)
    pending = []
    if (!merged.text.trim()) return
    parts.push({ type: 'text', text: merged.text, entities: merged.entities })
  }

  for (const block of blocks) {
    const reference = mediaReference(block, declared)
    if (!reference) {
      const content = blockText(block)
      if (content?.text.trim()) pending.push(content)
      keptBlocks.push(block)
      continue
    }
    const resolved = await resolve(reference)
    if (!resolved) {
      // An article may reference media the relay can no longer resolve, such
      // as a draft whose upload was swept. Keep its words, drop the picture,
      // and keep the draft itself usable.
      if (reference.caption?.text.trim()) pending.push(reference.caption)
      continue
    }
    flush()
    parts.push({ type: 'media', media: resolved.media })
    if (resolved.rawPhoto) {
      photos.push(resolved.rawPhoto)
      keptBlocks.push(copyMediaBlock(block, resolved.rawPhoto.id))
    } else if (resolved.rawDocument) {
      documents.push(resolved.rawDocument)
      keptBlocks.push(copyMediaBlock(block, resolved.rawDocument.id))
    } else {
      keptBlocks.push(block)
    }
    if (reference.caption?.text.trim()) pending.push(reference.caption)
  }
  flush()

  if (!parts.length) return
  return {
    parts,
    blocks: keptBlocks,
    photos,
    documents,
    text: parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n'),
  }
}

/** Media vectors a request declares, keyed by the id its blocks name. */
function declaredRichMedia(input: tl.TypeInputRichMessage): Map<string, DeclaredMedia> {
  const declared = new Map<string, DeclaredMedia>()
  if (input._ === 'inputRichMessage') {
    for (const photo of input.photos ?? []) {
      if (photo._ !== 'inputPhoto') continue
      declared.set(photo.id.toString(), { kind: 'photo', input: photo })
    }
    for (const document of input.documents ?? []) {
      if (document._ !== 'inputDocument') continue
      declared.set(document.id.toString(), { kind: 'document', input: document })
    }
    return declared
  }
  // A text body names its files by an arbitrary key, while a block can only
  // refer to a numeric id. Every file therefore gets a private placeholder id
  // that the resolved media replaces once its real id is known.
  for (const [index, file] of (input.files ?? []).entries()) {
    declared.set(String(-(index + 1)), file._ === 'inputRichFilePhoto'
      ? { kind: 'photo', input: file.photo, key: file.id }
      : { kind: 'document', input: file.document, key: file.id })
  }
  return declared
}

/**
 * Blocks a request carries.
 *
 * The markdown and HTML constructors describe the same page in another
 * notation, so they are parsed into the block form the rest of the relay
 * understands.
 */
function normalizeRichBlocks(
  input: tl.TypeInputRichMessage,
  declared: Map<string, DeclaredMedia>,
): tl.TypePageBlock[] {
  if (input._ === 'inputRichMessage') return input.blocks
  const placed = new Set<string>()
  const image = (target: string): tl.TypePageBlock | undefined => {
    const id = declaredImageId(declared, target)
    if (!id) return undefined
    placed.add(id)
    const media = declared.get(id)!
    return media.kind === 'photo'
      ? { _: 'pageBlockPhoto', photoId: Long.fromString(id), caption: emptyCaption() }
      : { _: 'pageBlockDocument', documentId: Long.fromString(id), caption: emptyCaption() }
  }
  const blocks = input._ === 'inputRichMessageMarkdown'
    ? markdownBlocks(input.markdown, image)
    : htmlBlocks(input.html, image)
  // Inline file references are not standardized across clients, so a file the
  // body names is placed where it appears and every other file follows the
  // text: no attachment is silently dropped.
  for (const [id, media] of declared) {
    if (placed.has(id)) continue
    blocks.push(media.kind === 'photo'
      ? { _: 'pageBlockPhoto', photoId: Long.fromString(id), caption: emptyCaption() }
      : { _: 'pageBlockDocument', documentId: Long.fromString(id), caption: emptyCaption() })
  }
  return blocks
}

/** The declared file an image reference names, when it names one at all. */
function declaredImageId(declared: Map<string, DeclaredMedia>, target: string): string | undefined {
  const tail = /(?:^|[/?#&]|id=)([^/?#&]+)$/u.exec(target)?.[1]
  for (const [id, media] of declared) {
    const key = media.key ?? id
    if (key === target || (tail !== undefined && key === tail)) return id
  }
  return undefined
}

function emptyCaption(): tl.RawPageCaption {
  return { _: 'pageCaption', text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } }
}

function mediaReference(
  block: tl.TypePageBlock,
  declared: Map<string, DeclaredMedia>,
): RichMediaReference | undefined {
  if (block._ === 'pageBlockPhoto') {
    const entry = declared.get(block.photoId.toString())
    return {
      kind: 'photo', id: block.photoId,
      ...(entry?.input ? { input: entry.input } : {}),
      caption: richTextContent(block.caption?.text),
    }
  }
  if (block._ === 'pageBlockVideo' || block._ === 'pageBlockAudio' || block._ === 'pageBlockDocument') {
    const id = block._ === 'pageBlockVideo' ? block.videoId
      : block._ === 'pageBlockAudio' ? block.audioId : block.documentId
    const entry = declared.get(id.toString())
    return {
      kind: 'document', id,
      ...(entry?.input ? { input: entry.input } : {}),
      caption: richTextContent(block.caption?.text),
    }
  }
  return undefined
}

/** Point a media block at the object the relay will store. */
function copyMediaBlock(block: tl.TypePageBlock, id: Long): tl.TypePageBlock {
  if (block._ === 'pageBlockPhoto') return { ...block, photoId: id }
  if (block._ === 'pageBlockVideo') return { ...block, videoId: id }
  if (block._ === 'pageBlockAudio') return { ...block, audioId: id }
  if (block._ === 'pageBlockDocument') return { ...block, documentId: id }
  return { _: 'pageBlockDocument', documentId: id, caption: emptyCaption() }
}

function joinRichText(paragraphs: readonly RichTextContent[]): RichTextContent {
  const text: string[] = []
  const entities: tl.TypeMessageEntity[] = []
  for (const paragraph of paragraphs) {
    if (text.length) {
      text.push('\n\n')
      shiftEntities(entities, 2)
    }
    const offset = text.join('').length
    text.push(paragraph.text)
    for (const entity of paragraph.entities) {
      entities.push({ ...entity, offset: entity.offset + offset } as tl.TypeMessageEntity)
    }
  }
  return { text: text.join(''), entities }
}

function shiftEntities(entities: tl.TypeMessageEntity[], delta: number): void {
  for (const entity of entities) entity.offset += delta
}

/** Text one block contributes, with the formatting Telegram entities can carry. */
function blockText(block: tl.TypePageBlock): RichTextContent | undefined {
  switch (block._) {
    case 'pageBlockTitle':
    case 'pageBlockHeader':
    case 'pageBlockSubheader':
    case 'pageBlockKicker':
    case 'pageBlockHeading1':
    case 'pageBlockHeading2':
    case 'pageBlockHeading3':
    case 'pageBlockHeading4':
    case 'pageBlockHeading5':
    case 'pageBlockHeading6': {
      const content = richTextContent(block.text)
      return content ? boldRichText(content) : undefined
    }
    case 'pageBlockSubtitle':
      return richTextContent(block.text)
    case 'pageBlockParagraph':
      return richTextContent(block.text)
    case 'pageBlockThinking':
      return richTextContent(block.text)
    case 'pageBlockFooter':
      return richTextContent(block.text)
    case 'pageBlockAuthorDate': {
      const author = richTextContent(block.author)
      return author
    }
    case 'pageBlockPreformatted':
      return richTextContent(block.text)
    case 'pageBlockMath':
      return { text: block.source, entities: [] }
    case 'pageBlockBlockquote':
    case 'pageBlockPullquote':
      return joinRichText([richTextContent(block.text), richTextContent(block.caption)].filter(
        (item): item is RichTextContent => Boolean(item?.text.trim()),
      ))
    case 'pageBlockBlockquoteBlocks':
    case 'pageBlockDetails': {
      const head = block._ === 'pageBlockDetails' ? richTextContent(block.title) : undefined
      return joinRichText([
        ...(head ? [head] : []),
        ...block.blocks.map((item) => blockText(item)).filter((item): item is RichTextContent => Boolean(item)),
      ])
    }
    case 'pageBlockList':
      return { text: block.items.map((item) => listItemText(item)).join('\n'), entities: [] }
    case 'pageBlockOrderedList':
      return {
        text: block.items.map((item, index) => `${
          item._ === 'pageListOrderedItemText' && item.num ? `${item.num}.` : `${index + 1}.`
        } ${listItemText(item)}`).join('\n'),
        entities: [],
      }
    case 'pageBlockTable':
      return {
        text: block.rows.map((row) => row.cells
          .map((cell) => cell.text ? richTextContent(cell.text)?.text ?? '' : '')
          .join(' | ')).join('\n'),
        entities: [],
      }
    case 'pageBlockRelatedArticles':
      return {
        text: block.articles.map((article) => article.url).filter(Boolean).join('\n'),
        entities: [],
      }
    case 'pageBlockCover':
      return blockText(block.cover)
    case 'pageBlockCollage':
    case 'pageBlockSlideshow':
      return joinRichText([
        ...block.items.map((item) => blockText(item)).filter((item): item is RichTextContent => Boolean(item)),
        ...(richTextContent(block.caption?.text)?.text.trim() ? [richTextContent(block.caption.text)!] : []),
      ])
    case 'pageBlockEmbedPost':
      return joinRichText([
        { text: block.author, entities: [] },
        ...block.blocks.map((item) => blockText(item)).filter((item): item is RichTextContent => Boolean(item)),
      ])
    case 'pageBlockEmbed': {
      const caption = richTextContent(block.caption?.text)
      if (caption?.text.trim()) return caption
      return block.url ? { text: block.url, entities: [] } : undefined
    }
    default:
      return undefined
  }
}

function listItemText(item: tl.TypePageListItem | tl.TypePageListOrderedItem): string {
  if (item._ === 'pageListItemText' || item._ === 'pageListOrderedItemText') {
    return richTextContent(item.text)?.text ?? ''
  }
  return item.blocks.map((block) => blockText(block)?.text ?? '').filter(Boolean).join(' ')
}

function boldRichText(content: RichTextContent): RichTextContent {
  if (!content.text.length) return content
  const longest = content.entities.find((entity) => entity.offset === 0 && entity.length === content.text.length)
  if (longest) return content
  return {
    text: content.text,
    entities: [...content.entities, { _: 'messageEntityBold', offset: 0, length: content.text.length }],
  }
}

/** Render Telegram rich text as plain text plus the entities that can carry it. */
export function richTextContent(input: tl.TypeRichText | undefined): RichTextContent | undefined {
  if (!input) return undefined
  const state: { text: string, entities: tl.TypeMessageEntity[], pre?: string } = { text: '', entities: [] }
  walkRichText(input, state, {})
  return { text: state.text, entities: state.entities }
}

interface RichTextFormat {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  pre?: string
  url?: string
}

function walkRichText(
  input: tl.TypeRichText,
  state: { text: string, entities: tl.TypeMessageEntity[] },
  format: RichTextFormat,
): void {
  const node = input as unknown as Record<string, unknown> & { _: string }
  const offset = state.text.length
  const decorate = () => {
    const length = state.text.length - offset
    if (!length) return
    const push = (entity: tl.TypeMessageEntity) => state.entities.push(entity)
    if (format.pre !== undefined) {
      push({ _: 'messageEntityPre', offset, length, language: format.pre })
      return
    }
    if (format.url) push({ _: 'messageEntityTextUrl', offset, length, url: format.url })
    if (format.code) push({ _: 'messageEntityCode', offset, length })
    if (format.bold) push({ _: 'messageEntityBold', offset, length })
    if (format.italic) push({ _: 'messageEntityItalic', offset, length })
    if (format.underline) push({ _: 'messageEntityUnderline', offset, length })
    if (format.strike) push({ _: 'messageEntityStrike', offset, length })
  }

  switch (node._) {
    case 'textEmpty':
      return
    case 'textPlain':
      state.text += String(node.text ?? '')
      break
    case 'textBold':
      walkChild(node, state, { ...format, bold: true })
      break
    case 'textItalic':
      walkChild(node, state, { ...format, italic: true })
      break
    case 'textUnderline':
      walkChild(node, state, { ...format, underline: true })
      break
    case 'textStrike':
      walkChild(node, state, { ...format, strike: true })
      break
    case 'textFixed':
      walkChild(node, state, { ...format, code: true })
      break
    case 'textUrl':
      walkChild(node, state, { ...format, url: String(node.url ?? '') })
      break
    case 'textMentionName': {
      const start = state.text.length
      walkChild(node, state, format)
      const text = state.text.slice(start)
      const userId = Number(node.userId)
      if (text.length && Number.isFinite(userId)) {
        state.entities.push({ _: 'messageEntityMentionName', offset: start, length: text.length, userId })
      }
      break
    }
    case 'textCustomEmoji': {
      const alt = String(node.alt ?? '')
      state.text += alt
      const documentId = node.documentId as Long | undefined
      if (documentId && alt.length) {
        state.entities.push({
          _: 'messageEntityCustomEmoji', offset, length: alt.length, documentId,
        })
      }
      break
    }
    case 'textConcat': {
      for (const child of (node.texts as tl.TypeRichText[] | undefined) ?? []) {
        walkRichText(child, state, format)
      }
      break
    }
    case 'textMath': {
      const source = String(node.source ?? '')
      state.text += source ? `$${source}$` : ''
      break
    }
    default: {
      // Remaining constructors (mail, phone, hashtag, anchors, spoilers,
      // subscript and friends) either wrap another rich text or carry their
      // own plain text; keep the words and drop the decoration.
      if (typeof node.text === 'string') {
        state.text += node.text
        break
      }
      if (node.text && typeof node.text === 'object') {
        walkRichText(node.text as tl.TypeRichText, state, format)
        break
      }
      if (node.source !== undefined) state.text += String(node.source)
      break
    }
  }
  decorate()
}

function walkChild(
  node: Record<string, unknown>,
  state: { text: string, entities: tl.TypeMessageEntity[] },
  format: RichTextFormat,
): void {
  const child = node.text
  if (!child || typeof child !== 'object') return
  walkRichText(child as tl.TypeRichText, state, format)
}

function richTextToTl(content: RichTextContent): tl.TypeRichText {
  if (!content.entities.length) return { _: 'textPlain', text: content.text }
  const boundaries = [
    0, content.text.length,
    ...content.entities.flatMap((entity) => [entity.offset, entity.offset + entity.length]),
  ]
  const unique = [...new Set(boundaries)].filter((value) => value >= 0 && value <= content.text.length)
    .sort((left, right) => left - right)
  const segments: tl.TypeRichText[] = []
  for (let index = 0; index + 1 < unique.length; index++) {
    const start = unique[index]!
    const end = unique[index + 1]!
    if (start === end) continue
    let segment: tl.TypeRichText = { _: 'textPlain', text: content.text.slice(start, end) }
    for (const entity of content.entities.filter((item) => item.offset <= start && item.offset + item.length >= end)) {
      segment = wrapRichText(segment, entity)
    }
    segments.push(segment)
  }
  return segments.length === 1 ? segments[0]! : { _: 'textConcat', texts: segments }
}

function wrapRichText(text: tl.TypeRichText, entity: tl.TypeMessageEntity): tl.TypeRichText {
  switch (entity._) {
    case 'messageEntityBold': return { _: 'textBold', text }
    case 'messageEntityItalic': return { _: 'textItalic', text }
    case 'messageEntityUnderline': return { _: 'textUnderline', text }
    case 'messageEntityStrike': return { _: 'textStrike', text }
    case 'messageEntityCode': return { _: 'textFixed', text }
    case 'messageEntityPre': return { _: 'textFixed', text }
    case 'messageEntityTextUrl': return { _: 'textUrl', text, url: entity.url, webpageId: Long.ZERO }
    case 'messageEntityUrl': return { _: 'textUrl', text, url: text._ === 'textPlain' ? text.text : '', webpageId: Long.ZERO }
    case 'messageEntityMentionName': return { _: 'textMentionName', text, userId: entity.userId }
    case 'messageEntityCustomEmoji': return {
      _: 'textCustomEmoji',
      documentId: entity.documentId,
      alt: text._ === 'textPlain' ? text.text : '',
    }
    default: return text
  }
}

/** Inline image reference, whose target may name a file of the article. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/gu

/**
 * Markdown article body, rendered into the block form of an article.
 *
 * `image` decides what an inline image reference means: a declared file becomes
 * a media block in place, and anything else stays as its own text.
 */
export function markdownBlocks(
  markdown: string,
  image?: (target: string) => tl.TypePageBlock | undefined,
): tl.TypePageBlock[] {
  const blocks: tl.TypePageBlock[] = []
  let paragraph = ''
  let code: { language: string, lines: string[] } | undefined
  let quote: string[] = []

  const flushParagraph = () => {
    const text = paragraph.trim()
    paragraph = ''
    if (text) blocks.push({ _: 'pageBlockParagraph', text: markdownRichText(text) })
  }
  const flushQuote = () => {
    if (!quote.length) return
    const text = quote.join('\n').trim()
    quote = []
    if (text) blocks.push({ _: 'pageBlockBlockquote', text: markdownRichText(text), caption: { _: 'textEmpty' } })
  }
  const appendLine = (line: string) => {
    const pieces = line.split(MARKDOWN_IMAGE)
    for (let index = 0; index < pieces.length; index += 3) {
      paragraph += pieces[index] ?? ''
      const alt = pieces[index + 1]
      if (alt === undefined) break
      const target = pieces[index + 2]!
      const block = image?.(target)
      if (!block) {
        paragraph += alt || target
        continue
      }
      flushParagraph()
      blocks.push(block)
    }
  }

  for (const line of markdown.split(/\r?\n/u)) {
    if (code) {
      if (line.trimStart().startsWith('```')) {
        blocks.push({
          _: 'pageBlockPreformatted', language: code.language,
          text: { _: 'textPlain', text: code.lines.join('\n') },
        })
        code = undefined
      } else {
        code.lines.push(line)
      }
      continue
    }
    const fence = /^\s*```(\S*)\s*$/u.exec(line)
    if (fence) {
      flushParagraph()
      flushQuote()
      code = { language: fence[1] ?? '', lines: [] }
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushQuote()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading) {
      flushParagraph()
      flushQuote()
      const level = heading[1]!.length
      blocks.push({
        _: `pageBlockHeading${level}` as 'pageBlockHeading1',
        text: markdownRichText(heading[2]!.trim()),
      })
      continue
    }
    const quoted = /^\s*>\s?(.*)$/u.exec(line)
    if (quoted) {
      flushParagraph()
      quote.push(quoted[1]!)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line)
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      flushQuote()
      const item = markdownRichText((bullet?.[1] ?? ordered?.[2] ?? '').trim())
      const list = blocks.at(-1)
      if (list?._ === 'pageBlockList' && bullet) list.items.push({ _: 'pageListItemText', text: item })
      else if (list?._ === 'pageBlockOrderedList' && ordered) {
        list.items.push({ _: 'pageListOrderedItemText', text: item, num: ordered[1]! })
      } else if (bullet) blocks.push({ _: 'pageBlockList', items: [{ _: 'pageListItemText', text: item }] })
      else {
        blocks.push({
          _: 'pageBlockOrderedList', items: [{ _: 'pageListOrderedItemText', text: item, num: ordered![1]! }],
        })
      }
      continue
    }
    if (paragraph) paragraph += '\n'
    appendLine(line)
  }
  if (code) {
    blocks.push({
      _: 'pageBlockPreformatted', language: code.language,
      text: { _: 'textPlain', text: code.lines.join('\n') },
    })
  }
  flushParagraph()
  flushQuote()
  return blocks
}

function markdownRichText(text: string): tl.TypeRichText {
  const content = parseInlineMarkdown(text)
  return richTextToTl(content)
}

const INLINE_MARKDOWN: Array<{ pattern: RegExp, type: tl.TypeMessageEntity['_'] }> = [
  { pattern: /\*\*([^*]+)\*\*/gu, type: 'messageEntityBold' },
  { pattern: /~~([^~]+)~~/gu, type: 'messageEntityStrike' },
  { pattern: /__([^_]+)__/gu, type: 'messageEntityItalic' },
  { pattern: /`([^`]+)`/gu, type: 'messageEntityCode' },
]

/** Inline markdown subset: bold, strike, italic, code and links. */
export function parseInlineMarkdown(text: string): RichTextContent {
  let content: RichTextContent = { text, entities: [] }
  for (const rule of INLINE_MARKDOWN) {
    while (true) {
      rule.pattern.lastIndex = 0
      const match = rule.pattern.exec(content.text)
      if (!match) break
      content = wrapInlineRange(content, match.index, match[0].length, match[1]!, rule.type)
    }
  }
  const link = /\[([^\]]+)\]\(([^)\s]+)\)/u.exec(content.text)
  if (link) {
    content = wrapInlineRange(
      content, link.index, link[0].length, link[1]!, 'messageEntityTextUrl', link[2]!,
    )
  }
  return content
}

/** Replace one matched span with its inner text, keeping the entities around it aligned. */
function wrapInlineRange(
  content: RichTextContent,
  offset: number,
  fullLength: number,
  inner: string,
  type: tl.TypeMessageEntity['_'],
  url?: string,
): RichTextContent {
  const text = `${content.text.slice(0, offset)}${inner}${content.text.slice(offset + fullLength)}`
  const delta = inner.length - fullLength
  const entities = content.entities.flatMap((entity) => {
    if (entity.offset + entity.length <= offset) return [entity]
    if (entity.offset >= offset + fullLength) {
      return [{ ...entity, offset: entity.offset + delta } as tl.TypeMessageEntity]
    }
    // An entity that straddled a marker boundary has no safe rebase; drop it
    // rather than cover text it never described.
    return []
  })
  const added = url
    ? { _: type, offset, length: inner.length, url } as tl.TypeMessageEntity
    : { _: type, offset, length: inner.length } as tl.TypeMessageEntity
  return { text, entities: [...entities, added] }
}

/**
 * HTML article body, rendered into the block form of an article.
 *
 * Only the document structure (paragraphs, headings, lists, preformatted code)
 * survives; inline HTML formatting is not translated into entities.
 */
export function htmlBlocks(
  html: string,
  image?: (target: string) => tl.TypePageBlock | undefined,
): tl.TypePageBlock[] {
  const blocks: tl.TypePageBlock[] = []
  const tokens = html.split(/(<[^>]*>)/u)
  let paragraph = ''
  let code: string[] | undefined
  let heading: number | undefined

  const flush = () => {
    const text = paragraph.replace(/\s+/gu, ' ').trim()
    paragraph = ''
    if (!text) {
      heading = undefined
      return
    }
    blocks.push(heading
      ? { _: `pageBlockHeading${heading}` as 'pageBlockHeading1', text: { _: 'textPlain', text } }
      : { _: 'pageBlockParagraph', text: { _: 'textPlain', text } })
    heading = undefined
  }
  const flushCode = () => {
    blocks.push({
      _: 'pageBlockPreformatted', language: '',
      text: { _: 'textPlain', text: (code ?? []).join('').replace(/^\s+|\s+$/gu, '') },
    })
    code = undefined
  }

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const text = decodeHtmlEntities(token)
      if (code) code.push(text)
      else paragraph += text
      continue
    }
    const tag = /^<(\/?)\s*([a-zA-Z0-9]+)/u.exec(token)
    if (!tag) continue
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    if (name === 'pre') {
      if (closing) flushCode()
      else {
        flush()
        code = []
      }
      continue
    }
    if (code) {
      if (name === 'br') code.push('\n')
      continue
    }
    if (name === 'img') {
      const target = /\bsrc\s*=\s*["']?([^"'\s>]+)/iu.exec(token)?.[1]
      const block = target ? image?.(target) : undefined
      if (block) {
        flush()
        blocks.push(block)
      }
      continue
    }
    const headingLevel = /^h([1-6])$/u.exec(name)
    if (headingLevel) {
      if (closing) flush()
      else {
        flush()
        heading = Number(headingLevel[1])
      }
      continue
    }
    if (name === 'br' || name === 'p' || name === 'div' || name === 'li' || name === 'blockquote') {
      flush()
      continue
    }
  }
  if (code) flushCode()
  flush()
  return blocks
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
}
