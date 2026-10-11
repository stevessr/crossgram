// Test fixtures only; never imported by the production plugin.
import { Message, User, PeersIndex } from '@mtcute/node'
import { vi } from 'vitest'
import { Emitter } from '@fuman/utils'
import type { TelegramBackend } from './index.js'
const users = [{ _: 'user' as const, id: 42, firstName: 'Owner', self: true }, { _: 'user' as const, id: 77, firstName: 'Friend' }]
export function message(id = 10, text = 'hello') {
  return new Message({ _: 'message', id, peerId: { _: 'peerUser', userId: 77 },
    fromId: { _: 'peerUser', userId: 77 }, message: text, date: 1_800_000_000 }, PeersIndex.from({ users }))
}
export function backend() {
  const history = [message()]
  const client = {
    getMe: vi.fn(async () => new User(users[0])),
    getChat: vi.fn(async () => new User(users[1])),
    getHistory: vi.fn(async (_peer: unknown, _params: unknown) => history),
    sendText: vi.fn(async (_peer, text) => message(11, text)),
    call: vi.fn(async (_request: unknown) => ({ _: 'messages.dialogs', dialogs: [{ _: 'dialog', peer: { _: 'peerUser', userId: 77 }, topMessage: 10,
      readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 1, unreadMentionsCount: 0, unreadReactionsCount: 0,
      notifySettings: { _: 'peerNotifySettings' } }], messages: [message().raw], chats: [], users })),
    resolvePeer: vi.fn(async (id) => ({ _: 'inputPeerUser', userId: id, accessHash: 0 })),
    readHistory: vi.fn(async () => {}), startUpdatesLoop: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
    onNewMessage: new Emitter<Message>(), onEditMessage: new Emitter<Message>(),
  }
  return { client, adapterClient: client as unknown as TelegramBackend, history }
}
