import { createHash } from 'node:crypto'
import type { Context } from 'cordis'
import { TelegramClient, Dialog, type Message, type Peer, type User } from '@mtcute/node'
import Long from 'long'
import z from 'schemastery'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import type {
  IMPlatform, PlatformCapabilities, PlatformSession, IMConversation, IMConversationRef,
  IMMessage, IMMessageInput, IMPageQuery, IMHistoryQuery, IMDialogPage, IMHistoryPage,
  IMEvent, IMTransferOptions, IMReadTarget,
} from '@mtproto-relay/bridge'
import { prepareStorage } from './storage.js'

export interface Config { apiId: number, apiHash: string, storage: string }
export const Config = z.object({
  apiId: z.natural().min(1).required(),
  apiHash: z.string().role('secret').required(),
  storage: z.string().required(),
})
export const name = 'im-platform-telegram'
export const inject = ['imPlatform']

export async function apply(ctx: Context, config: Config): Promise<void> {
  const storage = await prepareStorage(config.storage)
  const client = new TelegramClient({ ...config, storage, logLevel: 0 })
  const platform = new TelegramPlatform(client, (error) => ctx.logger.warn('Telegram delivery failed; retrying: %s', String(error)))
  ctx.effect(() => () => platform.stop())
  // Fail closed: daemon startup never sends login codes or prompts on stdin.
  await platform.getAccount()
  ctx.imPlatform.register(platform, resolvePlatformPluginId(ctx, 'telegram'))
}

export type TelegramBackend = Pick<TelegramClient,
  'getMe' | 'getChat' | 'getHistory' | 'sendText' | 'call' | 'resolvePeer' |
  'readHistory' | 'startUpdatesLoop' | 'destroy' | 'onNewMessage' | 'onEditMessage'>

