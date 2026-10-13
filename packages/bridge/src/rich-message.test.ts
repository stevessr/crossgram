import Long from 'long'
import { describe, expect, it, vi } from 'vitest'
import type { tl } from '@mtcute/core'
import {
  convertRichMessage, htmlBlocks, markdownBlocks, parseInlineMarkdown, richTextContent,
  type RichMediaReference, type ResolvedRichMedia,
} from './rich-message.js'

function photo(id: number, caption?: tl.TypeRichText): tl.RawPageBlockPhoto {
  return {
    _: 'pageBlockPhoto', photoId: Long.fromNumber(id),
    caption: {
      _: 'pageCaption',
      text: caption ?? { _: 'textEmpty' },
      credit: { _: 'textEmpty' },
    },
  }
}

function inputPhoto(id: number): tl.RawInputPhoto {
  return {
    _: 'inputPhoto', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
    fileReference: new Uint8Array([id]),
  }
}

function resolved(kind: 'image' | 'file', id: number): ResolvedRichMedia {
  return {
    media: {
      kind, name: `${kind}-${id}`, size: 4,
      source: { async *stream() { yield new Uint8Array([1, 2, 3, 4]) } },
    },
    rawPhoto: kind === 'image'
      ? {
          _: 'photo', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
          fileReference: new Uint8Array([id]), date: 1, dcId: 1,
          sizes: [{ _: 'photoSize', type: 'x', w: 10, h: 10, size: 4 }],
        }
      : undefined,
    rawDocument: kind === 'file'
      ? {
          _: 'document', id: Long.fromNumber(id), accessHash: Long.fromNumber(id),
          fileReference: new Uint8Array([id]), date: 1, dcId: 1, mimeType: 'application/pdf',
          size: 4, attributes: [],
        }
      : undefined,
  }
}

describe('rich message conversion', () => {
  it('keeps article order between text blocks and declared photos', async () => {
    const references: RichMediaReference[] = []
    const resolve = vi.fn(async (reference: RichMediaReference) => {
      references.push(reference)
      return resolved('image', reference.id.toNumber())
    })
    const input: tl.RawInputRichMessage = {
      _: 'inputRichMessage',
      blocks: [
        { _: 'pageBlockHeading1', text: { _: 'textPlain', text: 'Title' } },
        { _: 'pageBlockParagraph', text: { _: 'textBold', text: { _: 'textPlain', text: 'Lead' } } },
        photo(11, { _: 'textPlain', text: 'First picture' }),
        { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'After the picture' } },
        photo(12),
      ],
      photos: [inputPhoto(11), inputPhoto(12)],
    }

    const conversion = await convertRichMessage(input, resolve)
    expect(conversion).toBeDefined()
    expect(conversion!.parts.map((part) => part.type)).toEqual([
      'text', 'media', 'text', 'media',
    ])
    expect(conversion!.parts[0]).toMatchObject({ type: 'text' })
    expect((conversion!.parts[0] as { text: string }).text).toBe('Title\n\nLead')
    expect((conversion!.parts[2] as { text: string }).text).toBe('First picture\n\nAfter the picture')
    expect(conversion!.photos.map((item) => item.id.toNumber())).toEqual([11, 12])
    expect(references.map((item) => item.id.toNumber())).toEqual([11, 12])
    expect(references[0]!.input).toMatchObject({ _: 'inputPhoto' })
    expect(references[0]!.caption?.text).toBe('First picture')
    expect(conversion!.text).toContain('After the picture')
  })

  it('drops a media block the relay can no longer resolve but keeps its caption', async () => {
    const conversion = await convertRichMessage({
      _: 'inputRichMessage',
      blocks: [
        { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'Before' } },
        photo(21, { _: 'textPlain', text: 'Missing picture caption' }),
        { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'After' } },
      ],
      photos: [inputPhoto(21)],
    }, async () => undefined)

    expect(conversion!.parts).toHaveLength(1)
    expect(conversion!.parts[0]).toMatchObject({ type: 'text' })
    expect((conversion!.parts[0] as { text: string }).text)
      .toBe('Before\n\nMissing picture caption\n\nAfter')
    expect(conversion!.photos).toEqual([])
    expect(conversion!.documents).toEqual([])
    expect(conversion!.blocks.some((block) => block._ === 'pageBlockPhoto')).toBe(false)
  })

  it('reports an article with no usable content as empty', async () => {
    await expect(convertRichMessage(
      { _: 'inputRichMessage', blocks: [{ _: 'pageBlockDivider' }] },
      async () => undefined,
    )).resolves.toBeUndefined()
    await expect(convertRichMessage({ _: 'inputRichMessage', blocks: [] }, async () => undefined))
      .resolves.toBeUndefined()
  })

  it('renders document blocks with their declared input document', async () => {
    const references: RichMediaReference[] = []
    const conversion = await convertRichMessage({
      _: 'inputRichMessage',
      blocks: [
        { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'See attachment' } },
        {
          _: 'pageBlockDocument', documentId: Long.fromNumber(31),
          caption: { _: 'pageCaption', text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } },
        },
      ],
      documents: [{
        _: 'inputDocument', id: Long.fromNumber(31), accessHash: Long.fromNumber(31),
        fileReference: new Uint8Array([31]),
      }],
    }, async (reference) => {
      references.push(reference)
      return resolved('file', reference.id.toNumber())
    })

    expect(conversion!.parts.map((part) => part.type)).toEqual(['text', 'media'])
    expect(conversion!.documents).toHaveLength(1)
    expect(conversion!.blocks.at(-1)).toMatchObject({ _: 'pageBlockDocument' })
    expect(references[0]).toMatchObject({ kind: 'document' })
  })

  it('renders list, quote, code and table blocks as text', async () => {
    const conversion = await convertRichMessage({
      _: 'inputRichMessage',
      blocks: [
        {
          _: 'pageBlockList',
          items: [
            { _: 'pageListItemText', text: { _: 'textPlain', text: 'first' } },
            { _: 'pageListItemText', text: { _: 'textPlain', text: 'second' } },
          ],
        },
        {
          _: 'pageBlockOrderedList',
          items: [
            { _: 'pageListOrderedItemText', text: { _: 'textPlain', text: 'one' }, num: '1' },
          ],
        },
        {
          _: 'pageBlockBlockquote',
          text: { _: 'textPlain', text: 'quoted' },
          caption: { _: 'textPlain', text: 'source' },
        },
        {
          _: 'pageBlockPreformatted', language: 'ts',
          text: { _: 'textPlain', text: 'const a = 1' },
        },
        {
          _: 'pageBlockTable',
          title: { _: 'textEmpty' },
          rows: [
            { _: 'pageTableRow', cells: [
              { _: 'pageTableCell', text: { _: 'textPlain', text: 'a' }, header: true },
              { _: 'pageTableCell', text: { _: 'textPlain', text: 'b' } },
            ] },
          ],
        },
      ],
    }, async () => undefined)

    const text = (conversion!.parts[0] as { text: string }).text
    expect(text).toContain('first\nsecond')
    expect(text).toContain('1. one')
    expect(text).toContain('quoted\n\nsource')
    expect(text).toContain('const a = 1')
    expect(text).toContain('a | b')
  })
})

