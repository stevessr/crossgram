/** @jsxImportSource solid-js */
import { t } from 'cordis-webui-solidjs/i18n'
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { BotDashboardData } from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ActionError,
  EmptyState,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'
import { botLink, copyText } from './bridge-model.js'
export default function BotsPage(props: PageProps) {
  const rpc = useRpc<BotDashboardData>(props.entryId),
    action = useAction()
  const [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0),
    [copied, setCopied] = createSignal('')
  const bots = createMemo(() =>
    (rpc.data.bots ?? []).filter((bot) =>
      (bot.title + ' ' + bot.username + ' ' + bot.sourcePlugin)
        .toLowerCase()
        .includes(search().toLowerCase()),
    ),
  )
  return (
    <>
      <PageHeader
        title={t("Your bots")}
        description={t("Handy companions for your connected workspace.")}
        actions={
          <button
            class="button outlined"
            disabled={action.busy() || !rpc.ready}
            onClick={() => void action.run(() => rpc.data.refreshBots())}
          >{t("Refresh bots")}</button>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <label class="field account-search">
          <span>{t("Find a bot")}</span>
          <input
            type="search"
            value={search()}
            onInput={(event) => {
              setSearch(event.currentTarget.value)
              setPage(0)
            }}
          />
        </label>
        <div class="bot-grid">
          <For each={bots().slice(page() * 24, (page() + 1) * 24)}>
            {(bot) => (
              <article class="panel bot-card">
                <span class="bot-monogram" aria-hidden="true">
                  {bot.title.trim()[0] ?? 'B'}
                </span>
                <div>
                  <h2>{bot.title}</h2>
                  <code>@{bot.username}</code>
                  <p>{bot.sourcePlugin}</p>
                </div>
                <Show
                  when={botLink(bot.username)}
                  keyed
                  fallback={
                    <p class="notice error">{t("This bot has an invalid username.")}</p>
                  }
                >
                  {(link) => (
                    <div class="toolbar">
                      <a
                        class="button filled"
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >{t("Open in Telegram")}</a>
                      <button
                        class="button outlined"
                        onClick={() =>
                          void action.run(async () => {
                            await copyText(link)
                            setCopied(bot.username)
                          })
                        }
                      >
                        {copied() === bot.username
                          ? 'Link copied'
                          : 'Copy link'}
                      </button>
                    </div>
                  )}
                </Show>
              </article>
            )}
          </For>
        </div>
        <Show when={!bots().length}>
          <section class="panel empty-state">
            <h2>{t("No matching bots")}</h2>
            <p>{t("Enabled bridge bot providers will appear here automatically.")}</p>
          </section>
        </Show>
        <div class="pagination">
          <button
            class="button outlined"
            disabled={page() === 0}
            onClick={() => setPage(page() - 1)}
          >{t("Previous page")}</button>
          <span>{bots().length} bots</span>
          <button
            class="button outlined"
            disabled={(page() + 1) * 24 >= bots().length}
            onClick={() => setPage(page() + 1)}
          >{t("Next page")}</button>
        </div>
      </LiveContent>
    </>
  )
}
