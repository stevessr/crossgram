import { afterAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import PostgresDriver from '@cordisjs/plugin-database-postgres'

// PGX speaks the PostgreSQL wire protocol: exercise the exact same schema,
// JSON/binary/timestamp, unique-constraint and transaction contract on both.
for (const backend of [
  { name: 'PostgreSQL', connection: process.env.CROSSGRAM_POSTGRES_TEST_URL },
  { name: 'PGX', connection: process.env.CROSSGRAM_PGX_TEST_URL },
]) {
  const { connection } = backend
  const suite = connection ? describe : describe.skip
  const tableName = 'crossgram_' + backend.name.toLowerCase() + '_e2e'
  const constraintName = 'crossgram_' + backend.name.toLowerCase() + '_constraint_name_e2e'

  suite('Crossgram ' + backend.name + ' driver E2E', () => {
  const ctx = new Context()
  const fibers: any[] = []

  afterAll(async () => {
    await Promise.all(fibers.reverse().map((fiber) => Promise.resolve(fiber.dispose?.())))
  })

  it('creates schema and commits JSON, binary, timestamp, and transactional updates', async () => {
    const url = new URL(connection!)
    const database = ctx.plugin(Database)
    const driver = ctx.plugin(PostgresDriver, {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      max: 4,
    })
    fibers.push(database, driver)
    await Promise.all([database, driver])
    await new Promise((resolve) => setTimeout(resolve, 25))
    ctx.model.extend(tableName as any, {
      id: 'unsigned', payload: 'json', bytes: 'binary', updatedAt: 'timestamp', counter: 'unsigned',
    }, { primary: 'id' })
    ctx.model.extend(constraintName as any, {
      id: 'unsigned', platformSessionId: 'string', platformConversationId: 'text',
    }, {
      primary: 'id', autoInc: true,
      unique: [['platformSessionId', 'platformConversationId']],
    })
    await ctx.database.prepared()
    // PostgreSQL truncates identifiers to 63 bytes. The driver must compare
    // against that canonical name on every later schema preparation instead
    // of repeatedly trying to add the already-existing unique constraint.
    await expect(ctx.database.prepared()).resolves.toBeUndefined()

    await ctx.database.remove(tableName as any, {})
    await ctx.database.create(tableName as any, {
      id: 1, payload: { driver: 'postgres', nested: { ok: true } },
      bytes: Uint8Array.of(1, 2, 3), updatedAt: new Date('2026-08-23T00:00:00.000Z'), counter: 1,
    })
    await ctx.database.withTransaction(async (database) => {
      await database.set(tableName as any, { id: 1 }, { counter: { $add: [{ $: 'counter' }, 1] } })
    })

    const [row] = await ctx.database.get(tableName as any, { id: 1 })
    expect(row).toMatchObject({ id: 1, payload: { driver: 'postgres', nested: { ok: true } }, counter: 2 })
    expect(Buffer.from(row.bytes)).toEqual(Buffer.from([1, 2, 3]))
    expect(row.updatedAt).toEqual(new Date('2026-08-23T00:00:00.000Z'))

    await ctx.database.remove(constraintName as any, {})
    await ctx.database.create(constraintName as any, {
      platformSessionId: 'session', platformConversationId: 'conversation',
    })
    await expect(ctx.database.create(constraintName as any, {
      platformSessionId: 'session', platformConversationId: 'conversation',
    })).rejects.toThrow()
  }, 30_000)
  })
}