describe('rich text flattening', () => {
  it('maps nested formatting to Telegram entities with correct offsets', () => {
    const content = richTextContent({
      _: 'textConcat',
      texts: [
        { _: 'textPlain', text: 'a ' },
        { _: 'textBold', text: { _: 'textPlain', text: 'bold' } },
        { _: 'textItalic', text: { _: 'textPlain', text: ' it' } },
        { _: 'textFixed', text: { _: 'textPlain', text: ' code' } },
        { _: 'textUrl', text: { _: 'textPlain', text: ' link' }, url: 'https://example.com', webpageId: Long.ZERO },
      ],
    })

    expect(content).toEqual({
      text: 'a bold it code link',
      entities: [
        { _: 'messageEntityBold', offset: 2, length: 4 },
        { _: 'messageEntityItalic', offset: 6, length: 3 },
        { _: 'messageEntityCode', offset: 9, length: 5 },
        { _: 'messageEntityTextUrl', offset: 14, length: 5, url: 'https://example.com' },
      ],
    })
  })

  it('keeps mention names and custom emoji as entities', () => {
    const content = richTextContent({
      _: 'textConcat',
      texts: [
        { _: 'textMentionName', text: { _: 'textPlain', text: 'Bob' }, userId: 42 },
        { _: 'textPlain', text: ' and ' },
        { _: 'textCustomEmoji', documentId: Long.fromNumber(7), alt: '🙂' },
      ],
    })

    expect(content?.text).toBe('Bob and 🙂')
    expect(content?.entities).toEqual([
      { _: 'messageEntityMentionName', offset: 0, length: 3, userId: 42 },
      { _: 'messageEntityCustomEmoji', offset: 8, length: 2, documentId: Long.fromNumber(7) },
    ])
  })
})