/** Initial text-only adapter. Unsupported media is explicitly marked, never silently discarded. */
export class TelegramPlatform implements IMPlatform {
  readonly platformKind = 'telegram'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
    conversations: { groups: true, channels: true, subchannels: false },
    readState: { markRead: true, events: false },
  }
  private subscriptions = new Set<() => Promise<void>>()
  constructor(readonly client: TelegramBackend, private warn: (error: unknown) => void = () => {}) {}

  async getAccount() {
    const me = await this.client.getMe()
    if (me.isBot) throw new Error('Telegram adapter requires a user account, not a bot')
    return { user: mapUser(me), credentials: {} }
  }

  async getConversation(_session: PlatformSession, id: string): Promise<IMConversation> {
    return mapConversation(await this.client.getChat(peerId(id)))
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage> {
    const limit = pageLimit(query.limit)
    let cursor = query.cursor ? decodeCursor(query.cursor, 'dialogs') : undefined
    if (!cursor && query.afterId) {
      const peer = await this.client.resolvePeer(peerId(query.afterId))
      const anchorPage = await this.client.call({ _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer }] })
      const anchor = Dialog.parseTlDialogs(anchorPage)[0]
      if (!anchor?.lastMessage) throw new Error('Telegram dialog anchor has no latest message')
      cursor = { type: 'dialogs', peer: query.afterId, id: anchor.lastMessage.id, date: seconds(anchor.lastMessage.date) }
    }
    const offsetPeer = cursor ? await this.client.resolvePeer(peerId(cursor.peer!)) : { _: 'inputPeerEmpty' as const }
    // Exactly one upstream window, no iterDialogs traversal or process-local cursor tokens.
    const response = await this.client.call({
      _: 'messages.getDialogs', offsetDate: cursor?.date ?? 0, offsetId: cursor?.id ?? 0,
      offsetPeer, limit, hash: Long.ZERO, excludePinned: Boolean(cursor),
    })
    if (response._ === 'messages.dialogsNotModified') throw new Error('Unexpected dialogsNotModified')
    const dialogs = Dialog.parseTlDialogs(response, limit)
    const last = dialogs.at(-1)
    return {
      dialogs: dialogs.map((dialog) => ({
        conversation: mapConversation(dialog.peer), unreadCount: dialog.unreadCount,
        lastMessage: dialog.lastMessage ? mapMessage(dialog.lastMessage) : undefined,
      })),
      total: 'count' in response ? response.count : dialogs.length,
      nextCursor: dialogs.length === limit && last?.lastMessage
        ? encodeCursor({ type: 'dialogs', peer: String(last.peer.id), id: last.lastMessage.id, date: seconds(last.lastMessage.date) })
        : undefined,
    }
  }

  async getHistory(_session: PlatformSession, conversation: IMConversationRef, query: IMHistoryQuery = {}): Promise<IMHistoryPage> {
    const limit = pageLimit(query.limit)
    const cursor = query.cursor ? decodeCursor(query.cursor, 'history') : undefined
    if (cursor && cursor.peer !== conversation.id) throw new Error('History cursor belongs to another conversation')
    const anchor = query.after ?? query.before
    const offset = cursor ? { id: cursor.id, date: cursor.date }
      : anchor ? { id: messageId(anchor.id), date: Math.floor(anchor.timestamp / 1000) } : undefined
    const reverse = cursor?.reverse ?? Boolean(query.after)
    const response = await this.client.getHistory(peerId(conversation.id), {
      limit, offset, reverse, ...(query.after && !cursor ? { minId: messageId(query.after.id) } : {}),
    })
    const last = response.at(-1)
    return {
      messages: response.map(mapMessage),
      nextCursor: response.length === limit && last
        ? encodeCursor({ type: 'history', peer: conversation.id, id: last.id + (reverse ? 1 : 0), date: seconds(last.date), reverse })
        : undefined,
    }
  }

  async sendMessage(_session: PlatformSession, conversation: IMConversationRef, input: IMMessageInput, options?: IMTransferOptions): Promise<IMMessage> {
    options?.signal?.throwIfAborted()
    if (input.parts.some((part) => part.type !== 'text')) throw new Error('Telegram adapter currently supports text only')
    const text = input.parts.map((part) => part.type === 'text' ? part.text : '').join('')
    if (!text || text.length > 4096) throw new Error('Telegram text must contain 1..4096 UTF-16 code units')
    const sent = await this.client.sendText(peerId(conversation.id), text, {
      replyTo: input.replyToId ? messageId(input.replyToId) : undefined,
    })
    if (!sent.id) throw new Error('Telegram did not confirm a message ID')
    return mapMessage(sent)
  }

  async markRead(_session: PlatformSession, target: IMReadTarget): Promise<void> {
    await this.client.readHistory(peerId(target.conversationId), { maxId: messageId(target.messageId) })
  }

  async subscribe(_session: PlatformSession, handler: (event: IMEvent) => void | Promise<void>) {
    let closed = false
    // Keep one consumer promise rather than one promise/closure per queued
    // update. A burst of updates holds only event references until delivered.
    type QueuedUpdate = { message: Message, edit: boolean }
    const pending: Array<QueuedUpdate | undefined> = []
    let head = 0
    let draining: Promise<void> | undefined
    let cancelDelay: (() => void) | undefined
    const drain = async () => {
      while (!closed && head < pending.length) {
        const update = pending[head]!
        while (!closed) {
          try {
            const mapped = mapMessage(update.message)
            const conversation = mapConversation(update.message.chat)
            await handler(update.edit ? {
              type: 'message-edit', conversation, message: mapped,
              eventId: `${conversation.id}:${update.message.id}:${update.message.editDate?.getTime() ?? update.message.date.getTime()}:${createHash('sha256').update(JSON.stringify(mapped.content)).digest('hex')}`,
            } : { type: 'message', conversation, message: mapped })
            break
          } catch (error) {
            this.warn(error)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1000)
              cancelDelay = () => { clearTimeout(timer); resolve() }
            })
            cancelDelay = undefined
          }
        }
        if (closed) return
        // Release large upstream Message objects as soon as they are handled.
        pending[head++] = undefined
        if (head === pending.length) {
          pending.length = 0
          head = 0
        } else if (head >= 256 && head * 2 >= pending.length) {
          pending.splice(0, head)
          head = 0
        }
      }
    }
    const schedule = () => {
      if (draining) return
      draining = Promise.resolve().then(drain).finally(() => {
        draining = undefined
        if (!closed && head < pending.length) schedule()
      })
    }
    const enqueue = (message: Message, edit: boolean) => {
      if (closed) return
      pending.push({ message, edit })
      schedule()
    }
    const onNew = (message: Message) => enqueue(message, false)
    const onEdit = (message: Message) => enqueue(message, true)
    this.client.onNewMessage.add(onNew)
    this.client.onEditMessage.add(onEdit)
    const unsubscribe = async () => {
      closed = true
      cancelDelay?.()
      this.client.onNewMessage.remove(onNew)
      this.client.onEditMessage.remove(onEdit)
      this.subscriptions.delete(unsubscribe)
      // Pending events were not delivered before unsubscribe in the old
      // promise chain either; discard them without retaining every closure.
      pending.length = 0
      await draining
    }
    this.subscriptions.add(unsubscribe)
    try { await this.client.startUpdatesLoop() } catch (error) { await unsubscribe(); throw error }
    return unsubscribe
  }

  async stop(): Promise<void> {
    await Promise.all([...this.subscriptions].map((unsubscribe) => unsubscribe()))
    await this.client.destroy()
  }
}

