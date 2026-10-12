/**
 * Dependency-free Protocol Buffers wire codec for the Solid WebUI control plane.
 * The message kind is a protobuf enum; the original Muon/RPC JSON payload is
 * held in a bytes field to preserve snapshots, deltas and extension methods.
 * Large server->browser payloads can be gzip-compressed independently.
 *
 * Wire schema: packages/cordis-webui-solidjs/src/webui.proto
 */
export const PROTO_TRANSPORT = 'protobuf-gzip-v1'
export const MAX_DECODE_BYTES = 32 * 1024 * 1024
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const names = [
  '',
  'entry:init',
  'entry:snapshot',
  'entry:delta',
  'entry:missing',
  'rpc:request',
  'rpc:response',
  'entry:subscribe',
  'entry:unsubscribe',
  'ping',
  'pong',
  'rpc:start',
  'rpc:delta',
  'rpc:complete',
  'rpc:error',
  'rpc:cancel',
] as const
const kinds: Record<string, number> = Object.fromEntries(
  names.map((name, i) => [name, i]).slice(1),
)
export function supportsProtoType(type: string) {
  return Object.hasOwn(kinds, type)
}
function putVarint(value: number, output: number[]) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid protobuf integer')
  while (value > 127) {
    output.push((value % 128) | 128)
    value = Math.floor(value / 128)
  }
  output.push(value)
}
function readVarint(input: Uint8Array, offset: { value: number }): number {
  let value = 0, multiplier = 1
  for (let i = 0; i < 9; i++) {
    if (offset.value >= input.length) throw new Error('Truncated protobuf varint')
    const part = input[offset.value++]
    value += (part & 127) * multiplier
    if (!Number.isSafeInteger(value)) throw new Error('Oversized protobuf integer')
    if (!(part & 128)) return value
    multiplier *= 128
  }
  throw new Error('Oversized protobuf varint')
}
export interface WireFrame {
  type: string
  payload: Uint8Array
  gzip: boolean
}
export function encodeFrame(
  type: string,
  body?: unknown,
  compress?: (bytes: Uint8Array) => Uint8Array,
): Uint8Array {
  const kind = kinds[type]
  if (!kind) throw new Error('Unknown WebUI protobuf type: ' + type)
  const source = body === undefined
    ? new Uint8Array()
    : encoder.encode(JSON.stringify(body))
  let payload: Uint8Array = source, gzip = false
  if (compress && source.byteLength >= 2048) {
    const candidate = compress(source)
    if (candidate.byteLength < source.byteLength * 0.875) {
      payload = candidate
      gzip = true
    }
  }
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('WebUI frame too large')
  const header: number[] = [8]
  putVarint(kind, header)
  header.push(18)
  putVarint(payload.byteLength, header)
  const result = new Uint8Array(header.length + payload.byteLength + (gzip ? 2 : 0))
  result.set(header)
  result.set(payload, header.length)
  if (gzip) {
    result[result.length - 2] = 24
    result[result.length - 1] = 1
  }
  return result
}
export function decodeFrame(input: ArrayBuffer | Uint8Array): WireFrame {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error('WebUI frame too large')
  const position = { value: 0 }
  let kind = 0, payload: Uint8Array | undefined, gzip = false
  while (position.value < bytes.length) {
    const key = readVarint(bytes, position)
    const field = Math.floor(key / 8), wire = key % 8
    if (!field) throw new Error('Invalid protobuf field')
    if (wire === 0) {
      const value = readVarint(bytes, position)
      if (field === 1) kind = value
      if (field === 3) gzip = value !== 0
    } else if (wire === 2) {
      const length = readVarint(bytes, position)
      if (length > bytes.length - position.value) throw new Error('Truncated protobuf bytes')
      if (field === 2) payload = bytes.subarray(position.value, position.value + length)
      position.value += length
    } else if (wire === 1 || wire === 5) {
      position.value += wire === 1 ? 8 : 4
      if (position.value > bytes.length) throw new Error('Truncated protobuf fixed field')
    } else {
      throw new Error('Invalid protobuf wire type')
    }
  }
  if (!names[kind] || !payload) throw new Error('Unknown WebUI protobuf message')
  return { type: names[kind], payload, gzip }
}
export function unpackFrame(frame: WireFrame, payload = frame.payload) {
  if (payload.byteLength > MAX_DECODE_BYTES)
    throw new Error('WebUI decompressed message exceeds limit')
  return {
    type: frame.type,
    body: payload.length ? JSON.parse(decoder.decode(payload)) : undefined,
  }
}
/** Browser decompression with an output cap to prevent gzip bombs. */
export async function decompressBrowser(frame: WireFrame): Promise<Uint8Array> {
  if (!frame.gzip) return frame.payload
  const stream = new Blob([frame.payload.slice().buffer as ArrayBuffer])
    .stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_DECODE_BYTES) throw new Error('WebUI gzip exceeds limit')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
