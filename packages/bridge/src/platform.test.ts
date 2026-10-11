import { describe, expect, it } from 'vitest'
import { messageMentionsUser, messagePartText, type IMMessage } from './platform.js'
import { makeTlCardPreview } from './dialogs.js'

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

describe('Matrix content projection', () => {
  it('renders structured polls with the full ordered answer list in plain text', () => {
    expect(messagePartText({ type: 'poll', poll: {
      question: 'Tea or coffee?', kind: 'disclosed', maxSelections: 2,
      answers: [{ id: 'tea', text: 'Tea' }, { id: 'coffee', text: 'Coffee' }],
    } })).toBe('🗳️ Tea or coffee?\n1. Tea\n2. Coffee\n最多选择 2 项')
  })

  it('caps oversized poll fallback text for Telegram clients', () => {
    const rendered = messagePartText({ type: 'poll', poll: {
      question: 'Q'.repeat(10_000), maxSelections: 1, kind: 'disclosed',
      answers: [{ id: 'x', text: 'Yes' }],
    } })
    expect(rendered.length).toBeLessThanOrEqual(4_000)
  })

  it('shows only confirmed final counts on a closed poll', () => {
    const question = { type: 'poll' as const, poll: {
      question: 'Lunch?', kind: 'undisclosed' as const, maxSelections: 1,
      answers: [{ id: 'rice', text: 'Rice' }, { id: 'pasta', text: 'Pasta' }],
      counts: { rice: 3, pasta: 2 }, totalVoters: 5,
    } }
    expect(messagePartText(question)).not.toContain('票')
    const result = messagePartText({
      ...question, poll: { ...question.poll, closed: true },
    })
    expect(result).toContain('Rice — 3 票')
    expect(result).toContain('Pasta — 2 票')
    expect(result).toContain('投票已结束 · 5 人有效投票')
  })

  it('renders location cards as native Telegram geolocation media', () => {
    const card = {
      kind: 'location' as const, title: 'A place', latitude: -23.5, longitude: 140.2,
      url: 'https://www.openstreetmap.org/?mlat=-23.5&mlon=140.2',
    }
    expect(messagePartText({ type: 'card', card })).toBe('A place')
    expect(makeTlCardPreview(card)).toMatchObject({
      _: 'messageMediaGeo', geo: { _: 'geoPoint', lat: -23.5, long: 140.2 },
    })
    expect(makeTlCardPreview({ ...card, latitude: Number.NaN })._).toBe('messageMediaWebPage')
  })
})
