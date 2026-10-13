/** Native protobuf Value/Struct/List codec. No JSON text is carried on the wire. */
const utf8 = new TextEncoder()
const text = new TextDecoder('utf-8', { fatal: true })
const MAX_DEPTH = 64
const MAX_BYTES = 32 * 1024 * 1024
class Writer {
  private bytes = new Uint8Array(64)
  private size = 0
  private reserve(length: number) {
    const needed = this.size + length
    if (needed > MAX_BYTES) throw new Error('WebUI protobuf value exceeds limit')
    if (needed <= this.bytes.length) return
    const grown = new Uint8Array(Math.min(MAX_BYTES, Math.max(needed, this.bytes.length * 2)))
    grown.set(this.bytes.subarray(0, this.size))
    this.bytes = grown
  }
  add(bytes: Uint8Array) {
    this.reserve(bytes.length)
    this.bytes.set(bytes, this.size)
    this.size += bytes.length
  }
  uint(value: number) {
    do {
      this.reserve(1)
      this.bytes[this.size++] = (value % 128) | (value >= 128 ? 128 : 0)
      value = Math.floor(value / 128)
    } while (value)
  }
  field(tag: number, bytes: Uint8Array) {
    this.uint(tag * 8 + 2)
    this.uint(bytes.length)
    this.add(bytes)
  }
  finish() { return this.bytes.subarray(0, this.size) }
}
export function encodeValue(value: unknown): Uint8Array {
  const ancestors = new Set<object>()
  const normalize = (input: any, key: string) =>
    input && typeof input.toJSON === 'function' ? input.toJSON(key) : input
  function encode(input: any, depth: number): Uint8Array {
    if (depth > MAX_DEPTH) throw new Error('WebUI protobuf nesting exceeds limit')
    const w = new Writer()
    // Match the former JSON boundary: toJSON is honored, object functions and
    // undefined are omitted, array holes/non-finite numbers become null.
    if (input == null || typeof input === 'function' || typeof input === 'symbol') {
      w.uint(8); w.uint(0)
    } else if (typeof input === 'boolean') {
      w.uint(32); w.uint(input ? 1 : 0)
    } else if (typeof input === 'number') {
      if (!Number.isFinite(input)) { w.uint(8); w.uint(0) }
      else {
        w.uint(17)
        const bytes = new Uint8Array(8)
        new DataView(bytes.buffer).setFloat64(0, input, true)
        w.add(bytes)
      }
    } else if (typeof input === 'string') {
      w.field(3, utf8.encode(input))
    } else if (typeof input === 'object') {
      if (ancestors.has(input)) throw new Error('Circular WebUI protobuf value')
      ancestors.add(input)
      const nested = new Writer()
      if (Array.isArray(input)) {
        for (let i = 0; i < input.length; i++)
          nested.field(1, encode(normalize(input[i], String(i)), depth + 1))
        w.field(6, nested.finish())
      } else {
        for (const key of Object.keys(input)) {
          const item = normalize(input[key], key)
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
          const entry = new Writer()
          entry.field(1, utf8.encode(key))
          entry.field(2, encode(item, depth + 1))
          nested.field(1, entry.finish())
        }
        w.field(5, nested.finish())
      }
      ancestors.delete(input)
    } else throw new Error('Unsupported WebUI protobuf value: ' + typeof input)
    return w.finish()
  }
  return encode(normalize(value, ''), 0)
}
class Reader {
  offset = 0
  constructor(readonly bytes: Uint8Array) {}
  uint() {
    let value = 0, factor = 1
    for (let i = 0; i < 9; i++) {
      if (this.offset >= this.bytes.length) throw new Error('Truncated protobuf value')
      const b = this.bytes[this.offset++]
      value += (b & 127) * factor
      if (!Number.isSafeInteger(value)) throw new Error('Oversized protobuf integer')
      if (!(b & 128)) return value
      factor *= 128
    }
    throw new Error('Oversized protobuf integer')
  }
  take(size: number) {
    if (size > this.bytes.length - this.offset) throw new Error('Truncated protobuf value')
    const bytes = this.bytes.subarray(this.offset, this.offset + size)
    this.offset += size
    return bytes
  }
  block() { return this.take(this.uint()) }
  skip(wire: number) {
    if (wire === 0) this.uint()
    else if (wire === 1) this.take(8)
    else if (wire === 2) this.block()
    else if (wire === 5) this.take(4)
    else throw new Error('Invalid protobuf value wire type')
  }
}
export function decodeValue(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_BYTES) throw new Error('WebUI protobuf value exceeds limit')
  function decode(bytes: Uint8Array, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error('WebUI protobuf nesting exceeds limit')
    const r = new Reader(bytes)
    let result: unknown = null
    while (r.offset < bytes.length) {
      const tag = r.uint(), field = Math.floor(tag / 8), wire = tag % 8
      if (!field) throw new Error('Invalid protobuf value field')
      if (field === 1 && wire === 0) { r.uint(); result = null }
      else if (field === 2 && wire === 1) {
        const b = r.take(8)
        const value = new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)
        if (!Number.isFinite(value)) throw new Error('Invalid protobuf number')
        result = value
      } else if (field === 3 && wire === 2) result = text.decode(r.block())
      else if (field === 4 && wire === 0) result = Boolean(r.uint())
      else if ((field === 5 || field === 6) && wire === 2) {
        const nested = new Reader(r.block())
        const object: Record<string, unknown> = {}, list: unknown[] = []
        while (nested.offset < nested.bytes.length) {
          const tag = nested.uint()
          if (tag !== 10) { if (!Math.floor(tag / 8)) throw new Error('Invalid protobuf collection field'); nested.skip(tag % 8); continue }
          const data = nested.block()
          if (field === 6) { list.push(decode(data, depth + 1)); continue }
          const entry = new Reader(data)
          let key = '', value: unknown = null
          while (entry.offset < data.length) {
            const tag = entry.uint()
            if (tag === 10) key = text.decode(entry.block())
            else if (tag === 18) value = decode(entry.block(), depth + 1)
            else { if (!Math.floor(tag / 8)) throw new Error('Invalid protobuf map field'); entry.skip(tag % 8) }
          }
          // Define own data properties rather than invoking __proto__ setters.
          Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
        }
        result = field === 6 ? list : object
      } else r.skip(wire)
    }
    return result
  }
  return decode(bytes, 0)
}
