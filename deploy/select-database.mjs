import { chmodSync, chownSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// PGX speaks the PostgreSQL wire protocol, so both backends use the same Cordis driver.
// This selector modifies only the two explicitly named production driver entries.
// It does not migrate or copy data between database engines.
const backends = ['postgres', 'pgx']
const driverName = "name: '@cordisjs/plugin-database-postgres'"

function driverRange(lines, backend) {
  const id = '    - id: database-' + backend
  const start = lines.findIndex((line) => line.trimEnd() === id)
  if (start < 0) throw new Error('Database entry not found: database-' + backend)
  let end = start + 1
  while (end < lines.length && !/^ {0,4}- id: /.test(lines[end])) end++
  const block = lines.slice(start, end)
  if (!block.some((line) => line.trim() === driverName)) {
    throw new Error('Expected PostgreSQL-compatible Cordis driver in ' + id.trim())
  }
  if (block.filter((line) => /^      disabled:\s*(true|false)\s*$/.test(line)).length > 1) {
    throw new Error('Multiple disabled flags in ' + id.trim())
  }
  return { start, end, block }
}

export function selectDatabaseBackend(source, backend) {
  if (!backends.includes(backend)) throw new Error('backend must be postgres or pgx')
  const lines = source.split('\n')
  // Check both entries before making any change. Refuse incompatible/custom templates.
  for (const target of backends) driverRange(lines, target)

  for (const target of backends) {
    const { start, end, block } = driverRange(lines, target)
    const active = target === backend
    const disabled = block.findIndex((line) => /^      disabled:\s*(true|false)\s*$/.test(line))
    if (active && disabled >= 0) {
      block.splice(disabled, 1)
    } else if (!active && disabled >= 0) {
      block[disabled] = '      disabled: true'
    } else if (!active) {
      const name = block.findIndex((line) => line.trim() === driverName)
      block.splice(name + 1, 0, '      disabled: true')
    }
    lines.splice(start, end - start, ...block)
  }
  return lines.join('\n')
}

export function selectDatabaseBackendFile(path, backend) {
  const previous = statSync(path)
  const source = readFileSync(path, 'utf8')
  const next = selectDatabaseBackend(source, backend)
  if (next === source) return false

  const temporary = path + '.tmp-' + process.pid
  try {
    writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600 })
    chownSync(temporary, previous.uid, previous.gid)
    chmodSync(temporary, previous.mode & 0o777)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backend = process.argv[2]
  const path = process.argv[3] || '/opt/crossgram/.runtime/app.yml'
  try {
    const changed = selectDatabaseBackendFile(path, backend)
    console.log(changed ? 'Selected ' + backend + ' for ' + path : 'Already using ' + backend)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
