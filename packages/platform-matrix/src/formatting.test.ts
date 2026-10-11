import { describe, expect, it } from 'vitest'
import { matrixMentionUserIds, matrixTextEntities, textContent } from './formatting.js'

describe('Matrix mention formatting', () => {
  it('keeps ordinary text and reply relations unchanged without mentions', () => {
    expect(textContent('hello <world>', '$reply')).toEqual({
      msgtype: 'm.text', body: 'hello <world>',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$reply' } },
    })
  })

  it('produces deduplicated notification targets and escaped Matrix HTML from UTF-16 offsets', () => {
    const text = '👋 @A<&"\' and @Bob and @A'
    const first = text.indexOf('@A')
    const second = text.indexOf('@Bob')
    const third = text.lastIndexOf('@A')
    const content = textContent(text, '$reply', [
      { type: 'mention', offset: third, length: 2, userId: '@alice:example.org' },
      { type: 'mention', offset: first, length: '@A<&"\''.length, userId: '@alice:example.org' },
      { type: 'mention', offset: second, length: 4, userId: '@bob:example.org' },
    ])
    expect(content.body).toBe(text)
    expect(content['m.mentions']).toEqual({ user_ids: ['@alice:example.org', '@bob:example.org'] })
    expect(content.formatted_body).toBe(
      '👋 <a href="https://matrix.to/#/%40alice%3Aexample.org">@A&lt;&amp;&quot;&#39;</a>'
      + ' and <a href="https://matrix.to/#/%40bob%3Aexample.org">@Bob</a>'
      + ' and <a href="https://matrix.to/#/%40alice%3Aexample.org">@A</a>',
    )
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$reply' } })
  })

  it('ignores invalid, overlapping, and non-Matrix mention targets', () => {
    expect(textContent('@one', undefined, [
      { type: 'mention', offset: 0, length: 4, userId: 'numeric-123' },
      { type: 'mention', offset: -1, length: 2, userId: '@ok:example.org' },
      { type: 'mention', offset: 0, length: 99, userId: '@ok:example.org' },
    ])).toEqual({ msgtype: 'm.text', body: '@one' })

    expect(textContent('@alice', undefined, [
      { type: 'mention', offset: 0, length: 6, userId: '@alice:example.org' },
      { type: 'mention', offset: 0, length: 3, userId: '@bob:example.org' },
    ])['m.mentions']).toEqual({ user_ids: ['@alice:example.org'] })
  })

  it('reads authoritative Matrix mentions with HTML links and plain MXIDs', () => {
    const text = '👋 @Alice / @bob:example.org'
    const content = {
      msgtype: 'm.text',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: '👋 <a href="https://matrix.to/#/%40alice%3Aexample.org">@Alice</a> / @bob:example.org',
      'm.mentions': { user_ids: ['@alice:example.org', '@bob:example.org'] },
    }
    expect(matrixTextEntities(content)).toEqual([
      { type: 'mention', offset: text.indexOf('@Alice'), length: 6, userId: '@alice:example.org' },
      { type: 'mention', offset: text.indexOf('@bob'), length: '@bob:example.org'.length, userId: '@bob:example.org' },
    ])
    expect(matrixMentionUserIds({ body: 'hello', 'm.mentions': {
      user_ids: ['@alice:example.org', '@alice:example.org', 'bad-id'],
    } })).toEqual(['@alice:example.org'])
  })

  it('does not infer notifications from unannotated plain @words or untrusted HTML links', () => {
    expect(matrixTextEntities({ msgtype: 'm.text', body: '@alice:example.org' })).toBeUndefined()
    expect(matrixTextEntities({
      msgtype: 'm.text',
      body: '@Alice',
      format: 'org.matrix.custom.html',
      formatted_body: '<a href="https://evil.example/#/%40alice%3Aexample.org">@Alice</a>',
      'm.mentions': { user_ids: ['@alice:example.org'] },
    })).toBeUndefined()
  })
})
