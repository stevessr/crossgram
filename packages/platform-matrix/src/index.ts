import type { Context } from 'cordis'
import z from 'schemastery'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import type {
  IMConversation, IMConversationMember, IMConversationMemberPage, IMConversationRef, IMDialog,
  IMDialogPage, IMDownloadOptions, IMEvent, IMHistoryPage, IMHistoryQuery, IMMedia,
  IMInlineKeyboardButton, IMMessage, IMMessageInput, IMMessageSearchPage, IMMessageSearchQuery, IMMessageTarget, IMPageQuery, IMPlatform, IMReadTarget,
  IMRequest, IMRequestAction, IMRequestPage, IMRequestQuery,
  IMReactionActorPage, IMReactionActorPageRequest, IMReactionContext, IMReactionDefinition, IMReactionTarget,
  IMStickerSendPlan, IMTransferOptions, IMUser, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import { resolvePlatformPluginId } from '@mtproto-relay/bridge'
import { MatrixClient, type MatrixClientOptions } from './client.js'
import { matrixMentionUserIds, matrixTextEntities, textContent } from './formatting.js'
import { countClosedMatrixPoll, type MatrixPollTally } from './poll-results.js'
import type {
  MatrixDirectAccountData, MatrixEvent, MatrixInvitedRoom, MatrixJoinedRoom, MatrixMediaLocator, MatrixRoomMemberContent,
  MatrixAnnotation, MatrixRoomMessageContent, MatrixSyncResponse,
} from './types.js'
import { isRecord } from './guards.js'

const STANDARD_REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🔥', '🎉', '👏', '🤔'] as const
const MAX_SELECTED_REACTIONS = 20

export interface Config {
  homeserver: string
  accessToken: string
  userId?: string
  /** HTTP(S) proxy used for Matrix Client-Server API and media requests. */
  proxy?: string
  syncTimeoutMs?: number
  requestTimeoutMs?: number
  /** Test-only HTTP transport injection. */
  fetch?: typeof globalThis.fetch
}

export const Config = z.object({
  homeserver: z.string().required(),
  accessToken: z.string().role('secret').required(),
  userId: z.string(),
  proxy: z.string().role('secret'),
  syncTimeoutMs: z.natural().min(1).default(30_000),
  requestTimeoutMs: z.natural().min(1).default(30_000),
}).i18n({
  'en-US': enUS,
  'zh-CN': zhCN,
})

export const name = 'im-platform-matrix'
export const inject = ['imPlatform']

export function apply(ctx: Context, config: Config): void {
  const id = resolvePlatformPluginId(ctx, 'matrix')
  const platform = new MatrixPlatform(config, ctx.logger('platform-matrix'))
  ctx.imPlatform.register(platform, id)
  ctx.effect(() => () => platform.stop())
}

export class MatrixPlatform implements IMPlatform<MatrixMediaLocator> {
  readonly platformKind = 'matrix'
  readonly capabilities: PlatformCapabilities = {
    history: true,
    search: true,
    readState: { markRead: true, events: true },
    send: {
      text: true,
      images: true,
      files: true,
      mixed: true,
      maxTextLength: 60_000,
      maxMedia: 10,
    },
    conversations: { groups: true, channels: true, subchannels: false },
    members: { list: true, administrators: true, permissions: true },
    avatars: { users: true, conversations: true },
    messageActions: {
      delete: { own: { supported: true }, others: { supported: true } },
      edit: { mode: 'native' },
      forward: { mode: 'unsupported', preservesAuthor: false },
    },
    stickers: { native: false, upload: true, formats: ['static', 'animated'] },
    reactions: { read: true, write: true, events: true, actorList: true, maxSelected: 20 },
  }

  readonly client: MatrixClient
  private readonly configuredUserId?: string
  private readonly syncTimeoutMs: number
  private readonly logger?: MatrixLogger
  private accountUserId?: string
  private readonly roomState = new Map<string, Map<string, MatrixEvent>>()
  private readonly conversations = new Map<string, IMConversation<MatrixMediaLocator>>()
  private readonly directRoomIds = new Set<string>()
  /** The live invitation index also authorizes accept/reject actions by opaque request ID. */
  private readonly pendingInvites = new Map<string, IMRequest<MatrixMediaLocator>>()
  /** A successful local action must not be undone by an old /sync snapshot. */
  private readonly locallyResolvedInvites = new Map<string, IMRequest<MatrixMediaLocator>>()
  private readonly resolvingInvites = new Set<string>()
  /** Freeze a paginated request listing: each page must refer to the same /sync snapshot. */
  private requestPageSnapshot?: IMRequest<MatrixMediaLocator>[]
  /** Poll closures observed in sync/history, scoped to the room to avoid cross-room event collisions. */
  private readonly closedPolls = new Set<string>()
  private readonly pollTallies = new Map<string, MatrixPollTally>()
  private readonly reactionEventTargets = new Map<string, string>()

  constructor(config: Config, logger?: MatrixLogger) {
    this.client = new MatrixClient(config satisfies MatrixClientOptions)
    this.configuredUserId = config.userId
    this.syncTimeoutMs = config.syncTimeoutMs ?? 30_000
    this.logger = logger
  }

  async stop(): Promise<void> {
    await this.client.close()
  }

  async getAccount() {
    const userId = await this.getAccountUserId()
    const profile = await this.client.getProfile(userId).catch(() => ({}))
    return {
      credentials: {},
      user: this.mapUser(userId, profile),
    }
  }

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent<MatrixMediaLocator>) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const userId = await this.getAccountUserId()
    const controller = new AbortController()
    const initial = await this.client.sync({ timeout: 0, fullState: true, signal: controller.signal })
    this.ingestAccountData(initial)
    for (const [roomId, room] of Object.entries(initial.rooms?.invite ?? {})) {
      const request = this.mapRoomInvite(roomId, room, userId)
      if (!request) continue
      const resolved = this.locallyResolvedInvites.get(roomId)
      if (resolved?.id === request.id) continue
      if (resolved) this.locallyResolvedInvites.delete(roomId)
      this.pendingInvites.set(roomId, request)
    }
    for (const [roomId, room] of Object.entries(initial.rooms?.join ?? {})) {
      this.ingestState(roomId, room.state?.events ?? [])
      this.updateConversation(roomId, room)
      for (const event of room.timeline?.events ?? []) {
        const relation = event.type === 'm.reaction' ? relationFromValue(event.content['m.relates_to']) : undefined
        if (event.event_id && relation?.rel_type === 'm.annotation' && relation.event_id) {
          this.rememberReaction(event.event_id, relation.event_id)
        }
      }
    }
    let since = initial.next_batch
    const running = (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await this.client.sync({
            since,
            timeout: this.syncTimeoutMs,
            signal: controller.signal,
          })
          await this.dispatchSync(response, userId, handler)
          // Only advance the token after the bridge has durably handled the batch.
          since = response.next_batch
        } catch (error) {
          if (controller.signal.aborted) return
          this.logger?.warn('Matrix sync failed: %s', formatError(error))
          await abortableDelay(1_000, controller.signal)
        }
      }
    })()
    return async () => {
      controller.abort()
      await running
    }
  }

  async getDialogs(_session: PlatformSession, query: IMPageQuery = {}): Promise<IMDialogPage<MatrixMediaLocator>> {
    await this.getAccountUserId()
    const response = await this.client.sync({ timeout: 0, fullState: true })
    this.ingestAccountData(response)
    const dialogs: IMDialog<MatrixMediaLocator>[] = []
    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      this.ingestState(roomId, room.state?.events ?? [])
      this.ingestPollClosures(roomId, room.timeline?.events ?? [])
      const conversation = this.updateConversation(roomId, room)
      const lastMessage = [...(room.timeline?.events ?? [])].reverse()
        .map((event) => this.mapTimelineMessage(roomId, event))
        .find((message): message is IMMessage<MatrixMediaLocator> => Boolean(message))
      dialogs.push({
        conversation,
        unreadCount: room.unread_notifications?.notification_count ?? 0,
        lastMessage,
      })
    }
    dialogs.sort((left, right) => (right.lastMessage?.timestamp ?? 0) - (left.lastMessage?.timestamp ?? 0))
    const start = pageStart(dialogs, query)
    const limit = clampLimit(query.limit)
    const page = dialogs.slice(start, start + limit)
    return {
      dialogs: page,
      total: dialogs.length,
      nextCursor: start + page.length < dialogs.length ? String(start + page.length) : undefined,
    }
  }

  async getRequests(
    _session: PlatformSession,
    query: IMRequestQuery = {},
  ): Promise<IMRequestPage<MatrixMediaLocator>> {
    if (query.kind && query.kind !== 'group-join') return { requests: [] }
    const start = requestPageStart(query.cursor)
    if (!query.cursor || !this.requestPageSnapshot) {
      const userId = await this.getAccountUserId()
      const snapshot = await this.client.sync({ timeout: 0, fullState: true })
      const requests: IMRequest<MatrixMediaLocator>[] = []
      const seen = new Set<string>()
      for (const [roomId, room] of Object.entries(snapshot.rooms?.invite ?? {})) {
        const request = this.mapRoomInvite(roomId, room, userId)
        if (!request) continue
        seen.add(roomId)
        const locallyResolved = this.locallyResolvedInvites.get(roomId)
        if (locallyResolved && locallyResolved.id === request.id) {
          // An upstream snapshot may temporarily lag a successful join/leave.
          requests.push(locallyResolved)
          continue
        }
        if (locallyResolved) {
          // A newer invitation replaced an already handled one before its
          // terminal result could be recovered by the bridge.
          requests.push(locallyResolved)
          this.locallyResolvedInvites.delete(roomId)
        }
        const previous = this.pendingInvites.get(roomId)
        if (previous && previous.id !== request.id) {
          requests.push({ ...previous, state: 'rejected' })
        }
        requests.push(request)
        this.pendingInvites.set(roomId, request)
      }
      // A fresh full_state sync is an authoritative list of outstanding
      // invitations; emit terminal states for invites no longer present.
      for (const [roomId, request] of this.pendingInvites) {
        if (seen.has(roomId)) continue
        requests.push({
          ...request,
          state: snapshot.rooms?.join?.[roomId] ? 'accepted' : 'rejected',
        })
        this.pendingInvites.delete(roomId)
      }
      for (const [roomId, resolved] of this.locallyResolvedInvites) {
        if (seen.has(roomId)) continue
        // Reconcile the terminal state once even if an out-of-band /sync
        // snapshot has already removed the invite. The bridge may not have
        // persisted the preceding inline button callback yet.
        requests.push(resolved)
        this.locallyResolvedInvites.delete(roomId)
      }
      requests.sort((a, b) =>
        Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0) || a.id.localeCompare(b.id))
      this.requestPageSnapshot = requests
    }
    const requests = this.requestPageSnapshot
    const limit = clampLimit(query.limit)
    const page = requests.slice(start, start + limit)
    return {
      requests: page,
      nextCursor: start + page.length < requests.length ? String(start + page.length) : undefined,
    }
  }

  async resolveRequest(
    _session: PlatformSession,
    id: string,
    action: IMRequestAction,
  ): Promise<IMRequest<MatrixMediaLocator>> {
    const pending = [...this.pendingInvites.values()].find((request) => request.id === id)
    if (!pending) {
      // A remote join/leave can succeed before the bridge persists the
      // terminal inbox update. Allow the same callback to retry without
      // issuing a second remote operation.
      const resolved = [...this.locallyResolvedInvites.values()].find((request) => request.id === id)
      if (resolved && resolved.state === (action === 'accept' ? 'accepted' : 'rejected')) return resolved
      throw new Error(`Unknown or no longer pending Matrix room invitation: ${id}`)
    }
    const roomId = pending.group!.id
    if (this.resolvingInvites.has(roomId)) {
      throw new Error(`Matrix room invitation resolution is already in progress: ${roomId}`)
    }
    this.resolvingInvites.add(roomId)
    try {
      if (action === 'accept') {
        await this.client.joinRoom(roomId)
      } else {
        await this.client.leaveRoom(roomId)
      }
      const resolved: IMRequest<MatrixMediaLocator> = {
        ...pending, state: action === 'accept' ? 'accepted' : 'rejected',
      }
      // A concurrent sync may already have replaced the room's invitation.
      // Never delete a distinct newer invitation when this action completes.
      if (this.pendingInvites.get(roomId)?.id === id) this.pendingInvites.delete(roomId)
      this.locallyResolvedInvites.set(roomId, resolved)
      // Keep the current paginated view stable even when an inline callback
      // resolves one of its entries between two request-list pages.
      this.requestPageSnapshot = this.requestPageSnapshot?.map((request) =>
        request.id === id ? resolved : request)
      return resolved
    } finally {
      this.resolvingInvites.delete(roomId)
    }
  }

  async getHistory(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMHistoryQuery = {},
  ): Promise<IMHistoryPage<MatrixMediaLocator>> {
    let from = query.cursor
    if (!from && (query.before?.id || query.after?.id)) {
      const context = await this.client.getEventContext(conversation.id, query.before?.id ?? query.after!.id)
      from = query.after ? context.end : context.start
    }
    const response = await this.client.getMessages(conversation.id, {
      from,
      dir: query.after ? 'f' : 'b',
      limit: clampLimit(query.limit),
    })
    this.ingestState(conversation.id, response.state ?? [])
    this.ingestPollClosures(conversation.id, response.chunk)
    // Only a few closed polls per page are expanded; never fetch relations
    // for every message in a long history request.
    await Promise.all(response.chunk.filter((event) => isMatrixPollStart(event.type)
      && event.event_id && this.closedPolls.has(`${conversation.id}\0${event.event_id}`))
      .slice(0, 3).map(async (event) => {
        const pollPart = matrixPollParts(event.content).find((part) => part.type === 'poll')
        if (pollPart?.type !== 'poll') return
        await this.loadPollTally(conversation.id, event.event_id!, pollPart.poll).catch(() => undefined)
      }))
    return {
      messages: response.chunk.flatMap((event) => {
        const message = this.mapTimelineMessage(conversation.id, event)
        return message ? [message] : []
      }),
      nextCursor: response.end,
    }
  }

  async searchMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMMessageSearchQuery,
  ): Promise<IMMessageSearchPage<MatrixMediaLocator>> {
    const limit = clampLimit(query.limit)
    if (!limit || (query.minTimestamp !== undefined && query.maxTimestamp !== undefined
      && query.minTimestamp > query.maxTimestamp)) return { messages: [] }

    const term = query.query.trim()
    // Telegram can search with an empty term and a filter that the generic
    // bridge query does not encode (e.g. links or combined photos/videos).
    // Scan room history for *all* empty-term queries and let the bridge apply
    // the remaining Telegram-native filters to the projected messages.
    // Matrix /search requires a non-empty search_term.

    const messages: IMMessage<MatrixMediaLocator>[] = []
    const seen = new Set<string>()
    let cursor = query.cursor
    let nextCursor: string | undefined
    let total: number | undefined

    // Time and m.msgtype are not standard Matrix search filters. Consume a
    // bounded number of upstream pages to fill the requested page after local
    // filtering, without dropping matches between opaque pagination tokens.
    for (let pageNumber = 0; pageNumber < 10 && messages.length < limit; pageNumber++) {
      const pageLimit = Math.min(100, limit - messages.length)
      let events: MatrixEvent[]
      if (term) {
        const response = await this.client.searchRoomEvents({
          searchTerm: term,
          roomId: conversation.id,
          fromUserId: query.fromUserId,
          limit: pageLimit,
          nextBatch: cursor,
        })
        const roomEvents = response.search_categories?.room_events
        events = (roomEvents?.results ?? []).map((item) => item.result)
        nextCursor = roomEvents?.next_batch
        // The server count includes matches excluded by local media/time
        // filters, so it is only meaningful when those filters are absent.
        if (query.mediaKind === undefined && query.minTimestamp === undefined
          && query.maxTimestamp === undefined) total = roomEvents?.count
      } else {
        const response = await this.client.getMessages(conversation.id, {
          from: cursor,
          dir: 'b',
          limit: pageLimit,
          filter: {
            types: ['m.room.message'],
            ...(query.fromUserId ? { senders: [query.fromUserId] } : {}),
          },
        })
        this.ingestState(conversation.id, response.state ?? [])
        events = response.chunk
        nextCursor = response.end
      }

      for (const event of events) {
        // Verify scope locally even though the homeserver received the filter.
        if (event.type !== 'm.room.message' || (event.room_id && event.room_id !== conversation.id)
          || (query.fromUserId && event.sender !== query.fromUserId)) continue
        // A missing timestamp must not pass a requested date filter by using
        // the normal timeline mapper's current-time fallback.
        if ((query.minTimestamp !== undefined || query.maxTimestamp !== undefined)
          && event.origin_server_ts === undefined) continue
        const message = this.mapTimelineMessage(conversation.id, event)
        if (!message || seen.has(message.id)) continue
        if ((query.minTimestamp !== undefined && message.timestamp < query.minTimestamp)
          || (query.maxTimestamp !== undefined && message.timestamp > query.maxTimestamp)) continue
        if (query.mediaKind && !message.content.parts.some((part) =>
          part.type === 'media' && part.media.kind === query.mediaKind)) continue
        seen.add(message.id)
        messages.push(message)
      }

      // A non-advancing token would make the bridge replay the same page up
      // to 100 times. Treat a stalled cursor as exhausted instead.
      if (nextCursor === cursor) {
        nextCursor = undefined
        break
      }
      if (!nextCursor || messages.length >= limit) break
      cursor = nextCursor
    }
    return {
      messages,
      nextCursor,
      ...(total === undefined ? {} : { total }),
    }
  }

  async getMessage(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageId: string,
  ): Promise<IMMessage<MatrixMediaLocator> | null> {
    const event = await this.client.getEvent(conversation.id, messageId)
    return this.mapTimelineMessage(conversation.id, event) ?? null
  }

  async sendMessage(
    session: PlatformSession,
    conversation: IMConversationRef,
    content: IMMessageInput,
    options: IMTransferOptions = {},
  ): Promise<IMMessage<MatrixMediaLocator>> {
    const sourceIds: string[] = []
    const parts: IMMessage<MatrixMediaLocator>['content']['parts'] = []
    for (let index = 0; index < content.parts.length; index++) {
      const part = content.parts[index]!
      if (part.type === 'text') {
        const matrixContent = textContent(part.text, content.replyToId, part.entities)
        sourceIds.push(await this.client.sendEvent(conversation.id, 'm.room.message', matrixContent))
        parts.push({ type: 'text', text: part.text, entities: part.entities })
      } else if (part.type === 'media') {
        let transferredBytes = 0
        const mxc = await this.client.upload(part.media.source.stream({ signal: options.signal }), {
          filename: part.media.name,
          contentType: part.media.mimeType,
          signal: options.signal,
          onChunk: async (size) => {
            transferredBytes += size
            await options.onProgress?.({
              phase: 'upload', mediaIndex: index, transferredBytes, totalBytes: part.media.source.size,
            })
          },
        })
        const matrixContent = mediaContent(part.media, mxc, content.replyToId)
        sourceIds.push(await this.client.sendEvent(conversation.id, 'm.room.message', matrixContent))
        parts.push({
          type: 'media',
          media: {
            id: mxc,
            kind: part.media.kind,
            name: part.media.name,
            mimeType: part.media.mimeType,
            size: part.media.size ?? part.media.source.size,
            width: part.media.width,
            height: part.media.height,
            duration: part.media.duration,
            strippedThumbnail: part.media.strippedThumbnail,
            locator: { mxc },
          },
        })
      } else {
        const sticker = part.sticker
        if (sticker.type !== 'upload') throw new Error('Matrix cannot send native sticker references')
        if (sticker.format === 'video') throw new Error('Matrix sticker events do not support video stickers')
        let transferredBytes = 0
        const mxc = await this.client.upload(sticker.source.stream({ signal: options.signal }), {
          filename: `${sticker.stickerId}.${mediaExtension(sticker.mimeType)}`,
          contentType: sticker.mimeType,
          signal: options.signal,
          onChunk: async (size) => {
            transferredBytes += size
            await options.onProgress?.({ phase: 'upload', mediaIndex: index, transferredBytes, totalBytes: sticker.source.size })
          },
        })
        sourceIds.push(await this.client.sendEvent(conversation.id, 'm.sticker', stickerContent(sticker, mxc, content.replyToId)))
        parts.push({ type: 'media', media: {
          id: mxc, kind: sticker.mimeType.startsWith('image/') ? 'image' : 'file',
          name: `${sticker.stickerId}.${mediaExtension(sticker.mimeType)}`, mimeType: sticker.mimeType,
          size: sticker.source.size, width: sticker.width, height: sticker.height, locator: { mxc },
        } })
      }
    }
    if (!sourceIds.length) throw new Error('Matrix cannot send an empty message')
    return {
      id: sourceIds[0]!,
      sourceIds,
      conversationId: conversation.id,
      senderId: session.userId,
      content: { parts },
      timestamp: Math.floor(Date.now() / 1000),
      outgoing: true,
      replyToId: content.replyToId,
    }
  }

  /**
   * Telegram's ordinary poll RPC is intentionally not advertised. Single-choice
   * Matrix polls use the bridge's callback keyboard instead, with native
   * MSC3381 response events sent under the current Matrix account.
   */
  async clickInlineButton(
    _session: PlatformSession,
    target: { conversationId: string, messageId: string },
    button: Extract<IMInlineKeyboardButton, { type: 'callback' }>,
  ): Promise<{ message?: string, alert?: boolean }> {
    const match = /^matrix-poll-vote:(0|[1-9]\d?)$/.exec(button.data)
    if (!match) return { message: '无效的投票选项', alert: true }
    const start = await this.client.getEvent(target.conversationId, target.messageId)
    if (!isMatrixPollStart(start.type) || start.unsigned?.redacted_because) {
      return { message: '投票不存在或已经撤回', alert: true }
    }
    const part = matrixPollParts(start.content).find((part) => part.type === 'poll')
    if (part?.type !== 'poll' || part.poll.maxSelections !== 1) {
      return { message: '此投票不支持单选快捷提交', alert: true }
    }
    const option = part.poll.answers[Number(match[1])]
    if (!option) return { message: '投票选项已失效', alert: true }
    const pollKey = `${target.conversationId}\0${target.messageId}`
    // Matrix does not reject late votes automatically. Fail closed when the
    // relation list is incomplete or the homeserver cannot verify closure.
    const seen = new Set<string>()
    let from: string | undefined
    let exhausted = false
    for (let page = 0; page < 100; page++) {
      const relations = await this.client.getRelations(target.conversationId, target.messageId, {
        from, limit: 100,
      }).catch(() => undefined)
      if (!relations || !Array.isArray(relations.chunk)) {
        return { message: '无法验证 Matrix 投票状态，请稍后重试', alert: true }
      }
      if (relations.chunk.some((event) =>
        isMatrixPollEnd(event.type) && !event.unsigned?.redacted_because
        && matrixReference(event.content) === target.messageId)) {
        this.rememberPollClosure(pollKey)
        return { message: '投票已经结束', alert: true }
      }
      if (!relations.next_batch) {
        exhausted = true
        break
      }
      if (seen.has(relations.next_batch)) break
      seen.add(relations.next_batch)
      from = relations.next_batch
    }
    if (!exhausted) return { message: '暂时无法确认投票状态，请稍后重试', alert: true }
    // A previously observed end event may have been redacted since the last
    // sync. Treat the server's current relations as authoritative.
    this.closedPolls.delete(pollKey)

    const unstable = start.type === 'org.matrix.msc3381.poll.start'
    await this.client.sendEvent(target.conversationId,
      unstable ? 'org.matrix.msc3381.poll.response' : 'm.poll.response', {
        'm.relates_to': { rel_type: 'm.reference', event_id: target.messageId },
        ...(unstable
          ? { 'org.matrix.msc3381.poll.response': { answers: [option.id] } }
          : { 'm.selections': [option.id], 'm.poll.response': { answers: [option.id] } }),
      })
    return { message: '投票已提交，可再次选择修改投票' }
  }

  /** Collect every relation page before publishing counts: a partial page is misleading. */
  private async loadPollTally(
    roomId: string,
    pollId: string,
    poll: import('@mtproto-relay/bridge').IMMessagePoll,
  ): Promise<void> {
    const key = `${roomId}\0${pollId}`
    const relations: MatrixEvent[] = []
    const seen = new Set<string>()
    let from: string | undefined
    let exhausted = false
    for (let page = 0; page < 100; page++) {
      const response = await this.client.getRelations(roomId, pollId, { from, limit: 100 })
      if (!Array.isArray(response.chunk)) return
      relations.push(...response.chunk)
      if (!response.next_batch) {
        exhausted = true
        break
      }
      if (seen.has(response.next_batch)) break
      seen.add(response.next_batch)
      from = response.next_batch
    }
    if (!exhausted) return
    const tally = countClosedMatrixPoll(pollId, poll, relations)
    if (!tally) return
    this.pollTallies.delete(key)
    this.pollTallies.set(key, tally)
    if (this.pollTallies.size > 2_000) {
      const oldest = this.pollTallies.keys().next().value
      if (oldest !== undefined) this.pollTallies.delete(oldest)
    }
  }

  private rememberPollClosure(key: string): void {
    this.closedPolls.add(key)
    if (this.closedPolls.size > 2_000) {
      const oldest = this.closedPolls.values().next().value
      if (oldest !== undefined) this.closedPolls.delete(oldest)
    }
  }

  async editMessage(
    session: PlatformSession,
    target: IMMessageTarget,
    content: IMMessageInput,
  ): Promise<IMMessage<MatrixMediaLocator>> {
    if (content.parts.length !== 1 || content.parts[0]?.type !== 'text') {
      throw new Error('Matrix edits currently support exactly one text part')
    }
    const text = content.parts[0]
    const originalEvent = await this.client.getEvent(target.conversationId, target.targetId)
    if (originalEvent.type !== 'm.room.message') throw new Error(`Matrix cannot edit event type ${originalEvent.type}`)
    const raw = matrixRoomMessageContent(originalEvent.content)
    const original = raw['m.new_content'] ?? raw
    const originalReplyTo = (original['m.relates_to'] ?? raw['m.relates_to'])?.['m.in_reply_to']?.event_id
    const newContent = formattedContent(original, text.text, text.entities)
    if (originalReplyTo) newContent['m.relates_to'] = { 'm.in_reply_to': { event_id: originalReplyTo } }
    const fallback = formattedContent(newContent, `* ${text.text}`, text.entities?.map((entity) => ({ ...entity, offset: entity.offset + 2 })))
    const replacement: MatrixRoomMessageContent = {
      ...fallback,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: target.targetId },
    }
    await this.client.sendEvent(target.conversationId, 'm.room.message', replacement)
    return {
      id: target.messageId,
      sourceIds: [target.targetId],
      conversationId: target.conversationId,
      senderId: session.userId,
      timestamp: Math.floor(Date.now() / 1000),
      outgoing: true,
      replyToId: originalReplyTo,
      content: { parts: matrixMessageParts(newContent) },
    }
  }

  async deleteMessages(
    _session: PlatformSession,
    conversation: IMConversationRef,
    messageIds: readonly string[],
  ): Promise<void> {
    await Promise.all([...new Set(messageIds)].map((eventId) => this.client.redactEvent(conversation.id, eventId)))
  }

  async markRead(_session: PlatformSession, target: IMReadTarget): Promise<void> {
    await this.client.markRead(target.conversationId, target.messageId)
  }

  async getAvailableReactions(_session: PlatformSession, target: IMReactionTarget): Promise<IMReactionContext> {
    const userId = await this.getAccountUserId()
    if (!target.targetId && !target.messageId) return reactionContext([], userId)
    return reactionContext(await this.loadReactionEvents(target.conversationId, target.targetId ?? target.messageId!), userId)
  }

  async getMessageReactions(_session: PlatformSession, target: IMMessageTarget): Promise<IMReactionContext> {
    const userId = await this.getAccountUserId()
    return reactionContext(await this.loadReactionEvents(target.conversationId, target.targetId), userId)
  }

  async setMessageReactions(session: PlatformSession, target: IMMessageTarget, reactionKeys: readonly string[]): Promise<IMReactionContext> {
    const userId = await this.getAccountUserId()
    if (reactionKeys.length > MAX_SELECTED_REACTIONS) throw new Error(`Matrix supports at most ${MAX_SELECTED_REACTIONS} selected reactions`)
    const requested = new Set(reactionKeys)
    if ([...requested].some((key) => !reactionDefinition(key))) throw new Error('Matrix reactions must be emoji keys')
    const existing = await this.loadReactionEvents(target.conversationId, target.targetId)
    const selected = new Set<string>()
    for (const event of existing) {
      const relation = relationFromValue(event.content['m.relates_to'])
      if (event.sender !== userId || relation?.rel_type !== 'm.annotation' || !relation.key) continue
      if (requested.has(relation.key) && !selected.has(relation.key)) selected.add(relation.key)
      else if (event.event_id) await this.client.redactEvent(target.conversationId, event.event_id)
    }
    for (const key of requested) if (!selected.has(key)) await this.client.sendEvent(target.conversationId, 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: target.targetId, key },
    })
    return this.getMessageReactions(session, target)
  }

  async getMessageReactionActors(_session: PlatformSession, target: IMMessageTarget, request: IMReactionActorPageRequest): Promise<IMReactionActorPage> {
    const userId = await this.getAccountUserId()
    const events = await this.loadReactionEvents(target.conversationId, target.targetId)
    const actors = events.flatMap((event) => {
      const relation = relationFromValue(event.content['m.relates_to'])
      if (!event.sender || relation?.rel_type !== 'm.annotation' || !relation.key || (request.reactionKey && request.reactionKey !== relation.key)) return []
      return [{ reactionKey: relation.key, actor: { userId: event.sender, timestamp: matrixTimestamp(event) } }]
    }).sort((a, b) => (b.actor.timestamp ?? 0) - (a.actor.timestamp ?? 0))
    const offset = request.offset === undefined ? 0 : Number(request.offset)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid Matrix reaction offset: ${request.offset}`)
    const limit = Math.max(0, Math.min(Math.trunc(request.limit), 1_000))
    const page = actors.slice(offset, offset + limit)
    return { context: reactionContext(events, userId), actors: page, nextOffset: offset + page.length < actors.length ? String(offset + page.length) : undefined }
  }

  private async loadReactionEvents(roomId: string, targetId: string): Promise<MatrixEvent[]> {
    const events: MatrixEvent[] = [], cursors = new Set<string>()
    let from: string | undefined
    do {
      const page = await this.client.getRelations(roomId, targetId, 'm.annotation', { from, limit: 100 })
      for (const event of page.chunk) {
        if (event.type !== 'm.reaction' || event.unsigned?.redacted_because) continue
        const relation = relationFromValue(event.content['m.relates_to'])
        if (relation?.rel_type === 'm.annotation' && relation.event_id === targetId && relation.key) {
          events.push(event)
          if (event.event_id) this.rememberReaction(event.event_id, targetId)
        }
      }
      if (!page.next_batch || cursors.has(page.next_batch)) break
      from = page.next_batch
      cursors.add(from)
    } while (true)
    return events
  }

  async getUser(_session: PlatformSession, userId: string): Promise<IMUser<MatrixMediaLocator> | null> {
    const profile = await this.client.getProfile(userId).catch(() => null)
    return profile ? this.mapUser(userId, profile) : null
  }

  async getConversationMembers(
    _session: PlatformSession,
    conversation: IMConversationRef,
    query: IMPageQuery = {},
  ): Promise<IMConversationMemberPage<MatrixMediaLocator>> {
    if (!this.roomState.has(conversation.id)) {
      this.ingestState(conversation.id, await this.client.getRoomState(conversation.id))
    }
    const response = await this.client.getMembers(conversation.id)
    const members = response.chunk
      .filter((event) => event.state_key && event.content.membership === 'join')
      .map((event) => this.mapMember(event.state_key!, event.content, conversation.id))
      .sort((left, right) => left.user.id.localeCompare(right.user.id))
    const start = pageStart(members.map((member) => ({ conversation: { id: member.user.id } })), query)
    const page = members.slice(start, start + clampLimit(query.limit))
    return {
      members: page,
      total: members.length,
      nextCursor: start + page.length < members.length ? String(start + page.length) : undefined,
    }
  }

  async getConversationMember(
    session: PlatformSession,
    conversation: IMConversationRef,
    userId: string,
  ): Promise<IMConversationMember<MatrixMediaLocator> | null> {
    const page = await this.getConversationMembers(session, conversation, { limit: 1_000 })
    return page.members.find((member) => member.user.id === userId) ?? null
  }

  async *downloadMedia(
    _session: PlatformSession,
    media: IMMedia<MatrixMediaLocator>,
    options: IMDownloadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const mxc = media.locator?.mxc
    if (!mxc) throw new Error(`Matrix media has no content URI: ${media.id}`)
    const response = await this.client.download(mxc, { signal: options.signal })
    if (!response.body) throw new Error(`Matrix media response has no body: ${mxc}`)
    let skipped = 0
    let emitted = 0
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(options.limit))
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        const chunk = value
        if (skipped + chunk.length <= offset) {
          skipped += chunk.length
          continue
        }
        const start = Math.max(0, offset - skipped)
        const accepted = chunk.subarray(start, start + limit - emitted)
        skipped += chunk.length
        if (accepted.length) {
          emitted += accepted.length
          await options.onProgress?.({
            phase: 'download', mediaIndex: 0, transferredBytes: emitted,
            totalBytes: Number.isFinite(limit) ? limit : media.size,
          })
          yield accepted
        }
        if (emitted >= limit) return
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async dispatchSync(
    response: MatrixSyncResponse,
    userId: string,
    handler: (event: IMEvent<MatrixMediaLocator>) => void | Promise<void>,
  ): Promise<void> {
    this.ingestAccountData(response)
    for (const [roomId, room] of Object.entries(response.rooms?.invite ?? {})) {
      const request = this.mapRoomInvite(roomId, room, userId)
      if (!request) continue
      const locallyResolved = this.locallyResolvedInvites.get(roomId)
      if (locallyResolved?.id === request.id) continue
      if (locallyResolved) {
        await handler({ type: 'request', request: locallyResolved })
        this.locallyResolvedInvites.delete(roomId)
      }
      const previous = this.pendingInvites.get(roomId)
      if (previous && previous.id !== request.id && previous.id !== locallyResolved?.id) {
        await handler({ type: 'request', request: { ...previous, state: 'rejected' } })
      }
      if (!previous || JSON.stringify(previous) !== JSON.stringify(request)) {
        await handler({ type: 'request', request })
      }
      this.pendingInvites.set(roomId, request)
    }
    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      const invite = this.pendingInvites.get(roomId)
      const settled = this.locallyResolvedInvites.get(roomId)
      if (invite || settled) {
        await handler({ type: 'request', request: { ...(invite ?? settled!), state: 'accepted' } })
        this.pendingInvites.delete(roomId)
        this.locallyResolvedInvites.delete(roomId)
      }
      const stateEvents = [
        ...(room.state?.events ?? []),
        ...(room.timeline?.events ?? []).filter((event) => event.state_key !== undefined),
      ]
      const stateChanged = stateEvents.length > 0
      this.ingestState(roomId, stateEvents)
      const conversation = this.updateConversation(roomId, room)
      if (stateChanged) await handler({ type: 'conversation', conversation })
      for (const event of room.timeline?.events ?? []) {
        if (!event.event_id || event.state_key !== undefined) continue
        const redacts = event.redacts ?? (event.content as { redacts?: string }).redacts
        if (event.type === 'm.room.redaction' && redacts) {
          const reactionTargetId = this.reactionEventTargets.get(redacts)
          if (reactionTargetId) {
            this.reactionEventTargets.delete(redacts)
            await handler({ type: 'message-reactions', eventId: event.event_id, conversation,
              target: { conversationId: roomId, messageId: reactionTargetId, targetId: reactionTargetId },
              context: reactionContext(await this.loadReactionEvents(roomId, reactionTargetId), userId), timestamp: matrixTimestamp(event) })
          } else await handler({ type: 'message-delete', eventId: event.event_id, conversation, messageIds: [redacts], timestamp: matrixTimestamp(event) })
          continue
        }
        if (event.type === 'm.reaction') {
          const relation = relationFromValue(event.content['m.relates_to'])
          if (relation?.rel_type !== 'm.annotation' || !relation.event_id || !relation.key) continue
          this.rememberReaction(event.event_id, relation.event_id)
          await handler({ type: 'message-reactions', eventId: event.event_id, conversation,
            target: { conversationId: roomId, messageId: relation.event_id, targetId: relation.event_id },
            context: reactionContext(await this.loadReactionEvents(roomId, relation.event_id), userId), timestamp: matrixTimestamp(event) })
          continue
        }
        const message = this.mapTimelineMessage(roomId, event)
        if (!message) continue
        const relation = (event.content as MatrixRoomMessageContent)['m.relates_to']
        if (relation?.rel_type === 'm.replace' && relation.event_id) {
          await handler({ type: 'message-edit', eventId: event.event_id, conversation, message })
        } else {
          await handler({ type: 'message', conversation, message })
        }
        if (isMatrixPollEnd(event.type) && relation?.rel_type === 'm.reference' && relation.event_id) {
          // Refresh the parent poll so Telegram removes its voting keyboard.
          // A missing/redacted parent must not block the Matrix sync loop.
          const original = await this.client.getEvent(roomId, relation.event_id).catch(() => undefined)
          const pollPart = original && matrixPollParts(original.content).find((part) => part.type === 'poll')
          if (pollPart?.type === 'poll') {
            await this.loadPollTally(roomId, relation.event_id, pollPart.poll).catch(() => undefined)
          }
          const closed = original && this.mapTimelineMessage(roomId, original)
          if (closed?.content.parts.some((part) => part.type === 'poll')) {
            await handler({
              type: 'message-edit', eventId: `matrix-poll-end:${event.event_id}`,
              conversation, message: closed,
            })
          }
        }
      }
      const receipt = room.ephemeral?.events?.find((event) => event.type === 'm.receipt')
      const receiptEventId = receipt && latestReadReceipt(receipt.content, userId)
      if (receiptEventId) await handler({ type: 'read', conversationId: roomId, upToMessageId: receiptEventId })
    }
    for (const roomId of Object.keys(response.rooms?.leave ?? {})) {
      const invite = this.pendingInvites.get(roomId)
      const settled = this.locallyResolvedInvites.get(roomId)
      if (invite || settled) {
        await handler({ type: 'request', request: { ...(invite ?? settled!), state: 'rejected' } })
        this.pendingInvites.delete(roomId)
        this.locallyResolvedInvites.delete(roomId)
      }
    }
  }

  /** Matrix invites have stripped state, not the full state of joined rooms. */
  private mapRoomInvite(
    roomId: string,
    room: MatrixInvitedRoom,
    userId: string,
  ): IMRequest<MatrixMediaLocator> | undefined {
    const events = room.invite_state?.events ?? []
    const membership = [...events].reverse().find((event) =>
      event.type === 'm.room.member'
      && event.state_key === userId
      && (event.content as MatrixRoomMemberContent).membership === 'invite')
    if (!membership?.sender) return
    const findState = (type: string, stateKey: string) => events.find((event) =>
      event.type === type && event.state_key === stateKey)?.content
    const name = findState('m.room.name', '') as { name?: string } | undefined
    const alias = findState('m.room.canonical_alias', '') as { alias?: string } | undefined
    const avatar = findState('m.room.avatar', '') as { url?: string } | undefined
    const create = findState('m.room.create', '') as { type?: string } | undefined
    const inviter = findState('m.room.member', membership.sender) as MatrixRoomMemberContent | undefined
    const reason = (membership.content as MatrixRoomMemberContent).reason
    return {
      id: `matrix:invite:${encodeURIComponent(roomId)}:${encodeURIComponent(membership.event_id ?? String(membership.origin_server_ts ?? membership.sender))}`,
      kind: 'group-join',
      state: 'pending',
      requester: this.mapUser(membership.sender, inviter),
      group: {
        id: roomId,
        kind: create?.type === 'm.space' ? 'channel' : 'group',
        title: name?.name || alias?.alias || roomId,
        avatar: avatar?.url ? avatarMedia(roomId, avatar.url) : undefined,
        metadata: { matrixRoomId: roomId, matrixRoomInvite: true },
      },
      message: reason,
      createdAt: membership.origin_server_ts,
      metadata: { matrixRoomInvite: true, matrixRoomId: roomId },
    }
  }

  private rememberReaction(eventId: string, targetId: string): void {
    this.reactionEventTargets.set(eventId, targetId)
    if (this.reactionEventTargets.size > 10_000) {
      const oldest = this.reactionEventTargets.keys().next().value
      if (oldest) this.reactionEventTargets.delete(oldest)
    }
  }

  private ingestAccountData(response: MatrixSyncResponse): void {
    const events = [
      ...(response.account_data?.events ?? []),
      ...Object.values(response.rooms?.join ?? {}).flatMap((room) => room.account_data?.events ?? []),
    ]
    const direct = events.find((event) => event.type === 'm.direct')?.content as MatrixDirectAccountData | undefined
    if (!direct) return
    this.directRoomIds.clear()
    for (const roomIds of Object.values(direct)) {
      for (const roomId of roomIds) this.directRoomIds.add(roomId)
    }
  }

  private ingestPollClosures(roomId: string, events: readonly MatrixEvent[]): void {
    for (const event of events) {
      if (!isMatrixPollEnd(event.type) || event.unsigned?.redacted_because) continue
      const parent = matrixReference(event.content)
      if (parent) this.rememberPollClosure(`${roomId}\0${parent}`)
    }
  }

  private ingestState(roomId: string, events: MatrixEvent[]): void {
    const state = this.roomState.get(roomId) ?? new Map<string, MatrixEvent>()
    for (const event of events) {
      if (event.state_key === undefined) continue
      state.set(`${event.type}\0${event.state_key}`, event)
    }
    this.roomState.set(roomId, state)
  }

  private updateConversation(roomId: string, room?: MatrixJoinedRoom): IMConversation<MatrixMediaLocator> {
    const state = this.roomState.get(roomId)
    const name = state?.get('m.room.name\0')?.content as { name?: string } | undefined
    const alias = state?.get('m.room.canonical_alias\0')?.content as { alias?: string } | undefined
    const avatar = state?.get('m.room.avatar\0')?.content as { url?: string } | undefined
    const create = state?.get('m.room.create\0')?.content as { type?: string } | undefined
    const encrypted = Boolean(state?.get('m.room.encryption\0'))
    const members = [...(state?.values() ?? [])].filter((event) =>
      event.type === 'm.room.member' && (event.content as MatrixRoomMemberContent).membership === 'join')
    const direct = this.directRoomIds.has(roomId)
    const heroId = room?.summary?.['m.heroes']?.find((id) => id !== this.accountUserId)
      ?? members.find((event) => event.state_key !== this.accountUserId)?.state_key
    const hero = heroId ? state?.get(`m.room.member\0${heroId}`)?.content as MatrixRoomMemberContent | undefined : undefined
    const title = name?.name || alias?.alias || (direct ? hero?.displayname || heroId : undefined) || roomId
    const conversation: IMConversation<MatrixMediaLocator> = {
      id: roomId,
      kind: create?.type === 'm.space' ? 'channel' : direct ? 'direct' : 'group',
      title,
      avatar: avatar?.url ? avatarMedia(roomId, avatar.url) : direct && hero?.avatar_url
        ? avatarMedia(heroId!, hero.avatar_url)
        : undefined,
      metadata: {
        matrixRoomId: roomId,
        encrypted,
        participantsCount: room?.summary?.['m.joined_member_count'] ?? members.length,
      },
    }
    this.conversations.set(roomId, conversation)
    return conversation
  }

  private mapTimelineMessage(roomId: string, event: MatrixEvent): IMMessage<MatrixMediaLocator> | undefined {
    if (!event.event_id || !event.sender) return
    if (event.type === 'm.room.encrypted') {
      return {
        id: event.event_id,
        conversationId: roomId,
        senderId: event.sender,
        sender: this.memberUser(roomId, event.sender),
        timestamp: matrixTimestamp(event),
        outgoing: event.sender === this.accountUserId,
        content: { parts: [{ type: 'text', text: '[Encrypted Matrix message — E2EE is not supported yet]' }] },
        metadata: { matrixEncrypted: true },
      }
    }
    const pollStart = isMatrixPollStart(event.type)
    const pollEnd = isMatrixPollEnd(event.type)
    if (event.unsigned?.redacted_because && (pollStart || pollEnd)) return
    const location = event.type === 'm.location' || event.type === 'org.matrix.msc3488.location'
    // Poll responses do not have a text fallback and must not appear as separate chat messages.
    if (!pollStart && !pollEnd && !location && event.type !== 'm.room.message' && event.type !== 'm.sticker') return
    const raw = matrixObject(event.content) as MatrixRoomMessageContent | undefined
    if (!raw) return
    const relation = raw['m.relates_to']
    if (pollEnd && !event.unsigned?.redacted_because
      && relation?.rel_type === 'm.reference' && relation.event_id) {
      this.rememberPollClosure(`${roomId}\0${relation.event_id}`)
    }
    const content = relation?.rel_type === 'm.replace' && raw['m.new_content'] ? raw['m.new_content'] : raw
    const parts: IMMessage<MatrixMediaLocator>['content']['parts'] = pollStart ? matrixPollParts(content)
      : pollEnd ? [{ type: 'text' as const, text: matrixEventText(event.content) || '投票已结束' }]
        : matrixMessageParts(content)
    if (!parts.length) return
    const mentionIds = matrixMentionUserIds(content)
    const messageId = relation?.rel_type === 'm.replace' && relation.event_id ? relation.event_id : event.event_id
    const pollKey = `${roomId}\0${messageId}`
    if (pollStart && parts[0]?.type === 'poll' && this.closedPolls.has(pollKey)) {
      const tally = this.pollTallies.get(pollKey)
      parts[0] = { type: 'poll', poll: {
        ...parts[0].poll, closed: true,
        ...(tally ? { counts: { ...tally.counts }, totalVoters: tally.totalVoters } : {}),
      } }
    }
    return {
      id: messageId,
      sourceIds: [messageId],
      conversationId: roomId,
      senderId: event.sender,
      sender: this.memberUser(roomId, event.sender),
      timestamp: matrixTimestamp(event),
      outgoing: event.sender === this.accountUserId,
      replyToId: pollEnd && relation?.rel_type === 'm.reference'
        ? relation.event_id
        : content['m.relates_to']?.['m.in_reply_to']?.event_id,
      content: {
        parts,
        ...(pollStart && parts[0]?.type === 'poll' && parts[0].poll.maxSelections === 1
          && !this.closedPolls.has(`${roomId}\0${messageId}`)
          ? { inlineKeyboard: { rows: parts[0].poll.answers.map((answer, index) => ({
              buttons: [{ type: 'callback' as const, text: answer.text.slice(0, 60), data: `matrix-poll-vote:${index}` }],
            })) } }
          : {}),
      },
      ...((mentionIds.length || event.unsigned?.['m.relations']?.['m.annotation']?.length) ? { metadata: {
        ...(mentionIds.length ? { matrixMentions: mentionIds } : {}),
        ...(event.unsigned?.['m.relations']?.['m.annotation']?.length
          ? { reactionContext: JSON.parse(JSON.stringify(bundledReactionContext(event.unsigned['m.relations']['m.annotation']!))) as never } : {}),
      } } : {}),
    }
  }

  private memberUser(roomId: string, userId: string): IMUser<MatrixMediaLocator> {
    const content = this.roomState.get(roomId)?.get(`m.room.member\0${userId}`)?.content as MatrixRoomMemberContent | undefined
    return this.mapUser(userId, content)
  }

  private mapUser(
    userId: string,
    profile: { displayname?: string, avatar_url?: string } = {},
  ): IMUser<MatrixMediaLocator> {
    const localpart = matrixLocalpart(userId)
    return {
      id: userId,
      firstName: profile.displayname || localpart,
      username: localpart,
      avatar: profile.avatar_url ? avatarMedia(userId, profile.avatar_url) : undefined,
      metadata: { matrixUserId: userId },
    }
  }

  private mapMember(
    userId: string,
    content: MatrixRoomMemberContent,
    roomId: string,
  ): IMConversationMember<MatrixMediaLocator> {
    const power = this.roomState.get(roomId)?.get('m.room.power_levels\0')?.content as {
      users?: Record<string, number>, users_default?: number, state_default?: number, redact?: number, invite?: number
    } | undefined
    const level = power?.users?.[userId] ?? power?.users_default ?? 0
    const owner = level >= 100
    const administrator = level >= 50
    return {
      user: this.mapUser(userId, content),
      role: owner ? 'owner' : administrator ? 'administrator' : 'member',
      permissions: {
        manageConversation: level >= (power?.state_default ?? 50),
        manageMembers: administrator,
        deleteAnyMessage: level >= (power?.redact ?? 50),
        editAnyMessage: false,
        pinMessages: level >= (power?.state_default ?? 50),
        inviteMembers: level >= (power?.invite ?? 0),
      },
    }
  }

  private async getAccountUserId(): Promise<string> {
    if (this.accountUserId) return this.accountUserId
    this.accountUserId = this.configuredUserId ?? (await this.client.whoAmI()).user_id
    return this.accountUserId
  }
}

function matrixMessageParts(content: MatrixRoomMessageContent): IMMessage<MatrixMediaLocator>['content']['parts'] {
  const body = content.body ?? ''
  if (content.msgtype === 'm.sticker') {
    const mxc = content.url ?? content.file?.url
    if (!mxc) return body ? [{ type: 'text', text: body }] : []
    const mimeType = content.info?.mimetype ?? 'image/webp'
    return [{ type: 'media', media: {
      id: mxc, kind: mimeType.startsWith('image/') ? 'image' : 'file',
      name: looksLikeFilename(body) ? body : `sticker.${mediaExtension(mimeType)}`,
      mimeType, size: content.info?.size, width: content.info?.w, height: content.info?.h, locator: { mxc },
    } }]
  }
  const structured = matrixObject(content['m.location'])
    ?? matrixObject(content['org.matrix.msc3488.location'])
  if (content.msgtype === 'm.location' || structured) {
    const coordinates = parseMatrixGeoUri(structured?.uri) ?? parseMatrixGeoUri(content.geo_uri)
    const title = (typeof structured?.description === 'string' && structured.description.trim())
      || body.trim() || matrixEventText(content).trim() || '位置'
    if (!coordinates) {
      return [{ type: 'text', text: title }]
    }
    const { latitude, longitude } = coordinates
    return [{
      type: 'card',
      card: {
        kind: 'location',
        title,
        description: `${latitude}, ${longitude}`,
        source: 'Matrix',
        latitude,
        longitude,
        url: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}`,
      },
    }]
  }
  if (content.msgtype === 'm.text' || content.msgtype === 'm.notice' || content.msgtype === 'm.emote') {
    if (!body) return []
    const prefix = content.msgtype === 'm.emote' ? '* ' : ''
    const entities = matrixTextEntities(content)?.map((entity) => ({
      ...entity, offset: entity.offset + prefix.length,
    }))
    return [{ type: 'text', text: prefix + body, ...(entities ? { entities } : {}) }]
  }
  if (!['m.image', 'm.file', 'm.audio', 'm.video'].includes(content.msgtype ?? '')) return []
  const mxc = content.url
  if (!mxc && content.file?.url) {
    return [{ type: 'text', text: `[Encrypted Matrix attachment — E2EE is not supported yet: ${body || 'file'}]` }]
  }
  if (!mxc) return []
  const info = content.info
  const image = content.msgtype === 'm.image'
  return [{
    type: 'media',
    media: {
      id: mxc,
      kind: image ? 'image' : 'file',
      name: content.filename || body || undefined,
      mimeType: info?.mimetype,
      size: info?.size,
      width: info?.w,
      height: info?.h,
      duration: info?.duration === undefined ? undefined : info.duration / 1_000,
      preview: info?.thumbnail_url && info.thumbnail_info ? {
        locator: { mxc: info.thumbnail_url },
        mimeType: info.thumbnail_info.mimetype,
        size: info.thumbnail_info.size ?? 0,
        width: info.thumbnail_info.w ?? 0,
        height: info.thumbnail_info.h ?? 0,
      } : undefined,
      locator: { mxc },
    },
  }]
}

