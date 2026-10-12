import type { Context } from 'cordis'
import z from 'schemastery'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialog, IMDialogPage,
  IMDownloadOptions, IMEvent, IMMedia, IMMessage, IMMessageInput, IMPageQuery, IMPlatform,
  IMPlatformAccount, IMRequest, IMRequestAction, IMRequestPage, IMRequestQuery, IMTransferOptions,
  IMUser, IMUserPage, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { IMMessageSendRejectedError, resolvePlatformPluginId } from '@mtproto-relay/bridge'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import { OneBotClient, type OneBotClientOptions } from './client.js'
import {
  conversationId, mapOneBotConversation, mapOneBotMessage, mapOneBotUser, oneBotId,
  parseConversationId, record, toOneBotSegments, type OneBotMediaLocator,
} from './protocol.js'

export interface Config {
  endpoint: string
  accessToken?: string
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  /** Test-only client injection; not exposed in the Cordis schema. */
  client?: OneBotClient
  /** Test-only socket factory. */
  socketFactory?: OneBotClientOptions['socketFactory']
}

export const Config = z.object({
  endpoint: z.string().required().default('ws://127.0.0.1:3001'),
  accessToken: z.string().role('secret'),
  requestTimeoutMs: z.natural().min(1).max(300_000).default(15_000),
  reconnectDelayMs: z.natural().min(100).max(30_000).default(1_000),
}).i18n({ 'en-US': enUS, 'zh-CN': zhCN })

export const name = 'im-platform-onebot'
export const inject = ['imPlatform']

export function apply(ctx: Context, config: Config): void {
  const id = resolvePlatformPluginId(ctx, 'onebot')
  const platform = new OneBotPlatform(config, (message) => ctx.logger('platform-onebot').warn('%s', message))
  ctx.imPlatform.register(platform, id)
  ctx.effect(() => () => platform.stop())
}

function numericId(id: string): number | string {
  const value = Number(id)
  return Number.isSafeInteger(value) && value >= 0 ? value : id
}

function pageBounds(query: IMPageQuery, items: readonly { id: string }[]): { start: number, end: number } {
  let start = 0
  if (query.cursor !== undefined) {
    const parsed = Number(query.cursor)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid OneBot page cursor')
    start = parsed
  } else if (query.afterId) {
    const index = items.findIndex((item) => item.id === query.afterId)
    if (index >= 0) start = index + 1
  }
  return { start, end: start + Math.max(1, Math.min(200, Math.trunc(query.limit ?? 100))) }
}

export class OneBotPlatform implements IMPlatform<OneBotMediaLocator> {
  readonly platformKind = 'onebot'
  readonly capabilities: PlatformCapabilities = {
    history: false, // Native OneBot 11 has no standard history-list API.
    readState: { markRead: false, events: false },
    send: { text: true, images: true, files: false, mixed: true, maxTextLength: 4_096, maxMedia: 4 },
    conversations: { groups: true, channels: false, subchannels: false },
    members: { list: true, administrators: true, permissions: false },
    avatars: { users: false, conversations: false },
    messageActions: {
      delete: { own: { supported: true }, others: { supported: true } },
      edit: { mode: 'unsupported' },
      forward: { mode: 'copy', preservesAuthor: false },
    },
  }

  readonly client: OneBotClient
  private selfId?: string
  private readonly conversations = new Map<string, IMConversation>()
  private readonly requests = new Map<string, IMRequest>()
  private dialogSnapshot?: { timestamp: number, items: IMDialog[] }

  constructor(config: Config, onWarning?: (message: string) => void) {
    this.client = config.client ?? new OneBotClient({
      endpoint: config.endpoint,
      accessToken: config.accessToken,
      requestTimeoutMs: config.requestTimeoutMs,
      reconnectDelayMs: config.reconnectDelayMs,
      socketFactory: config.socketFactory,
      onWarning,
    })
  }

  stop(): void {
    this.client.stop()
  }

