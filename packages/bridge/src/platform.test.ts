import { describe, expect, it } from 'vitest'
import { messageMentionsUser, type IMMessage } from './platform.js'

describe('messageMentionsUser', () => {
  it('finds the addressed user across text parts without matching other entity types', () => {
    const message: IMMessage = {
      id: 'mention', conversationId: 'group', senderId: 'alice', timestamp: 1,
      content: { parts: [
        { type: 'text', text: 'hello' },
        {
          type: 'text', text: '@Current and @Other', entities: [
            { type: 'mention', offset: 0, length: 8, userId: 'self' },
            { type: 'bold', offset: 13, length: 6 },
            { type: 'mention', offset: 13, length: 6, userId: 'other' },
          ],
        },
      ] },
    }

    expect(messageMentionsUser(message, 'self')).toBe(true)
    expect(messageMentionsUser(message, 'other')).toBe(true)
    expect(messageMentionsUser(message, 'missing')).toBe(false)
  })

  it('honors authoritative Matrix notification targets even without a text range', () => {
    const message: IMMessage = {
      id: 'matrix-mention', conversationId: '!room:example.org',
      senderId: '@alice:example.org', timestamp: 1,
      content: { parts: [{ type: 'text', text: 'Hello everyone' }] },
      metadata: { matrixMentions: ['@me:example.org', '@bob:example.org'] },
    }
    expect(messageMentionsUser(message, '@me:example.org')).toBe(true)
    expect(messageMentionsUser(message, '@bob:example.org')).toBe(true)
    expect(messageMentionsUser(message, '@other:example.org')).toBe(false)
  })

  it('does not infer mentions from plain text alone', () => {
    const message: IMMessage = {
      id: 'plain', conversationId: 'group', senderId: 'alice', timestamp: 1,
      content: { parts: [{ type: 'text', text: '@self' }] },
    }

    expect(messageMentionsUser(message, 'self')).toBe(false)
  })
})
