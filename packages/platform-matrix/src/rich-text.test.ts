import { describe, expect, it } from 'vitest'
import { matrixFormattedText, textContent } from './formatting.js'
import { parseMatrixHtml, renderMatrixHtml } from './rich-text.js'
const parse = (html: string) => parseMatrixHtml(html, new Set())
describe('Matrix rich HTML to Telegram text entities', () => {
  it.each([['strong', 'bold'], ['b', 'bold'], ['em', 'italic'], ['i', 'italic'], ['u', 'underline'], ['del', 'strikethrough'], ['s', 'strikethrough'], ['code', 'code'], ['blockquote', 'blockquote'], ['h2', 'bold']])('maps %s with UTF-16 offsets', (tag, type) => {
    const result = parse(`<${tag}>😀text &amp; more</${tag}>`)
    expect(result.text).toBe('😀text & more')
    expect(result.entities).toEqual([{ type, offset: 0, length: 13 }])
  })
  it('uses rendered HTML instead of the markdown fallback and preserves nested ranges', () => {
    expect(matrixFormattedText({ body: '**😀bold _italic_**', format: 'org.matrix.custom.html', formatted_body: '<strong>😀bold <em>italic</em></strong>' })).toEqual({
      text: '😀bold italic', entities: [{ type: 'bold', offset: 0, length: 13 }, { type: 'italic', offset: 7, length: 6 }],
    })
  })
  it('retains code whitespace and language, lists, links and spoilers', () => {
    const result = parse('<ol start="3"><li>A</li><li>B</li></ol><pre><code class="language-typescript">  x\n y</code></pre><span data-mx-spoiler>secret</span> <a href="https://example.org/?a=1&amp;b=2">link</a>')
    expect(result.text).toBe('3. A\n4. B\n  x\n y\nsecret link')
    expect(result.entities).toEqual([
      { type: 'pre', offset: 10, length: 6, language: 'typescript' },
      { type: 'spoiler', offset: 17, length: 6 },
      { type: 'text-link', offset: 24, length: 4, url: 'https://example.org/?a=1&b=2' },
    ])
  })
  it('removes reply fallback, inactive content and unsafe links without losing visible labels', () => {
    expect(parse('<mx-reply><blockquote>old</blockquote></mx-reply><script>bad()</script><a href="javascript:bad()">safe</a><br><img alt="😀"><strong>end</strong>')).toEqual({ text: 'safe\n😀end', entities: [{ type: 'bold', offset: 7, length: 3 }] })
  })
  it('keeps explicit mentions on rendered offsets without inventing notifications', () => {
    const html = '😀 <b><a href="https://matrix.to/#/@alice:test">Alice</a></b>'
    expect(parseMatrixHtml(html, new Set(['@alice:test'])).entities).toEqual(expect.arrayContaining([
      { type: 'mention', offset: 3, length: 5, userId: '@alice:test' }, { type: 'bold', offset: 3, length: 5 },
    ]))
    expect(parse(html).entities.find(e => e.type === 'mention')).toBeUndefined()
  })
  it('does not reinterpret literal Markdown without formatted_body', () => {
    expect(matrixFormattedText({ body: '**literal**' })).toEqual({ text: '**literal**', entities: undefined })
  })
})
describe('Telegram entities to Matrix HTML', () => {
  it.each(['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'blockquote', 'spoiler'] as const)('roundtrips %s', type => {
    const body = '😀hello'
    const entities = [{ type, offset: 0, length: body.length }]
    const content = textContent(body, '$reply', entities)
    expect(matrixFormattedText(content)).toEqual({ text: body, entities })
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$reply' } })
  })
  it('splits crossing ranges into valid nested HTML and escapes visible text and attributes', () => {
    expect(renderMatrixHtml('abcde', [{ type: 'bold', offset: 0, length: 3 }, { type: 'italic', offset: 2, length: 3 }])).toBe('<strong>ab<em>c</em></strong><em>de</em>')
    expect(renderMatrixHtml('<x>\n&', [{ type: 'text-link', offset: 0, length: 3, url: 'https://example.org/?q="' }])).toBe('<a href="https://example.org/?q=&quot;">&lt;x&gt;</a><br>&amp;')
    expect(renderMatrixHtml('safe', [{ type: 'text-link', offset: 0, length: 4, url: 'javascript:bad()' }])).toBe('safe')
  })
  it('rejects invalid ranges without slicing text', () => {
    expect(textContent('hello', undefined, [{ type: 'bold', offset: -1, length: 5 }, { type: 'italic', offset: 0, length: 10 }])).toEqual({ msgtype: 'm.text', body: 'hello' })
  })
})
