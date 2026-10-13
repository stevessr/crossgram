import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { fromBinary } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { QQNTClient } from './client.js'
import { HighwayRequestHeadSchema } from './generated/qqnt/highway_pb.js'

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function highwayResponse(): Buffer {
  const response = Buffer.alloc(10)
  response[0] = 0x28
  response[9] = 0x29
  return response
}

function highwayBody(frame: Buffer): Buffer {
  const headLength = frame.readUInt32BE(1)
  return frame.subarray(9 + headLength, -1)
}

function highwayCommand(frame: Buffer): number | undefined {
  const headLength = frame.readUInt32BE(1)
  return fromBinary(HighwayRequestHeadSchema, frame.subarray(9, 9 + headLength)).base?.commandId
}

describe('QQNT direct playable-video upload E2E', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.close()
    await once(server, 'close')
    server = undefined
  })

  it('uploads the MP4 and bridge-owned thumbnail before posting video MsgInfo', async () => {
    const video = Buffer.from([1, 2, 3, 4, 5])
    const thumbnail = Buffer.from([9, 8, 7])
    const videoMd5 = createHash('md5').update(video).digest('hex')
    const videoSha1 = createHash('sha1').update(video).digest('hex')
    const highwayFrames: Buffer[] = []
    let preparedRequest: Record<string, any> | undefined
    let sentManifest: Record<string, any> | undefined
    let sentBody: Buffer | undefined

    server = createServer(async (request, response) => {
      if (request.url === '/v1/status') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ protocolVersion: 24, ready: true }))
        return
      }
      if (request.url === '/v1/uploads/prepare') {
        preparedRequest = JSON.parse((await collect(request)).toString())
        const address = server!.address()
        if (!address || typeof address === 'string') throw new Error('missing address')
        const upload = (commandId: number, sequenceStart: number, bytes: Buffer, extend: string) => ({
          servers: [{ host: '127.0.0.1', port: address.port }],
          ticket: Buffer.from('ticket').toString('base64url'),
          extendInfo: Buffer.from(extend).toString('base64url'),
          selfUin: '1715311957', commandId, sequenceStart, blockSize: 2,
          fileSize: bytes.length, fileMd5: createHash('md5').update(bytes).digest('hex'),
        })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: {
            kind: 'video', fileUuid: 'video-uuid',
            msgInfo: Buffer.from('complete-video-msg-info').toString('base64url'),
          },
          highway: upload(1005, 100, video, 'video-extend'),
          auxiliaryHighways: [{
            role: 'thumbnail',
            highway: upload(1006, 103, thumbnail, 'thumbnail-extend'),
          }],
        }))
        return
      }
      if (request.url?.startsWith('/cgi-bin/httpconn?')) {
        highwayFrames.push(await collect(request))
        response.end(highwayResponse())
        return
      }
      if (request.url === '/v1/messages') {
        const encoded = request.headers['x-qqnt-manifest']
        if (typeof encoded === 'string') {
          sentManifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
        }
        sentBody = await collect(request)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          id: 'sent-video', conversationId: '2:group', senderId: 'self', timestamp: 1,
          outgoing: true, parts: [{ type: 'media', media: { id: 'video', kind: 'file', name: 'clip.mp4' } }],
        }))
        return
      }
      response.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      videoThumbnail: async () => ({ bytes: thumbnail, width: 320, height: 180 }),
    })

    await client.sendMessage('2:group', [{
      type: 'text', text: 'caption',
    }, {
      type: 'media',
      media: {
        kind: 'file', name: 'clip.mp4', mimeType: 'video/mp4', width: 320, height: 180, duration: 4,
        source: { size: video.length, async *stream() { yield video } },
      },
    }])

    expect(preparedRequest).toMatchObject({ conversationId: '2:group', media: {
      kind: 'video', name: 'clip.mp4', mimeType: 'video/mp4', size: video.length,
      md5: videoMd5, sha1: videoSha1, sha1Checkpoints: [videoSha1],
      width: 320, height: 180, duration: 4,
      thumbnail: {
        size: thumbnail.length,
        md5: createHash('md5').update(thumbnail).digest('hex'),
        sha1: createHash('sha1').update(thumbnail).digest('hex'),
        width: 320,
        height: 180,
      },
    } })
    expect(highwayFrames.map(highwayCommand)).toEqual([1005, 1005, 1005, 1006, 1006])
    expect(Buffer.concat(highwayFrames.slice(0, 3).map(highwayBody))).toEqual(video)
    expect(Buffer.concat(highwayFrames.slice(3).map(highwayBody))).toEqual(thumbnail)
    expect(sentBody).toEqual(Buffer.alloc(0))
    expect(sentManifest).toMatchObject({
      conversationId: '2:group', text: 'caption',
      media: [{
        kind: 'video', name: 'clip.mp4', md5: videoMd5,
        sha1: videoSha1, sha1Checkpoints: [videoSha1],
      }],
      uploadedMedia: [{ kind: 'video', fileUuid: 'video-uuid' }],
    })
  })

  it('sends QQ raw SHA-1 states for every full MiB of a multi-block video', async () => {
    const mib = 1024 * 1024
    const video = Buffer.alloc(2 * mib + mib / 2)
    for (let index = 0; index < video.length; index++) video[index] = (index * 7 + 3) % 256
    // Reference values from an independent SHA-1 compressor: states after 1 and
    // 2 MiB (h0..h4 little-endian, no padding), then the normal whole-file digest.
    const expected = [
      'bc92149b0ce9d856ab29eb0a92f3e63e43355e67',
      '29d3a11d3780c46c9e1034ece2c4b0602855568b',
      createHash('sha1').update(video).digest('hex'),
    ]
    expect(expected[2]).toBe('7e8bf07de0da858f4a95e1d259fb3ea8286be099')
    let preparedRequest: Record<string, any> | undefined
    let sentManifest: Record<string, any> | undefined
    server = createServer(async (request, response) => {
      if (request.url === '/v1/status') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ protocolVersion: 24, ready: true }))
        return
      }
      if (request.url === '/v1/uploads/prepare') {
        preparedRequest = JSON.parse((await collect(request)).toString())
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          prepared: { kind: 'video', fileUuid: 'stored-video', msgInfo: Buffer.from('m').toString('base64url') },
        }))
        return
      }
      if (request.url === '/v1/messages') {
        const encoded = request.headers['x-qqnt-manifest']
        if (typeof encoded === 'string') sentManifest = JSON.parse(Buffer.from(encoded, 'base64url').toString())
        await collect(request)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          id: 'sent-video', conversationId: '2:group', senderId: 'self', timestamp: 1, outgoing: true, parts: [],
        }))
        return
      }
      response.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const client = new QQNTClient({
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      videoThumbnail: async () => ({ bytes: Buffer.of(1), width: 1, height: 1 }),
    })

    await client.sendMessage('2:group', [{
      type: 'media',
      media: {
        kind: 'file', name: 'long.mp4', mimeType: 'video/mp4',
        source: {
          size: video.length,
          async *stream() {
            for (let offset = 0; offset < video.length; offset += 700_001) {
              yield video.subarray(offset, offset + 700_001)
            }
          },
        },
      },
    }])

    expect(preparedRequest?.media.sha1Checkpoints).toEqual(expected)
    expect(sentManifest?.media[0].sha1Checkpoints).toEqual(expected)
  })
})
