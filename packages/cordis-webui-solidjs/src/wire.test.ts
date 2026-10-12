import { describe, expect, it } from 'vitest'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  decodeFrame, encodeFrame, MAX_DECODE_BYTES, PROTO_TRANSPORT,
  supportsProtoType, unpackFrame,
} from './wire.js'
describe('versioned WebUI protobuf transport', () => {
  it('encodes the enum and payload with standard protobuf field tags', () => {
    const binary = encodeFrame('rpc:request', { sn: 3, method: 'update', args: [1, true] })
    expect([...binary.slice(0, 3)]).toEqual([8, 5, 18])
    expect(unpackFrame(decodeFrame(binary))).toEqual({
      type: 'rpc:request', body: { sn: 3, method: 'update', args: [1, true] },
    })
    expect(unpackFrame(decodeFrame(encodeFrame('ping')))).toEqual({
      type: 'ping', body: undefined,
    })
    expect(PROTO_TRANSPORT).toBe('protobuf-gzip-v1')
    expect(supportsProtoType('entry:delta')).toBe(true)
    expect(supportsProtoType('unknown')).toBe(false)
  })
  it('compresses large state snapshots and preserves nested values losslessly', () => {
    const payload = {
      nested: { hello: 'world', count: 345, empty: null, flags: [true, false] },
      text: 'repeat me'.repeat(4000),
    }
    const raw = encodeFrame('entry:snapshot', payload)
    const compressed = encodeFrame('entry:snapshot', payload, (data) => gzipSync(data, { level: 1 }))
    const decoded = decodeFrame(compressed)
    expect(decoded.gzip).toBe(true)
    expect(compressed.length).toBeLessThan(raw.length / 5)
    expect(unpackFrame(decoded, gunzipSync(decoded.payload))).toEqual({
      type: 'entry:snapshot', body: payload,
    })
  })
  it('retains small frames without gzip and rejects corrupt/truncated frames', () => {
    expect(decodeFrame(encodeFrame('entry:delta', { count: 1 }, data => gzipSync(data))).gzip).toBe(false)
    for (const value of [
      new Uint8Array([8, 3, 18, 128]),
      new Uint8Array([8, 0, 18, 0]),
      new Uint8Array([14]),
      new Uint8Array([8, 3, 18, 9, 1]),
    ]) expect(() => decodeFrame(value)).toThrow()
    expect(() => encodeFrame('not-supported')).toThrow()
    const bomb = { type: 'entry:snapshot', gzip: false, payload: new Uint8Array(MAX_DECODE_BYTES + 1) }
    expect(() => unpackFrame(bomb)).toThrow('limit')
  })
})
