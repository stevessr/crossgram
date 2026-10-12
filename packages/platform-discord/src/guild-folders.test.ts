import { describe, expect, it } from 'vitest'
import { decodeLegacyGuildFolders, decodeProtoGuildFolders } from './guild-folders.js'

function varint(number: bigint): Buffer {
  const bytes: number[] = []
  let value = number
  do {
    let byte = Number(value & 0x7fn)
    value >>= 7n
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}

function bytesField(number: number, data: Buffer): Buffer {
  return Buffer.concat([varint(BigInt(number * 8 + 2)), varint(BigInt(data.length)), data])
}

function intField(number: number, value: bigint): Buffer {
  return Buffer.concat([varint(BigInt(number * 8)), varint(value)])
}

function fixed64(value: bigint): Buffer {
  const data = Buffer.alloc(8)
  data.writeBigUInt64LE(value)
  return data
}

function encodeGuildFolder(id: bigint, title: string, guilds: bigint[]): Buffer {
  return bytesField(1, Buffer.concat([
    bytesField(1, Buffer.concat(guilds.map(fixed64))),
    bytesField(2, intField(1, id)),
    bytesField(3, bytesField(1, Buffer.from(title))),
  ]))
}

function encodeSettings(...folders: Buffer[]): string {
  return bytesField(14, Buffer.concat(folders)).toString('base64')
}

describe('Discord user guild folders', () => {
  it('decodes 64-bit Snowflakes exactly, packed guild IDs, names, and ordering', () => {
    const guild = 1234567890123456789n
    const data = encodeSettings(
      encodeGuildFolder(9007199254740999n, '工作', [guild, guild, 101n]),
      encodeGuildFolder(777n, '', [202n]),
    )
    expect(decodeProtoGuildFolders(data)).toEqual([
      { id: '9007199254740999', title: '工作', guildIds: [String(guild), '101'] },
      { id: '777', title: 'Folder 777', guildIds: ['202'] },
    ])
  })

  it('distinguishes a full removal from an unrelated partial settings update', () => {
    const unrelated = bytesField(2, Buffer.from([0]))
    expect(decodeProtoGuildFolders(unrelated.toString('base64'), true)).toBeUndefined()
    expect(decodeProtoGuildFolders(unrelated.toString('base64'), false)).toEqual([])
    expect(decodeProtoGuildFolders(encodeSettings(), true)).toEqual([])
  })

  it('rejects corrupt and unsupported protobuf data without clearing existing folders', () => {
    expect(decodeProtoGuildFolders('AA==')).toBeUndefined()
    expect(decodeProtoGuildFolders('not-base64')).toBeUndefined()
    expect(decodeProtoGuildFolders(bytesField(14, Buffer.from([0x0a, 0xff])).toString('base64')))
      .toBeUndefined()
    expect(decodeProtoGuildFolders(null)).toBeUndefined()
  })

  it('supports older camel/snake settings, skips unfoldered servers and invalid IDs', () => {
    expect(decodeLegacyGuildFolders([
      { id: null, guild_ids: ['100'] },
      { id: '9007199254740999', name: 'Friends', guild_ids: ['100', '101', '100'] },
      { id: 42, name: '', guildIds: ['102', 103, 0] },
      { id: Number.MAX_SAFE_INTEGER + 2, guild_ids: ['104'] },
    ])).toEqual([
      { id: '9007199254740999', title: 'Friends', guildIds: ['100', '101'] },
      { id: '42', title: 'Folder 42', guildIds: ['102', '103'] },
    ])
    expect(decodeLegacyGuildFolders(undefined)).toBeUndefined()
    expect(decodeLegacyGuildFolders([])).toEqual([])
  })
})