describe('markdown and HTML articles', () => {
  it('parses markdown headings, lists, quotes and code fences', () => {
    const blocks = markdownBlocks([
      '# Title',
      '',
      'A paragraph with **bold** and `code`.',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '',
      '> quoted',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '[link](https://example.com)',
    ].join('\n'))

    expect(blocks.map((block) => block._)).toEqual([
      'pageBlockHeading1',
      'pageBlockParagraph',
      'pageBlockList',
      'pageBlockOrderedList',
      'pageBlockBlockquote',
      'pageBlockPreformatted',
      'pageBlockParagraph',
    ])
    const paragraph = blocks[1]! as tl.RawPageBlockParagraph
    const flattened = richTextContent(paragraph.text)
    expect(flattened?.text).toBe('A paragraph with bold and code.')
    expect(flattened?.entities.map((entity) => entity._))
      .toEqual(['messageEntityBold', 'messageEntityCode'])
    expect((blocks.at(-1) as tl.RawPageBlockParagraph).text)
      .toMatchObject({ _: 'textUrl', url: 'https://example.com' })
    expect((blocks[5] as tl.RawPageBlockPreformatted)).toMatchObject({ language: 'ts' })
  })

  it('places a referenced file in the body and appends the rest', async () => {
    const references: Array<{ id: number, input: string }> = []
    const conversion = await convertRichMessage({
      _: 'inputRichMessageMarkdown',
      markdown: 'Before\n\n![shot](7)\n\nAfter',
      files: [
        { _: 'inputRichFilePhoto', id: '7', photo: inputPhoto(7) },
        { _: 'inputRichFileDocument', id: '8', document: {
          _: 'inputDocument', id: Long.fromNumber(8), accessHash: Long.fromNumber(8),
          fileReference: new Uint8Array([8]),
        } },
      ],
    }, async (reference) => {
      references.push({ id: reference.id.toNumber(), input: reference.input?._ ?? 'none' })
      return resolved(reference.kind === 'photo' ? 'image' : 'file', 100 + references.length)
    })

    // Text bodies name files by an arbitrary key, so blocks refer to a private
    // placeholder id that the resolved media replaces.
    expect(conversion!.parts.map((part) => part.type)).toEqual(['text', 'media', 'text', 'media'])
    expect(references).toEqual([
      { id: -1, input: 'inputPhoto' },
      { id: -2, input: 'inputDocument' },
    ])
    expect(conversion!.blocks.filter((block) => block._ === 'pageBlockPhoto')
      .map((block) => (block as tl.RawPageBlockPhoto).photoId.toNumber())).toEqual([101])
    expect(conversion!.blocks.filter((block) => block._ === 'pageBlockDocument')
      .map((block) => (block as tl.RawPageBlockDocument).documentId.toNumber())).toEqual([102])
  })

  it('strips HTML tags into paragraphs and preformatted code', () => {
    const blocks = htmlBlocks('<h1>Title</h1><p>Body &amp; more</p><pre>let a = 1\nlet b = 2</pre>')
    expect(blocks.map((block) => block._)).toEqual([
      'pageBlockHeading1', 'pageBlockParagraph', 'pageBlockPreformatted',
    ])
    expect((blocks[1] as tl.RawPageBlockParagraph).text).toMatchObject({ text: 'Body & more' })
    expect((blocks[2] as tl.RawPageBlockPreformatted).text)
      .toMatchObject({ text: 'let a = 1\nlet b = 2' })
  })

  it('places an HTML image reference at its own position', async () => {
    const references: number[] = []
    const conversion = await convertRichMessage({
      _: 'inputRichMessageHTML',
      html: '<p>Before</p><img src="7"><p>After</p>',
      files: [{ _: 'inputRichFilePhoto', id: '7', photo: inputPhoto(7) }],
    }, async (reference) => {
      references.push(reference.id.toNumber())
      return resolved('image', reference.id.toNumber())
    })

    expect(conversion!.parts.map((part) => part.type)).toEqual(['text', 'media', 'text'])
    expect(references).toEqual([-1])
  })

  it('parses inline markdown markers without losing surrounding text', () => {
    expect(parseInlineMarkdown('a **b** c')).toEqual({
      text: 'a b c',
      entities: [{ _: 'messageEntityBold', offset: 2, length: 1 }],
    })
    expect(parseInlineMarkdown('one `two` three `four`')).toEqual({
      text: 'one two three four',
      entities: [
        { _: 'messageEntityCode', offset: 4, length: 3 },
        { _: 'messageEntityCode', offset: 14, length: 4 },
      ],
    })
  })
})