function formattedContent(base: MatrixRoomMessageContent, body: string, entities?: readonly { type: string, offset: number, length: number, url?: string, language?: string }[]): MatrixRoomMessageContent {
  const content = { ...base, ...textContent(body, undefined, entities as never), msgtype: base.msgtype ?? 'm.text' }
  delete content['m.relates_to']; delete content['m.new_content']
  return content
}
function stickerContent(sticker: Extract<IMStickerSendPlan, { type: 'upload' }>, mxc: string, replyToId?: string): MatrixRoomMessageContent {
  return { body: sticker.emoji?.[0] || sticker.stickerId, url: mxc, info: { mimetype: sticker.mimeType, size: sticker.source.size, w: sticker.width, h: sticker.height }, ...(replyToId ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyToId } } } : {}) }
}
function mediaExtension(mime: string): string {
  return ({ 'image/apng': 'apng', 'image/gif': 'gif', 'image/png': 'png', 'image/webp': 'webp', 'application/x-tgsticker': 'tgs' } as Record<string, string>)[mime.toLowerCase()] ?? 'bin'
}
function looksLikeFilename(value: string): boolean { return /^[^/\\\r\n]{1,200}\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp|aac|m4a|mp3|ogg|wav|webm|mp4|mov|pdf|txt|zip|docx?|xlsx?|pptx?)$/iu.test(value) }
function relationFromValue(value: unknown): MatrixRoomMessageContent['m.relates_to'] | undefined {
  if (!isRecord(value)) return
  const reply = value['m.in_reply_to']
  return { rel_type: typeof value.rel_type === 'string' ? value.rel_type : undefined, event_id: typeof value.event_id === 'string' ? value.event_id : undefined, key: typeof value.key === 'string' ? value.key : undefined,
    'm.in_reply_to': isRecord(reply) && typeof reply.event_id === 'string' ? { event_id: reply.event_id } : undefined }
}
function matrixRoomMessageContent(value: unknown): MatrixRoomMessageContent {
  if (!isRecord(value)) return {}
  const info = isRecord(value.info) ? value.info : {}
  const file = isRecord(value.file) && typeof value.file.url === 'string' ? { url: value.file.url } : undefined
  return { ...value, info: { mimetype: typeof info.mimetype === 'string' ? info.mimetype : undefined, size: typeof info.size === 'number' ? info.size : undefined, w: typeof info.w === 'number' ? info.w : undefined, h: typeof info.h === 'number' ? info.h : undefined }, file, 'm.relates_to': relationFromValue(value['m.relates_to']), 'm.new_content': isRecord(value['m.new_content']) ? matrixRoomMessageContent(value['m.new_content']) : undefined } as MatrixRoomMessageContent
}
function reactionDefinition(key: string): IMReactionDefinition | undefined {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(key) && key.length <= 32 && !/[\s\r\n]/u.test(key) ? { key, presentation: { type: 'emoji', emoticon: key } } : undefined
}
function reactionDefinitions(keys: Iterable<string>): IMReactionDefinition[] {
  const all = new Map<string, IMReactionDefinition>()
  for (const key of STANDARD_REACTIONS) all.set(key, reactionDefinition(key)!)
  for (const key of keys) { const definition = reactionDefinition(key); if (definition) all.set(key, definition) }
  return [...all.values()]
}
function reactionContext(events: readonly MatrixEvent[], userId: string): IMReactionContext {
  const grouped = new Map<string, { count: number, actors: Array<{ userId: string, timestamp: number }>, selectedAt?: number }>()
  for (const event of events) {
    const relation = relationFromValue(event.content['m.relates_to'])
    if (!event.sender || relation?.rel_type !== 'm.annotation' || !relation.key) continue
    const group = grouped.get(relation.key) ?? { count: 0, actors: [] }; grouped.set(relation.key, group)
    const timestamp = matrixTimestamp(event); group.count++; group.actors.push({ userId: event.sender, timestamp })
    if (event.sender === userId) group.selectedAt = Math.max(group.selectedAt ?? 0, timestamp)
  }
  const selected = [...grouped].filter(([, x]) => x.selectedAt !== undefined).sort((a,b) => a[1].selectedAt! - b[1].selectedAt!)
  return { available: reactionDefinitions(grouped.keys()), maxSelected: MAX_SELECTED_REACTIONS, reactions: [...grouped].flatMap(([key, group]) => reactionDefinition(key) ? [{ key, count: group.count, selected: group.selectedAt !== undefined, selectedOrder: group.selectedAt === undefined ? undefined : selected.findIndex(([k]) => k === key) + 1, recentActors: group.actors.sort((a,b) => b.timestamp-a.timestamp).slice(0,3) }] : []) }
}
function bundledReactionContext(annotations: readonly MatrixAnnotation[]): IMReactionContext {
  const reactions = annotations.flatMap((item) => typeof item.count === 'number' && reactionDefinition(item.key)
    ? [{ key: item.key, count: item.count }] : [])
  return { available: reactionDefinitions(annotations.map((item) => item.key)), reactions, maxSelected: MAX_SELECTED_REACTIONS }
}

