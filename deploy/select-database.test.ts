import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { selectDatabaseBackend, selectDatabaseBackendFile } from './select-database.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = readFileSync(join(root, 'deploy/app.production.yml'), 'utf8')

function driverBlock(source: string, id: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === '    - id: database-' + id)
  expect(start).toBeGreaterThanOrEqual(0)
  let end = start + 1
  while (end < lines.length && !/^ {0,4}- id: /.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

function enabled(source: string, id: string): boolean {
  return !/^      disabled: true$/m.test(driverBlock(source, id))
}

describe('Crossgram optional PGX backend', () => {
  it('ships with production PostgreSQL enabled and PGX disabled with a two-connection pool', () => {
    expect(enabled(fixture, 'postgres')).toBe(true)
    expect(enabled(fixture, 'pgx')).toBe(false)
    expect(driverBlock(fixture, 'pgx')).toContain("name: '@cordisjs/plugin-database-postgres'")
    expect(driverBlock(fixture, 'pgx')).toContain('max: 2')
    expect(driverBlock(fixture, 'pgx')).toContain('process.env.CROSSGRAM_PGX_PASSWORD')
    expect(driverBlock(fixture, 'pgx')).toContain('process.env.CROSSGRAM_PGX_DATABASE')
    expect(driverBlock(fixture, 'postgres')).toContain('max: 10')
  })

  it('switches exactly one PostgreSQL-compatible driver and is idempotent', () => {
    const pgx = selectDatabaseBackend(fixture, 'pgx')
    expect(enabled(pgx, 'postgres')).toBe(false)
    expect(enabled(pgx, 'pgx')).toBe(true)
    expect(selectDatabaseBackend(pgx, 'pgx')).toBe(pgx)
    expect(selectDatabaseBackend(pgx, 'postgres')).toBe(fixture)
    expect(pgx).toContain("name: '@mtproto-relay/update-store-database'")
    expect(pgx).toContain('password:\n          __jsExpr: process.env.CROSSGRAM_POSTGRES_PASSWORD')
  })

  it('preserves PGX-specific settings and rejects missing driver entries', () => {
    const custom = fixture.replace('max: 2', 'max: 1')
      .replace('process.env.CROSSGRAM_PGX_DATABASE', "process.env.CROSSGRAM_PGX_DATABASE || 'temporary'")
    const pgx = selectDatabaseBackend(custom, 'pgx')
    expect(driverBlock(pgx, 'pgx')).toContain('max: 1')
    expect(driverBlock(pgx, 'pgx')).toContain("|| 'temporary'")
    expect(() => selectDatabaseBackend(custom, 'sqlite')).toThrow(/postgres or pgx/)
    expect(() => selectDatabaseBackend(custom.replace('id: database-pgx', 'id: missing'), 'pgx')).toThrow(/not found/)
    expect(() => selectDatabaseBackend(custom.replace("name: '@cordisjs/plugin-database-postgres'", "name: 'not-postgres'"), 'pgx')).toThrow(/Expected/)
  })

  it('selects atomically without losing file ownership, permissions or future update safety', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'crossgram-pgx-'))
    const file = join(tmp, 'app.yml')
    try {
      writeFileSync(file, fixture, { mode: 0o600 })
      chmodSync(file, 0o600)
      const before = statSync(file)
      expect(selectDatabaseBackendFile(file, 'pgx')).toBe(true)
      expect(selectDatabaseBackendFile(file, 'pgx')).toBe(false)
      const after = statSync(file)
      expect(after.uid).toBe(before.uid)
      expect(after.gid).toBe(before.gid)
      expect(after.mode & 0o777).toBe(0o600)
      expect(enabled(readFileSync(file, 'utf8'), 'pgx')).toBe(true)
      execFileSync(process.execPath, [join(root, 'deploy/select-database.mjs'), 'postgres', file])
      expect(readFileSync(file, 'utf8')).toBe(fixture)
      expect(() => execFileSync(process.execPath, [join(root, 'deploy/select-database.mjs'), 'sqlite', file], { stdio: 'pipe' })).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(fixture)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
