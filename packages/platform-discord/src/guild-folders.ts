/** Discord's user account server folders (NOT GUILD_CATEGORY channels).
 * Both the legacy Gateway setting and preloaded user-settings protobuf are supported.
 * Only fields needed for read-only Telegram folder projection are decoded.
 */
export interface DiscordGuildFolder {
  id: string
  title: string
  guildIds: string[]
}

function snowflake(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value > 0n ? value.toString() : undefined
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
  return undefined
}

function deduplicate(folders: DiscordGuildFolder[]): DiscordGuildFolder[] {
  const unique = new Map<string, DiscordGuildFolder>()
  for (const folder of folders) unique.set(folder.id, folder)
  return [...unique.values()]
}

/** Null IDs in Discord settings are bare servers, not user-created folders. */
export function decodeLegacyGuildFolders(value: unknown): DiscordGuildFolder[] | undefined {
  if (!Array.isArray(value)) return undefined
  const folders: DiscordGuildFolder[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const folder = entry as Record<string, unknown>
    const id = snowflake(folder.id)
    if (!id) continue
    const guildIds = folder.guild_ids ?? folder.guildIds
    if (!Array.isArray(guildIds)) continue
    folders.push({
      id,
      title: typeof folder.name === 'string' && folder.name.trim() ? folder.name : 'Folder ' + id,
      guildIds: [...new Set(guildIds.map(snowflake).filter((id): id is string => !!id))],
    })
  }
  return deduplicate(folders)
}

interface WireField {
  number: number
  wire: number
  value?: bigint
  bytes?: Buffer
}

function readVarint(data: Buffer, offset: { at: number }): bigint {
  let result = 0n
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (offset.at >= data.length) throw new Error('Truncated Discord settings varint')
    const octet = data[offset.at++]!
    result |= BigInt(octet & 0x7f) << shift
    if (!(octet & 0x80)) return result
  }
  throw new Error('Oversized Discord settings varint')
}

function walkFields(data: Buffer, visit: (field: WireField) => void): void {
  const offset = { at: 0 }
  while (offset.at < data.length) {
    const key = readVarint(data, offset)
    const number = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid Discord settings field')
    if (wire === 0) {
      visit({ number, wire, value: readVarint(data, offset) })
    } else if (wire === 1) {
      if (offset.at + 8 > data.length) throw new Error('Truncated Discord settings fixed64')
      visit({ number, wire, value: data.readBigUInt64LE(offset.at) })
      offset.at += 8
    } else if (wire === 2) {
      const length = Number(readVarint(data, offset))
      if (!Number.isSafeInteger(length) || length < 0 || length > data.length - offset.at) {
        throw new Error('Invalid Discord settings length')
      }
      visit({ number, wire, bytes: data.subarray(offset.at, offset.at + length) })
      offset.at += length
    } else if (wire === 5) {
      if (offset.at + 4 > data.length) throw new Error('Truncated Discord settings fixed32')
      offset.at += 4
    } else {
      throw new Error('Invalid Discord settings wire type')
    }
  }
}

function wrapperInt(data: Buffer): string | undefined {
  let id: string | undefined
  walkFields(data, (field) => {
    if (field.number === 1 && field.value !== undefined) id = snowflake(field.value)
  })
  return id
}

function wrapperString(data: Buffer): string {
  let name = ''
  walkFields(data, (field) => {
    if (field.number === 1 && field.bytes) name = field.bytes.toString('utf8')
  })
  return name
}

function decodeFolder(data: Buffer): DiscordGuildFolder | undefined {
  let id: string | undefined
  let title = ''
  const guildIds: string[] = []
  walkFields(data, (field) => {
    if (field.number === 1 && field.wire === 1 && field.value !== undefined) {
      const guildId = snowflake(field.value)
      if (guildId) guildIds.push(guildId)
    } else if (field.number === 1 && field.wire === 2 && field.bytes) {
      // Proto3 can pack repeated fixed64 values.
      if (field.bytes.length % 8 !== 0) throw new Error('Invalid packed guild IDs')
      for (let at = 0; at < field.bytes.length; at += 8) {
        const guildId = snowflake(field.bytes.readBigUInt64LE(at))
        if (guildId) guildIds.push(guildId)
      }
    } else if (field.number === 2 && field.bytes) {
      id = wrapperInt(field.bytes)
    } else if (field.number === 3 && field.bytes) {
      title = wrapperString(field.bytes)
    }
  })
  if (!id) return undefined
  return { id, title: title.trim() ? title : 'Folder ' + id, guildIds: [...new Set(guildIds)] }
}

/**
 * PRELOADED_USER_SETTINGS: field 14 -> GuildFolders; field 1 -> GuildFolder[].
 * A partial update without field 14 leaves the previous folder snapshot intact.
 * Corrupted or unsupported settings must never be interpreted as empty folders.
 */
export function decodeProtoGuildFolders(encoded: unknown, partial = false): DiscordGuildFolder[] | undefined {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 4 * 1024 * 1024
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined
  try {
    const data = Buffer.from(encoded, 'base64')
    const folders: DiscordGuildFolder[] = []
    let received = false
    walkFields(data, (field) => {
      if (field.number !== 14 || !field.bytes) return
      received = true
      walkFields(field.bytes, (nested) => {
        if (nested.number === 1 && nested.bytes) {
          const folder = decodeFolder(nested.bytes)
          if (folder) folders.push(folder)
        }
      })
    })
    if (partial && !received) return undefined
    return deduplicate(folders)
  } catch {
    return undefined
  }
}