export function mapUser(user: User) {
  return { id: String(user.id), firstName: user.firstName || user.displayName, lastName: user.lastName ?? undefined, username: user.username ?? undefined }
}
export function mapConversation(peer: Peer): IMConversation {
  return { id: String(peer.id), title: peer.displayName, kind: peer.type === 'user' ? 'direct' : peer.chatType === 'channel' ? 'channel' : 'group' }
}
export function mapMessage(message: Message): IMMessage {
  const sender = message.sender
  const text = message.text || (message.isService ? '[Telegram service message]' : '')
  const unsupported = message.media && message.media.type !== 'webpage' ? '\n[Telegram attachment: not supported yet]' : ''
  return {
    id: String(message.id), conversationId: String(message.chat.id), senderId: String(sender.id),
    sender: sender.type === 'user' ? mapUser(sender) : { id: String(sender.id), firstName: sender.displayName },
    content: { parts: [{ type: 'text', text: text + unsupported }] },
    timestamp: message.date.getTime(), outgoing: message.isOutgoing,
    replyToId: message.replyToMessage?.origin === 'same_chat' ? String(message.replyToMessage.id) : undefined,
  }
}
function peerId(value: string): number {
  if (!/^-?[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid Telegram peer ID')
  return Number(value)
}
function messageId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new Error('Invalid Telegram message ID')
  return Number(value)
}
function pageLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid page limit')
  return Math.min(value, 100)
}
function seconds(date: Date): number { return Math.floor(date.getTime() / 1000) }
interface Cursor { type: 'dialogs' | 'history', peer: string, id: number, date: number, reverse?: boolean }
function encodeCursor(cursor: Cursor): string { return JSON.stringify(cursor) }
function decodeCursor(value: string, type: Cursor['type']): Cursor {
  if (value.length > 512) throw new Error('Invalid Telegram cursor')
  let cursor: Cursor
  try { cursor = JSON.parse(value) } catch { throw new Error('Invalid Telegram cursor') }
  if (!cursor || cursor.type !== type || !Number.isSafeInteger(cursor.id) || cursor.id < 1 ||
    !Number.isSafeInteger(cursor.date) || cursor.date < 0 || typeof cursor.peer !== 'string' ||
    (cursor.reverse !== undefined && typeof cursor.reverse !== 'boolean')) throw new Error('Invalid Telegram cursor')
  peerId(cursor.peer)
  return cursor
}
