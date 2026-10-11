import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { TelegramClient } from '@mtcute/node'
import { prepareStorage } from './storage.js'

const apiId = Number(process.env.TELEGRAM_API_ID)
const apiHash = process.env.TELEGRAM_API_HASH
const storage = process.env.TELEGRAM_STORAGE
if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash || !storage) {
  throw new Error('Set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_STORAGE to a private session path')
}
process.umask(0o077)
const client = new TelegramClient({ apiId, apiHash, storage: await prepareStorage(storage), logLevel: 0 })
try {
  const me = await client.start({
    phone: () => readLine('Telegram phone > '),
    code: () => readLine('Telegram code > '),
    password: readPassword,
  })
  if (me.isBot) throw new Error('A Telegram user account is required')
  console.log(`Telegram account authorized: ${me.id}. Session stored locally; no credentials printed.`)
} finally { await client.destroy() }

function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('2FA password entry requires an interactive terminal')
  process.stdout.write('Telegram 2FA password (hidden) > ')
  const muted = new Writable({ write(_chunk, _encoding, done) { done() } })
  const input = createInterface({ input: process.stdin, output: muted, terminal: true })
  return new Promise((resolve, reject) => {
    input.once('SIGINT', () => { input.close(); reject(new Error('Telegram login cancelled')) })
    input.question('', (answer) => { input.close(); process.stdout.write('\n'); resolve(answer) })
  })
}

function readLine(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve, reject) => {
    input.once('SIGINT', () => { input.close(); reject(new Error('Telegram login cancelled')) })
    input.question(prompt, (answer) => { input.close(); resolve(answer) })
  })
}
