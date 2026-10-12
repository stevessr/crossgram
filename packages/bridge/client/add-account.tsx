/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Modal, ActionError, useAction } from 'cordis-webui-solidjs/components'
import { useConnection } from 'cordis-webui-solidjs/client'
import {
  ACCOUNT_PROVIDERS, buildAccountConfiguration, createPlatformPlugin,
  findLoaderEntry, initialAccountDraft,
  type AccountDraft, type AccountPlatform,
} from './account-creation-model.js'

interface FieldProps {
  label: string
  value: string
  onInput: (value: string) => void
  placeholder?: string
  secret?: boolean
  disabled?: boolean
  hint?: string
}

function Field(props: FieldProps) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type={props.secret ? 'password' : 'text'}
        autocomplete="off"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <Show when={props.hint}>
        <small class="muted">{props.hint}</small>
      </Show>
    </label>
  )
}

export default function AddAccount(props: {
  onClose: () => void
  onCreated: () => void | Promise<void>
}) {
  const connection = useConnection(),
    action = useAction()
  const [draft, setDraft] = createSignal<AccountDraft>(initialAccountDraft())
  const [touched, setTouched] = createSignal(false)
  const loaderId = createMemo(() => findLoaderEntry(connection.state.entries))
  const provider = createMemo(() => ACCOUNT_PROVIDERS.find((item) => item.id === draft().platform)!)
  const issue = createMemo(() => {
    try {
      buildAccountConfiguration(draft())
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  const change = (key: keyof AccountDraft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const disabled = () => action.busy()
  const submit = () => {
    setTouched(true)
    if (issue() || !loaderId()) return
    void action.run(async () => {
      await createPlatformPlugin(
        (id, method, args) => connection.rpc(id, method, args),
        loaderId()!,
        draft(),
      )
      // Unmount on success so the browser does not retain the typed credentials.
      setDraft(initialAccountDraft())
      await props.onCreated()
    })
  }
  return (
    <Modal title="在线添加平台账号" onClose={() => { if (!disabled()) props.onClose() }}>
      <form class="stack" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <p class="muted">选择平台，填写连接信息，创建并启用一个独立适配器实例。添加后账号会自动出现在此页面。</p>
        <label class="field">
          <span>平台类型</span>
          <select
            aria-label="平台类型"
            value={draft().platform}
            disabled={disabled()}
            onChange={(event) => {
              const platform = event.currentTarget.value as AccountPlatform
              setDraft({ ...initialAccountDraft(platform), label: draft().label })
              setTouched(false)
            }}
          >
            <For each={ACCOUNT_PROVIDERS}>
              {(item) => <option value={item.id}>{item.title}</option>}
            </For>
          </select>
        </label>
        <p class="muted" role="note">{provider().description}</p>
        <Field label="账号备注名称（可选）" value={draft().label} disabled={disabled()}
          onInput={(value) => change('label', value)} placeholder="例如：我的工作账号" />
        <Show when={draft().platform === 'qqnt'}>
          <Field label="QQNT HTTP API 地址" value={draft().endpoint} disabled={disabled()}
            onInput={(value) => change('endpoint', value)} />
          <Field label="QQNT WebSocket 地址（可选）" value={draft().webSocketEndpoint} disabled={disabled()}
            onInput={(value) => change('webSocketEndpoint', value)} />
          <Field label="QQNT 访问令牌（可选）" value={draft().token} secret disabled={disabled()}
            onInput={(value) => change('token', value)} />
        </Show>
        <Show when={draft().platform === 'discord'}>
          <Field label="Discord 用户令牌" value={draft().token} secret disabled={disabled()}
            onInput={(value) => change('token', value)}
            hint="请不要使用公开分享的令牌。Discord 的自动化用户账号可能违反服务条款。" />
          <Field label="HTTP(S) 代理地址（可选）" value={draft().proxy} disabled={disabled()}
            onInput={(value) => change('proxy', value)} placeholder="http://127.0.0.1:7890" />
        </Show>
        <Show when={draft().platform === 'matrix'}>
          <Field label="Matrix Homeserver" value={draft().homeserver} disabled={disabled()}
            onInput={(value) => change('homeserver', value)} placeholder="https://matrix.example.org" />
          <Field label="Matrix Access Token" value={draft().accessToken} secret disabled={disabled()}
            onInput={(value) => change('accessToken', value)} />
          <Field label="Matrix 用户 ID（可选）" value={draft().userId} disabled={disabled()}
            onInput={(value) => change('userId', value)} placeholder="@alice:example.org" />
          <Field label="HTTP(S) 代理地址（可选）" value={draft().proxy} disabled={disabled()}
            onInput={(value) => change('proxy', value)} placeholder="http://127.0.0.1:7890" />
        </Show>
        <Show when={draft().platform === 'wechat'}>
          <Field label="ComWeChat API 地址" value={draft().endpoint} disabled={disabled()}
            onInput={(value) => change('endpoint', value)} placeholder="http://127.0.0.1:18888/api/" />
          <Field label="回调端口（可选）" value={draft().callbackPort} disabled={disabled()}
            onInput={(value) => change('callbackPort', value)} placeholder="23456"
            hint="每个独立的微信适配器需要不同的回调端口。" />
        </Show>
        <Show when={draft().platform === 'telegram'}>
          <p class="notice" role="note">
            Telegram 适配器目前无法在浏览器首次授权。请先在服务器设置 TELEGRAM_API_ID、
            TELEGRAM_API_HASH、TELEGRAM_STORAGE，并运行
            <code> yarn tsx packages/platform-telegram/src/login.ts </code>
            完成验证码和两步验证，然后填写同一会话文件的绝对路径。
          </p>
          <Field label="Telegram API ID" value={draft().apiId} disabled={disabled()}
            onInput={(value) => change('apiId', value)} />
          <Field label="Telegram API Hash" value={draft().apiHash} secret disabled={disabled()}
            onInput={(value) => change('apiHash', value)} />
          <Field label="服务器上的会话文件路径" value={draft().storage} disabled={disabled()}
            onInput={(value) => change('storage', value)} placeholder="/var/lib/crossgram/data/telegram/account-1.session" />
        </Show>
        <Show when={!loaderId()}>
          <p class="notice error" role="alert">
            未找到在线插件管理服务。请先在 WebUI「插件」中启用 @cordisjs/plugin-loader-webui。
          </p>
        </Show>
        <Show when={touched() && issue()}>
          <p class="notice error" role="alert">{issue()}</p>
        </Show>
        <ActionError error={action.error()} />
        <div class="toolbar account-create-actions">
          <button class="button outlined" type="button" disabled={disabled()} onClick={props.onClose}>
            取消
          </button>
          <button class="button filled" type="submit" disabled={
            disabled() || Boolean(issue()) || !loaderId() || connection.state.status !== 'connected'
          }>
            {disabled() ? '正在添加…' : '添加并启用'}
          </button>
        </div>
        <small class="muted">
          凭据会保存至服务器的插件配置中；请仅在受信任的管理 WebUI 中操作。账号状态将在适配器成功登录后显示为就绪。
        </small>
      </form>
    </Modal>
  )
}
