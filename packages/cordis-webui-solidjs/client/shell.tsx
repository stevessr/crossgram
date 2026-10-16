/** @jsxImportSource solid-js */
import { t } from './i18n.js'
import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  Suspense,
  onCleanup,
  For,
  Show,
} from 'solid-js'
import { Icon } from './icons.js'
import { PageHeader } from './components.js'
import {
  listPages,
  orderOf,
  PageOutlet,
  reconcileExtensions,
} from './registry.js'
import { approveNavigation, navigate, useConnection } from './sdk.js'

const SettingsPage = lazy(() => import('./pages/settings.js'))

const statusLabels: Record<string, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
}

export function App(props: { initialNotice?: string } = {}) {
  const [initialNotice, setInitialNotice] = createSignal(props.initialNotice)
  const connection = useConnection()
  createEffect(() => reconcileExtensions(connection.state.entries))
  const [path, setPath] = createSignal(
    location.pathname.slice(connection.config.uiPath.length) || '/',
  )
  const [menu, setMenu] = createSignal(false)
  const media = matchMedia('(max-width: 820px)')
  const [mobile, setMobile] = createSignal(media.matches)
  let navigation!: HTMLElement, menuButton!: HTMLButtonElement
  const mediaChanged = () => setMobile(media.matches)
  media.addEventListener('change', mediaChanged)
  onCleanup(() => media.removeEventListener('change', mediaChanged))
  createEffect(() => {
    if (menu() && mobile())
      navigation.querySelector<HTMLElement>('a, button')?.focus()
  })
  const closeMenu = () => {
    setMenu(false)
    menuButton?.focus()
  }
  const trapFocus = (event: KeyboardEvent) => {
    if (!menu() || !mobile()) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      return
    }
    if (event.key !== 'Tab') return
    const elements = Array.from(
      navigation.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled)',
      ),
    )
    const first = elements[0],
      last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
  const updatePath = () => {
    setPath(location.pathname.slice(connection.config.uiPath.length) || '/')
    setMenu(false)
  }
  window.addEventListener('popstate', updatePath)
  onCleanup(() => window.removeEventListener('popstate', updatePath))
  const go = (route: string) => navigate(connection.config.uiPath + route)
  const pages = createMemo(() => listPages(connection.state.entries))
  // Utility pages (e.g. the Matrix SSO callback) stay routable but out of nav.
  const visiblePages = createMemo(() => pages().filter((page) => !page.hidden))
  const groups = createMemo(() =>
    [...new Set(visiblePages().map((page) => page.group ?? 'Extensions'))].sort(
      (left, right) => orderOf(left) - orderOf(right),
    ),
  )
  const entries = createMemo(() => Object.entries(connection.state.entries))
  const status = () => connection.state.status
  const currentTitle = createMemo(() => {
    if (path() === '/') return t('Overview')
    if (path() === '/settings') return t('Appearance')
    const page = pages()
      .filter(
        (page) => path() === page.path || path().startsWith(page.path + '/'),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (page) return t(page.title)
    return path()
      .replace(/^\//, '')
      .split(/[/-]/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ')
  })
  const isSelected = (target: string) =>
    path() === target || (target !== '/' && path().startsWith(target + '/'))
  return (
    <div class="app-shell">
      <a class="skip-link" href="#main">{t("Skip to main content")}</a>
      <Show when={menu()}>
        <button
          class="nav-scrim"
          aria-label={t("Close navigation")}
          onClick={closeMenu}
        />
      </Show>
      <aside
        ref={navigation}
        inert={mobile() && !menu()}
        onKeyDown={trapFocus}
        role={mobile() && menu() ? 'dialog' : undefined}
        aria-modal={mobile() && menu() ? true : undefined}
        class="navigation"
        classList={{ open: menu() }}
        aria-label={t("Primary navigation")}
      >
        <a
          class="brand"
          href={connection.config.uiPath + '/'}
          onClick={(event) => {
            event.preventDefault()
            go('/')
          }}
        >
          <span class="brand-mark" aria-hidden="true">
            {connection.config.title.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {connection.config.title}
            <small>{t("Relay console")}</small>
          </span>
        </a>
        <nav aria-label={t("Workspace")}>
          <button
            class="nav-item"
            classList={{ selected: isSelected('/') }}
            aria-current={isSelected('/') ? 'page' : undefined}
            onClick={() => go('/')}
          >
            <Icon name="overview" size={18} />{t("Overview")}</button>
          <For each={groups()}>
            {(group) => (
              <>
                <div class="nav-label">{t(group)}</div>
                <For each={visiblePages().filter((page) => page.group === group)}>
                  {(page) => (
                    <button
                      class="nav-item"
                      classList={{ selected: isSelected(page.path) }}
                      aria-current={isSelected(page.path) ? 'page' : undefined}
                      onClick={() => go(page.path)}
                    >
                      <Icon name={page.icon} size={18} />
                      {t(page.title)}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </nav>
        <div class="nav-spacer" />
        <div class="sidebar-footer">
          <button
            class="nav-item"
            classList={{ selected: path() === '/settings' }}
            onClick={() => go('/settings')}
          >
            <Icon name="settings" size={18} />{t("Appearance")}</button>
          <div class="connection-pill" data-status={status()} role="status">
            <span
              class="status-dot"
              classList={{ online: status() === 'connected' }}
            />
            {t(statusLabels[status()] ?? status())}
          </div>
        </div>
      </aside>
      <div class="workspace" inert={mobile() && menu()}>
        <header class="topbar">
          <button
            ref={menuButton}
            class="icon-button mobile-menu"
            aria-label={t("Open navigation")}
            aria-expanded={menu()}
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
          <div class="breadcrumb">
            <button
              class="crumb-root"
              onClick={() => go('/')}
              aria-label={t("Go to overview")}
            >
              {connection.config.title}
            </button>
            <span aria-hidden="true">/</span>
            <span class="crumb-current">{currentTitle()}</span>
          </div>
          <div class="topbar-actions">
            <span
              class="topbar-status"
              data-status={status()}
              title={t("Live connection state")}
            >
              <span
                class="status-dot"
                classList={{ online: status() === 'connected' }}
              />
              {t(statusLabels[status()] ?? status())}
            </span>
            <button
              class="icon-button"
              aria-label={t("Appearance settings")}
              onClick={() => go('/settings')}
            >
              <Icon name="palette" />
            </button>
          </div>
        </header>
        <main id="main" tabindex="-1">
          <Show when={initialNotice()}>
            <div class="notice error" role="alert">
              <Icon name="alert" />
              <span>{initialNotice()}</span>
              <button
                class="button outlined"
                onClick={() => setInitialNotice(undefined)}
              >{t("Dismiss")}</button>
            </div>
          </Show>
          <Show when={connection.state.updateAvailable}>
            <div class="notice" role="status">
              <Icon name="info" />
              <span>{t("A new WebUI build is ready to load.")}</span>
              <button
                class="button filled"
                onClick={() => {
                  if (approveNavigation()) location.reload()
                }}
              >{t("Reload")}</button>
            </div>
          </Show>
          <Show when={connection.state.error}>
            <div class="notice error" role="alert">
              <Icon name="alert" />
              <span>{connection.state.error}</span>
            </div>
          </Show>
          <Show when={status() === 'reconnecting'}>
            <div class="notice" role="status">
              <Icon name="refresh" />
              <span>
                Reconnecting. Your position is saved and actions resume
                automatically.
              </span>
            </div>
          </Show>
          <Show
            when={path() === '/'}
            fallback={
              <Show
                when={path() === '/settings'}
                fallback={<PageOutlet path={path()} />}
              >
                <Suspense
                  fallback={<div class="loading">{t("Opening appearance…")}</div>}
                >
                  <SettingsPage />
                </Suspense>
              </Show>
            }
          >
            <PageHeader
              title={t("Overview")}
              description={t("Everything this relay is running, and every page it exposes.")}
            />
            <section class="stat-row" aria-label={t("Workspace summary")}>
              <article class="panel stat-tile">
                <Icon name="plug" />
                <div class="stat-tile-body">
                  <span class="eyebrow">{t("Connection")}</span>
                  <strong>{t(statusLabels[status()] ?? status())}</strong>
                  <span>{t("Live Muon channel")}</span>
                </div>
              </article>
              <article class="panel stat-tile">
                <Icon name="layers" />
                <div class="stat-tile-body">
                  <span class="eyebrow">{t("Extensions")}</span>
                  <strong>{entries().length}</strong>
                  <span>
                    {visiblePages().length} {visiblePages().length === 1 ? t("page") : t("pages")}{' '}
                    available
                  </span>
                </div>
              </article>
              <article class="panel stat-tile">
                <Icon name="cpu" />
                <div class="stat-tile-body">
                  <span class="eyebrow">{t("Build")}</span>
                  <strong>{connection.config.buildId ?? t("development")}</strong>
                  <span>{t("Reload prompt when it changes")}</span>
                </div>
              </article>
            </section>
            <Show
              when={visiblePages().length}
              fallback={
                <section class="panel empty-state">
                  <Icon name="plugins" size={22} />
                  <h2>{t("No pages yet")}</h2>
                  <p>{t("Enabled plugins register their pages here automatically.")}</p>
                  <button class="button filled" onClick={() => go('/plugins')}>{t("Open plugin manager")}</button>
                </section>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <section>
                    <div class="section-heading">
                      <h2>{t(group)}</h2>
                      <span class="muted">
                        {visiblePages().filter((page) => page.group === group).length}{' '}
                        {visiblePages().filter((page) => page.group === group)
                          .length === 1
                          ? 'page'
                          : 'pages'}
                      </span>
                    </div>
                    <div class="page-grid">
                      <For
                        each={visiblePages().filter((page) => page.group === group)}
                      >
                        {(page) => (
                          <button
                            class="page-card"
                            onClick={() => go(page.path)}
                          >
                            <span class="page-card-icon">
                              <Icon name={page.icon} size={18} />
                            </span>
                            <span class="page-card-body">
                              <strong>{t(page.title)}</strong>
                              <small>{t(page.source)}</small>
                            </span>
                            <Icon name="chevronRight" size={16} />
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </Show>
        </main>
        <footer class="footer">
          <span>{connection.config.title}</span>
          <span aria-hidden="true">·</span>
          <span>
            WebUI build{' '}
            <code>{connection.config.buildId ?? t("development")}</code>
          </span>
        </footer>
      </div>
    </div>
  )
}
