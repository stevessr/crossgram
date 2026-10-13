import { describe, expect, it } from 'vitest'
import { encodeValue, decodeValue } from './protobuf-value.js'

describe('native protobuf values', () => {
  it.each([null, true, false, 0, -1, 1.25, Number.MAX_SAFE_INTEGER,
    '', '中文🙂', [], {}, [null, true, 3, 'x'], { nested: { rows: [1, 2] } },
  ])('roundtrips %j without JSON', value => {
    expect(decodeValue(encodeValue(value))).toEqual(value)
  })
  it('uses standard Value field tags and little endian doubles', () => {
    expect([...encodeValue('x')]).toEqual([26, 1, 120])
    expect([...encodeValue(true)]).toEqual([32, 1])
    expect([...encodeValue(null)]).toEqual([8, 0])
    expect([...encodeValue(1)]).toEqual([17, 0, 0, 0, 0, 0, 0, 240, 63])
  })
  it('retains former JSON-boundary semantics for extension state', () => {
    const value = { fn() {}, missing: undefined, date: new Date('2026-01-01'),
      array: [undefined, NaN, Infinity, () => {}] }
    expect(decodeValue(encodeValue(value))).toEqual(JSON.parse(JSON.stringify(value)))
  })
  it('serializes callable Schemastery-style values before filtering functions', () => {
    const schema = Object.assign(() => {}, { toJSON: (key: string) => ({ type: 'string', key }) })
    const omitted = { toJSON() { return undefined } }
    const value = { schema, omitted, array: [schema, omitted] }
    expect(decodeValue(encodeValue(value))).toEqual(JSON.parse(JSON.stringify(value)))
  })
  it('does not mutate prototypes through object keys', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":2}')
    const decoded = decodeValue(encodeValue(value)) as any
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    expect(decoded.__proto__).toEqual({ polluted: true })
    expect(({} as any).polluted).toBeUndefined()
  })
  it('bounds recursion and rejects cycles, malformed lengths, UTF8 and wire types', () => {
    const cycle: any = {}; cycle.self = cycle
    expect(() => encodeValue(cycle)).toThrow('Circular')
    let nested: unknown = null
    for (let i = 0; i < 66; i++) nested = [nested]
    expect(() => encodeValue(nested)).toThrow('nesting')
    for (const bytes of [[26, 8, 1], [17, 1], [26, 1, 255], [0], [15]])
      expect(() => decodeValue(Uint8Array.from(bytes))).toThrow()
    expect(() => encodeValue(1n)).toThrow('Unsupported')
  })
})
