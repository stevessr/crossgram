import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { MatrixPlatform } from './index.js'

describe('Matrix platform HTTP e2e', () => {
  const requests: Array<{ method: string, path: string, authorization?: string, body: Uint8Array }> = []
  let eventSequence = 0
  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    requests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      authorization: request.headers.authorization,
      body,
    })
    await route(request, response, body)
  })
  const proxyConnections: string[] = []
  // HTTP proxies may forward absolute-form requests instead of tunneling
  // HTTP origins with CONNECT (implementation/version dependent).
  const proxy = createServer((request, response) => {
    let target: URL
    try {
      target = new URL(request.url ?? '')
      if (target.protocol !== 'http:') throw new Error('unsupported proxy target')
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    proxyConnections.push(target.host)
    const upstream = httpRequest(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.pipe(response)
    })
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  })
  proxy.on('connect', (request, clientSocket, head) => {
    proxyConnections.push(request.url ?? '')
    const target = new URL(`http://${request.url}`)
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  let homeserver: string
  let proxyUrl: string
  let activePlatform: MatrixPlatform | undefined
  let invitationScenario = false
  const invitedRooms = new Set<string>()
  const joinedRooms = new Set<string>()

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const proxyAddress = proxy.address() as AddressInfo
    homeserver = `http://127.0.0.1:${address.port}`
    proxyUrl = `http://127.0.0.1:${proxyAddress.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()))
  })

  afterEach(async () => {
    await activePlatform?.stop()
    activePlatform = undefined
    invitationScenario = false
    invitedRooms.clear()
    joinedRooms.clear()
  })

  it('bridges a complete account, dialog, history, send, and media workflow over real HTTP', async () => {
    const platform = activePlatform = new MatrixPlatform({
      homeserver,
      accessToken: 'e2e-token',
      proxy: proxyUrl,
      requestTimeoutMs: 2_000,
      syncTimeoutMs: 100,
    })
    const session: PlatformSession = {
      platformSessionId: 'e2e', platformId: 'matrix', userId: '@bot:test', credentials: {}, metadata: {},
    }

    const account = await platform.getAccount()
    const dialogs = await platform.getDialogs(session)
    const history = await platform.getHistory(session, { id: '!e2e:test' }, { limit: 10 })
    const sent = await platform.sendMessage(session, { id: '!e2e:test' }, {
      parts: [
        { type: 'text', text: 'sent through e2e' },
        {
          type: 'media',
          media: {
            kind: 'file', name: 'e2e.bin', mimeType: 'application/octet-stream', size: 4,
            source: { size: 4, async *stream() { yield new Uint8Array([10, 20, 30, 40]) } },
          },
        },
      ],
    })
    const downloaded: number[] = []
    for await (const chunk of platform.downloadMedia(session, {
      id: 'mxc://test/media', kind: 'file', locator: { mxc: 'mxc://test/media' },
    })) downloaded.push(...chunk)

    expect(account.user).toMatchObject({ id: '@bot:test', firstName: 'E2E Bot', username: 'bot' })
    expect(dialogs.dialogs[0]).toMatchObject({
      conversation: { id: '!e2e:test', title: 'E2E Room', kind: 'group' },
      lastMessage: { id: '$latest', content: { parts: [{ text: 'latest from server' }] } },
    })
    expect(history.messages.map((message) => message.id)).toEqual(['$old-2', '$old-1'])
    expect(sent.sourceIds).toHaveLength(2)
    expect(downloaded).toEqual([5, 4, 3, 2, 1])

    expect(requests.every((request) => request.authorization === 'Bearer e2e-token')).toBe(true)
    const upload = requests.find((request) => request.path.startsWith('/_matrix/media/v3/upload'))
    expect(upload).toMatchObject({ method: 'POST' })
    expect(upload?.path).toContain('filename=e2e.bin')
    expect(upload?.body).toEqual(new Uint8Array([10, 20, 30, 40]))
    const sends = requests.filter((request) => request.path.includes('/send/m.room.message/'))
    expect(sends).toHaveLength(2)
    expect(proxyConnections).toContain(new URL(homeserver).host)
    expect(JSON.parse(new TextDecoder().decode(sends[0]!.body))).toMatchObject({
      msgtype: 'm.text', body: 'sent through e2e',
    })
    expect(JSON.parse(new TextDecoder().decode(sends[1]!.body))).toMatchObject({
      msgtype: 'm.file', url: 'mxc://test/uploaded', body: 'e2e.bin',
    })
  })

  it('handles Matrix invitation accept/reject over real authenticated HTTP', async () => {
    invitationScenario = true
    invitedRooms.add('!accept:test')
    invitedRooms.add('!decline:test')
    const platform = activePlatform = new MatrixPlatform({
      homeserver, accessToken: 'e2e-token', proxy: proxyUrl, userId: '@bot:test',
      requestTimeoutMs: 2_000, syncTimeoutMs: 100,
    })
    const session: PlatformSession = {
      platformSessionId: 'matrix-invite-e2e', platformId: 'matrix',
      userId: '@bot:test', credentials: {}, metadata: {},
    }
    const requests = (await platform.getRequests(session)).requests
    expect(requests).toHaveLength(2)
    const accept = requests.find((request) => request.group?.id === '!accept:test')!
    const decline = requests.find((request) => request.group?.id === '!decline:test')!
    expect(accept).toMatchObject({
      kind: 'group-join', state: 'pending',
      requester: { id: '@alice:test' },
      group: { title: 'Invite !accept:test' },
    })
    expect((await platform.resolveRequest(session, accept.id, 'accept')).state).toBe('accepted')
    expect((await platform.resolveRequest(session, decline.id, 'reject')).state).toBe('rejected')
    const updated = (await platform.getRequests(session)).requests
    expect(updated.find((request) => request.id === accept.id)?.state).toBe('accepted')
    expect(updated.find((request) => request.id === decline.id)?.state).toBe('rejected')
    expect((await platform.getDialogs(session)).dialogs.map((dialog) => dialog.conversation.id))
      .toContain('!accept:test')
    const posted = requestsForInvitations()
    expect(posted.map((item) => item.path)).toEqual([
      '/_matrix/client/v3/rooms/!accept%3Atest/join',
      '/_matrix/client/v3/rooms/!decline%3Atest/leave',
    ])
    expect(posted.every((item) => item.method === 'POST' && item.authorization === 'Bearer e2e-token'))
      .toBe(true)
    expect(posted.map((item) => JSON.parse(new TextDecoder().decode(item.body))))
      .toEqual([{}, {}])
  })

  function requestsForInvitations() {
    return requests.filter((request) =>
      request.path.endsWith('/join') || request.path.endsWith('/leave'))
  }

  async function route(request: IncomingMessage, response: ServerResponse, _body: Uint8Array): Promise<void> {
    const url = new URL(request.url ?? '/', homeserver || 'http://127.0.0.1')
    if (url.pathname.endsWith('/account/whoami')) return sendJson(response, { user_id: '@bot:test' })
    if (url.pathname.includes('/profile/')) return sendJson(response, {
      displayname: 'E2E Bot', avatar_url: 'mxc://test/avatar',
    })
    if (invitationScenario) {
      const match = /^\/_matrix\/client\/v3\/rooms\/(.+)\/(join|leave)$/.exec(url.pathname)
      if (match && request.method === 'POST') {
        const roomId = decodeURIComponent(match[1]!)
        if (match[2] === 'join') {
          invitedRooms.delete(roomId)
          joinedRooms.add(roomId)
          return sendJson(response, { room_id: roomId })
        }
        invitedRooms.delete(roomId)
        joinedRooms.delete(roomId)
        return sendJson(response, {})
      }
      if (url.pathname.endsWith('/sync')) {
        const invite = Object.fromEntries([...invitedRooms].map((roomId) => [roomId, {
          invite_state: { events: [
            { type: 'm.room.name', state_key: '', content: { name: `Invite ${roomId}` } },
            {
              type: 'm.room.member', state_key: '@bot:test', sender: '@alice:test',
              event_id: `$invite-${roomId}`, content: { membership: 'invite', reason: 'Join us' },
            },
          ] },
        }]))
        const join = Object.fromEntries([...joinedRooms].map((roomId) => [roomId, {
          state: { events: [
            { type: 'm.room.name', state_key: '', content: { name: `Invite ${roomId}` } },
          ] },
        }]))
        return sendJson(response, { next_batch: 'invite-token', rooms: { invite, join } })
      }
    }
    if (url.pathname.endsWith('/sync')) return sendJson(response, {
      next_batch: 'e2e-sync',
      rooms: { join: { '!e2e:test': {
        state: { events: [
          { type: 'm.room.create', state_key: '', content: {} },
          { type: 'm.room.name', state_key: '', content: { name: 'E2E Room' } },
          {
            type: 'm.room.member', state_key: '@bot:test', sender: '@bot:test',
            content: { membership: 'join', displayname: 'E2E Bot' },
          },
        ] },
        timeline: { events: [{
          type: 'm.room.message', event_id: '$latest', sender: '@bot:test', origin_server_ts: 3_000,
          content: { msgtype: 'm.text', body: 'latest from server' },
        }] },
      } } },
    })
    if (url.pathname.endsWith('/messages')) return sendJson(response, {
      start: 'start', end: 'end', chunk: [
        {
          type: 'm.room.message', event_id: '$old-2', sender: '@alice:test', origin_server_ts: 2_000,
          content: { msgtype: 'm.text', body: 'older two' },
        },
        {
          type: 'm.room.message', event_id: '$old-1', sender: '@alice:test', origin_server_ts: 1_000,
          content: { msgtype: 'm.text', body: 'older one' },
        },
      ],
    })
    if (url.pathname.endsWith('/upload')) return sendJson(response, { content_uri: 'mxc://test/uploaded' })
    if (url.pathname.includes('/send/')) return sendJson(response, { event_id: `$e2e-sent-${++eventSequence}` })
    if (url.pathname.includes('/download/test/media')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from([5, 4, 3, 2, 1]))
      return
    }
    sendJson(response, { errcode: 'M_NOT_FOUND', error: `unhandled ${url.pathname}` }, 404)
  }
})

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return new Uint8Array(Buffer.concat(chunks))
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
