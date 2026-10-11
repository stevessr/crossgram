# Crossgram Telegram CDN front Worker

Cloudflare Worker reverse-proxy front door for a separately deployed
`crossgram-telegram` origin. It forwards the original path/query, request body,
and application headers to one configured HTTPS origin; it does **not** add
cache rules or rewrite Telegram/CDN semantics. Keep downloads and authenticated
responses uncached unless the upstream explicitly publishes cache-safe content.

## Deploy

1. Set `CROSSGRAM_TELEGRAM_ORIGIN` in `wrangler.toml` (or as a Worker variable)
   to the actual public HTTPS origin serving `crossgram-telegram`.
2. Route a dedicated CDN hostname to this Worker and configure the upstream to
   accept that hostname in its trusted proxy/host settings if needed.
3. Deploy with `wrangler deploy` from this directory. Do not place credentials
   in the URL; configure upstream authentication separately as a Worker secret
   and add a narrowly-scoped authorization policy if your deployment requires it.

The Worker refuses non-HTTPS, credential-bearing, or non-origin upstream URLs,
so a request cannot turn it into an arbitrary URL proxy. It forwards WebSocket
upgrade requests without translation; verify the target runtime's WebSocket
proxy support before routing a WebSocket endpoint through this Worker.

## Tests

From the repository root:

```sh
corepack yarn exec vitest run packages/telegram-cdn-worker/src/index.test.ts --config vitest.config.mts
corepack yarn exec vitest run packages/telegram-cdn-worker/worker.e2e.test.ts --config vitest.mtproto-e2e.config.mts --maxWorkers=1
```

The E2E test exercises the default exported Worker handler with streamed request
and response bodies against a deterministic mocked upstream; it does not claim
that a live Cloudflare deployment or real `crossgram-telegram` origin has been
verified.