function isMatrixPollStart(type: string): boolean {
  return type === 'm.poll.start' || type === 'org.matrix.msc3381.poll.start'
}

function isMatrixPollEnd(type: string): boolean {
  return type === 'm.poll.end' || type === 'org.matrix.msc3381.poll.end'
}

function matrixReference(content: unknown): string | undefined {
  const relation = matrixObject(matrixObject(content)?.['m.relates_to'])
  return relation?.rel_type === 'm.reference' && typeof relation.event_id === 'string'
    ? relation.event_id : undefined
}

/** Parse only RFC 5870 point coordinates; malformed or out-of-range locations stay textual. */
function parseMatrixGeoUri(uri: unknown): { latitude: number, longitude: number } | undefined {
  if (typeof uri !== 'string') return
  const match = /^geo:([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)(?:,[+-]?\d+(?:\.\d+)?)?(?:;[^?#]*)?$/i.exec(uri)
  if (!match) return
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return
  return { latitude, longitude }
}

function matrixObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Both stable MSC3381 m.text arrays and legacy single-text payloads. */
function matrixEventText(value: unknown): string {
  const object = matrixObject(value)
  if (!object) return ''
  const rich = object['m.text']
  if (typeof rich === 'string') return rich
  if (Array.isArray(rich)) {
    const block = rich.map(matrixObject).find((item) => item?.mimetype === 'text/plain')
      ?? rich.map(matrixObject).find((item) => typeof item?.body === 'string')
    if (typeof block?.body === 'string') return block.body
  }
  if (typeof object['org.matrix.msc1767.text'] === 'string') return object['org.matrix.msc1767.text']
  return typeof object.body === 'string' ? object.body : ''
}

/** Preserve structured poll questions and option IDs, with a plain-text fallback. */
function matrixPollParts(value: unknown): IMMessage<MatrixMediaLocator>['content']['parts'] {
  const content = matrixObject(value)
  const poll = matrixObject(content?.['m.poll.start'])
    ?? matrixObject(content?.['m.poll'])
    ?? matrixObject(content?.['org.matrix.msc3381.poll.start'])
  const fallback = matrixEventText(content)
  if (!poll) return [{ type: 'text', text: fallback || '[无法识别的 Matrix 投票]' }]
  const question = matrixEventText(poll.question).trim()
  const options = Array.isArray(poll.answers) ? poll.answers.slice(0, 20) : []
  const seen = new Set<string>()
  const answers = options.flatMap((value) => {
    const answer = matrixObject(value)
    const id = answer?.['m.id'] ?? answer?.id
    const text = matrixEventText(answer).trim()
    if (typeof id !== 'string' || !id || !text || seen.has(id)) return []
    seen.add(id)
    return [{ id, text }]
  })
  if (!question || !answers.length) return [{ type: 'text', text: fallback || question || '[无法解析的 Matrix 投票]' }]
  const max = poll.max_selections
  const maxSelections = typeof max === 'number' && Number.isSafeInteger(max) && max > 0
    ? Math.min(max, answers.length) : 1
  return [{
    type: 'poll',
    poll: {
      question, answers, maxSelections,
      kind: poll.kind === 'm.disclosed' || poll.kind === 'm.poll.disclosed'
        || poll.kind === 'org.matrix.msc3381.poll.disclosed'
        ? 'disclosed' : 'undisclosed',
    },
  }]
}

function mediaContent(
  media: Extract<IMMessageInput['parts'][number], { type: 'media' }>['media'],
  mxc: string,
  replyToId?: string,
): MatrixRoomMessageContent {
  const msgtype = media.kind === 'image' ? 'm.image'
    : media.mimeType?.startsWith('audio/') ? 'm.audio'
      : media.mimeType?.startsWith('video/') ? 'm.video' : 'm.file'
  return {
    msgtype,
    body: media.name || 'file',
    filename: media.name,
    url: mxc,
    info: {
      mimetype: media.mimeType,
      size: media.size ?? media.source.size,
      w: media.width,
      h: media.height,
      duration: media.duration === undefined ? undefined : Math.round(media.duration * 1_000),
    },
    ...(replyToId ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyToId } } } : {}),
  }
}