  async getAccount(): Promise<IMPlatformAccount> {
    const info = record(await this.client.call('get_login_info'))
    const id = oneBotId(info.user_id)
    if (!id) throw new Error('OneBot get_login_info did not return user_id')
    this.selfId = id
    return { user: mapOneBotUser(info, id), credentials: {} }
  }

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent<OneBotMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    return this.client.subscribe((event) => {
      const mapped = this.mapEvent(event)
      if (mapped) return handler(mapped)
    })
  }

  mapEvent(event: Record<string, unknown>): IMEvent<OneBotMediaLocator> | undefined {
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      const kind = event.message_type
      if (kind !== 'private' && kind !== 'group') return
      const sender = record(event.sender)
      const id = oneBotId(kind === 'group' ? event.group_id : event.user_id)
      if (!id) return
      const key = conversationId(kind, id)
      const title = String(sender.card || sender.nickname || id)
      const conversation = this.conversations.get(key)
        ?? mapOneBotConversation(kind === 'group' ? { group_id: id } : { user_id: id }, kind, title)
      this.remember(conversation)
      const message = mapOneBotMessage(event, conversation, this.selfId)
      if (!message.id || !message.senderId) return
      return { type: 'message', conversation, message }
    }
    if (event.post_type === 'notice' && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
      const kind = event.notice_type === 'group_recall' ? 'group' : 'private'
      const id = oneBotId(kind === 'group' ? event.group_id : event.user_id)
      const messageId = oneBotId(event.message_id)
      if (!id || !messageId) return
      const conversation = this.conversations.get(conversationId(kind, id))
        ?? mapOneBotConversation(kind === 'group' ? { group_id: id } : { user_id: id }, kind)
      return {
        type: 'message-delete',
        eventId: `onebot:recall:${kind}:${id}:${messageId}`,
        conversation,
        messageIds: [messageId],
        timestamp: Number(event.time) || Math.trunc(Date.now() / 1000),
      }
    }
    if (event.post_type === 'request') {
      const kind = event.request_type
      if (kind !== 'friend' && kind !== 'group') return
      const flag = String(event.flag ?? '')
      const id = oneBotId(event.user_id)
      if (!flag || !id) return
      const requestId = `${kind}:${flag}`
      const groupId = oneBotId(event.group_id)
      const request: IMRequest = {
        id: requestId,
        kind: kind === 'friend' ? 'friend' : 'group-join',
        state: 'pending',
        requester: mapOneBotUser({ user_id: id }, id),
        ...(groupId ? { group: this.conversations.get(conversationId('group', groupId))
          ?? mapOneBotConversation({ group_id: groupId }, 'group') } : {}),
        message: String(event.comment ?? ''),
        createdAt: Number(event.time) || Math.trunc(Date.now() / 1000),
        metadata: { onebotFlag: flag, onebotSubType: String(event.sub_type ?? 'add') },
      }
      this.requests.set(requestId, request)
      if (this.requests.size > 2_048) this.requests.delete(this.requests.keys().next().value!)
      return { type: 'request', request }
    }
    return
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage> {
    if (!this.dialogSnapshot || Date.now() - this.dialogSnapshot.timestamp > 15_000) {
      const [friends, groups] = await Promise.all([
        this.client.call<unknown[]>('get_friend_list'),
        this.client.call<unknown[]>('get_group_list'),
      ])
      const items: IMDialog[] = []
      for (const friend of Array.isArray(friends) ? friends : []) {
        const conversation = mapOneBotConversation(friend, 'private')
        if (conversation.id === 'private:') continue
        this.remember(conversation)
        items.push({ conversation, unreadCount: 0 })
      }
      for (const group of Array.isArray(groups) ? groups : []) {
        const conversation = mapOneBotConversation(group, 'group')
        if (conversation.id === 'group:') continue
        this.remember(conversation)
        items.push({ conversation, unreadCount: 0 })
      }
      this.dialogSnapshot = { timestamp: Date.now(), items }
    }
    const items = this.dialogSnapshot.items
    const { start, end } = pageBounds(query, items.map((x) => ({ id: x.conversation.id })))
    return { dialogs: items.slice(start, end), total: items.length, nextCursor: end < items.length ? String(end) : undefined }
  }

  async getContacts(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMUserPage> {
    const friends = await this.client.call<unknown[]>('get_friend_list')
    const users = (Array.isArray(friends) ? friends : []).map((friend) => mapOneBotUser(friend))
      .filter((user) => user.id)
    const { start, end } = pageBounds(query, users)
    return { users: users.slice(start, end), nextCursor: end < users.length ? String(end) : undefined }
  }

  async getConversation(_session: PlatformSession, conversationId: string): Promise<IMConversation | null> {
    const target = parseConversationId(conversationId)
    if (target.kind === 'group') {
      const info = await this.client.call('get_group_info', { group_id: numericId(target.id), no_cache: false })
      return this.remember(mapOneBotConversation(info, 'group'))
    }
    const user = await this.client.call('get_stranger_info', { user_id: numericId(target.id), no_cache: false })
    return this.remember(mapOneBotConversation(user, 'private'))
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser | null> {
    const data = await this.client.call('get_stranger_info', { user_id: numericId(userId), no_cache: false })
    return mapOneBotUser(data, userId)
  }

  async getConversationMembers(
    _session: PlatformSession, conversation: IMConversationRef, query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage> {
    const target = parseConversationId(conversation.id)
    if (target.kind !== 'group') return { members: [], total: 0 }
    const data = await this.client.call<unknown[]>('get_group_member_list', { group_id: numericId(target.id) })
    const members: IMConversationMember[] = (Array.isArray(data) ? data : []).map((item) => {
      const member = record(item)
      const role = member.role === 'owner' ? 'owner' : member.role === 'admin' ? 'administrator' : 'member'
      return {
        user: mapOneBotUser(member),
        role,
        permissions: {
          manageConversation: role !== 'member',
          manageMembers: role !== 'member',
          deleteAnyMessage: role !== 'member',
          editAnyMessage: false,
          pinMessages: false,
          inviteMembers: role !== 'member',
        },
      }
    }).filter((member) => member.user.id)
    const { start, end } = pageBounds(query, members.map((m) => ({ id: m.user.id })))
    return { members: members.slice(start, end), total: members.length, nextCursor: end < members.length ? String(end) : undefined }
  }

  async getRequests(_session: PlatformSession, query: IMRequestQuery = {}): Promise<IMRequestPage> {
    const requests = [...this.requests.values()].filter((x) => !query.kind || x.kind === query.kind)
    const start = Number(query.cursor ?? 0)
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid OneBot request cursor')
    const end = start + Math.max(1, Math.min(200, query.limit ?? 100))
    return { requests: requests.slice(start, end), nextCursor: end < requests.length ? String(end) : undefined }
  }

  async resolveRequest(_session: PlatformSession, id: string, action: IMRequestAction): Promise<IMRequest> {
    const request = this.requests.get(id)
    if (!request || request.state !== 'pending') throw new Error(`Unknown pending OneBot request: ${id}`)
    const flag = String(request.metadata?.onebotFlag ?? '')
    const approve = action === 'accept'
    if (request.kind === 'friend') {
      await this.client.call('set_friend_add_request', { flag, approve })
    } else {
      await this.client.call('set_group_add_request', {
        flag, sub_type: request.metadata?.onebotSubType ?? 'add', approve,
      })
    }
    const updated = { ...request, state: (approve ? 'accepted' : 'rejected') as IMRequest['state'] }
    this.requests.set(id, updated)
    return updated
  }

  async getMessage(
    _session: PlatformSession, conversation: IMConversationRef, messageId: string,
  ): Promise<IMMessage<OneBotMediaLocator> | null> {
    const data = await this.client.call('get_msg', { message_id: numericId(messageId) })
    const target = this.conversations.get(conversation.id) ?? this.fallbackConversation(conversation.id)
    return mapOneBotMessage(data, target, this.selfId)
  }

  async sendMessage(
    _session: PlatformSession, conversation: IMConversationRef,
    content: IMMessageInput, options: IMTransferOptions = {},
  ): Promise<IMMessage<OneBotMediaLocator>> {
    const target = parseConversationId(conversation.id)
    let segments
    try {
      segments = await toOneBotSegments(content, options)
    } catch (error) {
      throw new IMMessageSendRejectedError('platform-rejected', String(error))
    }
    const data = record(await this.client.call(
      target.kind === 'group' ? 'send_group_msg' : 'send_private_msg',
      { [target.kind === 'group' ? 'group_id' : 'user_id']: numericId(target.id), message: segments },
    ))
    const id = oneBotId(data.message_id)
    if (!id) throw new Error('OneBot send action did not return message_id')
    const native = this.conversations.get(conversation.id) ?? this.fallbackConversation(conversation.id)
    try {
      const full = await this.getMessage(_session, conversation, id)
      if (full && full.id) return full
    } catch {
      // Some OneBot implementations disable get_msg; the send receipt is still authoritative.
    }
    return {
      id,
      conversationId: conversation.id,
      senderId: this.selfId ?? '',
      timestamp: Math.trunc(Date.now() / 1000),
      outgoing: true,
      content: {
        parts: content.parts.map((part) => part.type === 'text'
          ? { type: 'text' as const, text: part.text, entities: part.entities }
          : part.type === 'media'
            ? { type: 'media' as const, media: { id: `${id}:image`, kind: 'image' as const } }
            : { type: 'text' as const, text: '[sticker]' }),
      },
      metadata: { onebotMessageId: id, onebotConversationId: native.id },
    }
  }

  async deleteMessages(_session: PlatformSession, _conversation: IMConversationRef, ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.client.call('delete_msg', { message_id: numericId(id) })
  }

  async *downloadMedia(
    _session: PlatformSession, media: IMMedia<OneBotMediaLocator>, options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    let url = media.locator?.url
    if (!url && media.kind === 'image') {
      const image = record(await this.client.call('get_image', { file: media.id }))
      if (typeof image.url === 'string') url = image.url
    }
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('OneBot media has no HTTP(S) download URL')
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? Infinity : Math.max(0, Math.trunc(options.limit))
    if (!limit) return
    const response = await fetch(url, {
      signal: options.signal,
      headers: offset || Number.isFinite(limit)
        ? { Range: `bytes=${offset}-${Number.isFinite(limit) ? offset + limit - 1 : ''}` }
        : undefined,
    })
    if (!response.ok || !response.body) throw new Error(`OneBot media download failed: HTTP ${response.status}`)
    let skip = response.status === 206 ? 0 : offset
    let remaining = limit
    let transferredBytes = 0
    for await (const piece of response.body) {
      let bytes = piece
      if (skip) {
        const amount = Math.min(skip, bytes.length)
        bytes = bytes.subarray(amount)
        skip -= amount
      }
      if (!bytes.length) continue
      const chunk = bytes.subarray(0, Math.min(remaining, bytes.length))
      transferredBytes += chunk.length
      await options.onProgress?.({ phase: 'download', mediaIndex: 0, transferredBytes, totalBytes: media.size })
      yield chunk
      remaining -= chunk.length
      if (!remaining) break
    }
  }

  private fallbackConversation(id: string): IMConversation {
    const target = parseConversationId(id)
    return mapOneBotConversation(
      target.kind === 'group' ? { group_id: target.id } : { user_id: target.id },
      target.kind,
    )
  }

  private remember(conversation: IMConversation): IMConversation {
    this.conversations.delete(conversation.id)
    this.conversations.set(conversation.id, conversation)
    if (this.conversations.size > 4_096) this.conversations.delete(this.conversations.keys().next().value!)
    return conversation
  }
}

export { OneBotClient } from './client.js'
export {
  conversationId, parseConversationId, normalizeSegments, mapOneBotMessage, toOneBotSegments,
} from './protocol.js'
