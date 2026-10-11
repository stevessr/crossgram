const MAX_URL_LENGTH = 8192
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

function upstreamOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('CROSSGRAM_TELEGRAM_ORIGIN must be an HTTPS origin')
  }
  return url
}

function copyHeaders(source) {
  const headers = new Headers(source)
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)
  const connection = source.get('Connection')
  if (connection) {
    for (const name of connection.split(',')) headers.delete(name.trim())
  }
  return headers
}

export function createWorker({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      let origin
      try {
        origin = upstreamOrigin(env.CROSSGRAM_TELEGRAM_ORIGIN)
      } catch {
        return new Response('Worker upstream is not configured', { status: 500 })
      }

      const incoming = new URL(request.url)
      if (incoming.href.length > MAX_URL_LENGTH) return new Response('URI too long', { status: 414 })
      if (request.method === 'CONNECT' || request.method === 'TRACE') return new Response('Method not allowed', { status: 405 })

      const target = new URL(incoming.pathname + incoming.search, origin)
      const headers = copyHeaders(request.headers)
      headers.set('Host', origin.host)
      headers.set('X-Forwarded-Host', incoming.host)
      headers.set('X-Forwarded-Proto', incoming.protocol.slice(0, -1))

      const init = {
        method: request.method,
        headers,
        redirect: 'manual',
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body
      if (request.method !== 'GET' && request.method !== 'HEAD') init.duplex = 'half'

      let response
      try {
        response = await fetchImpl(new Request(target, init))
      } catch {
        return new Response('Upstream unavailable', { status: 502 })
      }

      const responseHeaders = copyHeaders(response.headers)
      responseHeaders.set('X-Content-Type-Options', 'nosniff')
      responseHeaders.set('Referrer-Policy', 'no-referrer')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    },
  }
}

export default createWorker()