function avatarMedia(ownerId: string, mxc: string): IMMedia<MatrixMediaLocator> {
  return {
    id: mxc,
    kind: 'image',
    name: `${matrixLocalpart(ownerId)}-avatar`,
    locator: { mxc },
  }
}

function matrixLocalpart(userId: string): string {
  const match = /^@([^:]+):/.exec(userId)
  return match?.[1] ?? userId
}

function matrixTimestamp(event: MatrixEvent): number {
  return Math.floor((event.origin_server_ts ?? Date.now()) / 1_000)
}

function latestReadReceipt(content: unknown, userId: string): string | undefined {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return
  let latest: { eventId: string, ts: number } | undefined
  for (const [eventId, receiptTypes] of Object.entries(content as Record<string, unknown>)) {
    if (!receiptTypes || typeof receiptTypes !== 'object' || Array.isArray(receiptTypes)) continue
    const read = (receiptTypes as Record<string, unknown>)['m.read']
    if (!read || typeof read !== 'object' || Array.isArray(read)) continue
    const receipt = (read as Record<string, unknown>)[userId]
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue
    const ts = Number((receipt as Record<string, unknown>).ts ?? 0)
    if (!latest || ts >= latest.ts) latest = { eventId, ts }
  }
  return latest?.eventId
}

function requestPageStart(cursor?: string): number {
  if (!cursor) return 0
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid Matrix request cursor: ${cursor}`)
  return value
}

function pageStart(items: Array<{ conversation: { id: string } }>, query: IMPageQuery): number {
  if (query.afterId) {
    const index = items.findIndex((item) => item.conversation.id === query.afterId)
    return index < 0 ? 0 : index + 1
  }
  if (!query.cursor) return 0
  const value = Number(query.cursor)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid Matrix cursor: ${query.cursor}`)
  return value
}

function clampLimit(limit = 100): number {
  return Math.max(0, Math.min(Math.trunc(limit), 1_000))
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.stack ?? `${error.name}: ${error.message}`
}

interface MatrixLogger {
  warn(format: string, ...args: unknown[]): void
}

export { MatrixClient, MatrixHttpError, parseMxc } from './client.js'
export type { MatrixMediaLocator } from './types.js'
