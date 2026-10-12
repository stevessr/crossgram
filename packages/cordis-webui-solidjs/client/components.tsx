/** @jsxImportSource solid-js */
import { t } from './i18n.js'
import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { Icon, type IconName } from './icons.js'
import { useConnection } from './sdk.js'
export function PageHeader(props: {
  eyebrow?: string
  icon?: IconName
  title: string
  description?: string
  actions?: JSX.Element
}) {
  return (
    <header class="page-heading">
      <div class="page-title">
        <Show when={t(props.eyebrow!)}>
          <span class="eyebrow">{t(props.eyebrow!)}</span>
        </Show>
        <h1>
          <Show when={props.icon}>
            <Icon name={props.icon!} size={22} />
          </Show>
          {t(props.title)}
        </h1>
        <Show when={t(props.description ?? '')}>
          <p class="muted">{t(props.description ?? '')}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="toolbar">{props.actions}</div>
      </Show>
    </header>
  )
}

/** Shared empty state so every page explains itself the same way. */
export function EmptyState(props: {
  icon?: IconName
  title: string
  description?: string
  action?: JSX.Element
}) {
  return (
    <section class="panel empty-state">
      <Icon name={props.icon ?? 'sparkle'} size={22} />
      <h2>{t(props.title)}</h2>
      <Show when={t(props.description ?? '')}>
        <p>{t(props.description ?? '')}</p>
      </Show>
      {props.action}
    </section>
  )
}
export function useAction() {
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal('')
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  return {
    busy,
    error,
    clear: () => setError(''),
    run: async <T,>(action: () => Promise<T>) => {
      if (busy()) return
      setBusy(true)
      setError('')
      try {
        return await action()
      } catch (error) {
        if (!disposed)
          setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed) setBusy(false)
      }
    },
  }
}
export function ActionError(props: { error: string }) {
  return (
    <Show when={props.error}>
      <div class="notice error" role="alert">
        <Icon name="alert" />
        <span>{props.error}</span>
      </div>
    </Show>
  )
}
export function LiveContent(props: { ready: boolean; children: JSX.Element }) {
  const [loaded, setLoaded] = createSignal(false)
  createEffect(() => {
    if (props.ready) setLoaded(true)
  })
  return (
    <Show
      when={loaded()}
      fallback={
        <div class="loading" role="status">
          <Icon name="refresh" size={18} />{t("Loading live data…")}</div>
      }
    >
      <div classList={{ 'data-stale': !props.ready }}>{props.children}</div>
    </Show>
  )
}
export function Modal(props: {
  title: string
  children: JSX.Element
  onClose: () => void
}) {
  let dialog!: HTMLDialogElement
  createEffect(() => {
    dialog.showModal()
  })
  onCleanup(() => dialog.close())
  return (
    <dialog
      ref={dialog}
      class="modal"
      aria-label={t(props.title)}
      onCancel={(event) => {
        event.preventDefault()
        props.onClose()
      }}
      onClick={(event) => {
        if (event.target === dialog) props.onClose()
      }}
    >
      <div class="modal-content">
        <header class="toolbar">
          <h2>{t(props.title)}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label={t("Close dialog")}
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
export function ConfirmAction(props: {
  label: string
  title: string
  description: string
  action: () => Promise<void>
  disabled?: boolean
  danger?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const action = useAction()
  const connection = useConnection()
  return (
    <>
      <button
        class={'button ' + (props.danger ? 'danger' : 'outlined')}
        disabled={props.disabled || connection.state.status !== 'connected'}
        onClick={() => setOpen(true)}
      >
        {t(props.label)}
      </button>
      <Show when={open()}>
        <Modal
          title={t(props.title)}
          onClose={() => {
            if (!action.busy()) setOpen(false)
          }}
        >
          <p>{t(props.description ?? '')}</p>
          <ActionError error={action.error()} />
          <div class="toolbar">
            <button
              class={'button ' + (props.danger ? 'danger' : 'filled')}
              disabled={action.busy()}
              onClick={() =>
                void action.run(async () => {
                  await props.action()
                  setOpen(false)
                })
              }
            >
              {action.busy() ? t("Working…") : props.label}
            </button>
            <button
              class="button outlined"
              disabled={action.busy()}
              onClick={() => setOpen(false)}
            >{t("Cancel")}</button>
          </div>
        </Modal>
      </Show>
    </>
  )
}
export function JsonView(props: { value: unknown }) {
  return (
    <pre>
      <code>{JSON.stringify(props.value, null, 2)}</code>
    </pre>
  )
}
export function formatBytes(value = 0) {
  if (!Number.isFinite(value)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let index = 0
  while (value >= 1024 && index < 4) {
    value /= 1024
    index++
  }
  return (
    value.toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 }) +
    ' ' +
    units[index]
  )
}
export function formatNumber(value = 0) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}
