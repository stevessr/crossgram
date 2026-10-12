/** @jsxImportSource solid-js */
import { t } from '../i18n.js'
import { createSignal, For } from 'solid-js'
import {
  applyAppearance,
  readAppearance,
  type Appearance,
  type Palette,
} from '../appearance.js'
import { PageHeader } from '../components.js'
import { language, setLanguage, type Language } from '../i18n.js'
export default function SettingsPage() {
  const initial = readAppearance()
  const [appearance, setAppearance] = createSignal(initial.appearance),
    [palette, setPalette] = createSignal(initial.palette)
  const update = (mode: Appearance, color: Palette) => {
    setAppearance(mode)
    setPalette(color)
    applyAppearance(mode, color)
  }
  return (
    <>
      <PageHeader
        title={t("Make yourself at home")}
        description={t("A little more you. A little less noise.")}
      />
      <section class="panel stack settings-panel">
        <h2>{t("Appearance")}</h2>
        <label class="field">
          <span>{t("Color mode")}</span>
          <select
            aria-label={t("Color mode")}
            value={appearance()}
            onChange={(event) =>
              update(event.currentTarget.value as Appearance, palette())
            }
          >
            <option value="system">{t("Follow your device")}</option>
            <option value="light">{t("Light")}</option>
            <option value="dark">{t("Dark")}</option>
          </select>
        </label>
        <label class="field">
          <span>{t('Interface language')}</span>
          <select
            aria-label={t('Interface language')}
            value={language()}
            onChange={(event) => setLanguage(event.currentTarget.value as Language)}
          >
            <option value="en-US">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        <fieldset class="palette-options">
          <legend>{t("Workspace color")}</legend>
          <For each={['sage', 'ocean', 'rose'] as const}>
            {(color) => (
              <label>
                <input
                  type="radio"
                  name="palette"
                  value={color}
                  checked={palette() === color}
                  onChange={() => update(appearance(), color)}
                />
                <span class={'color-sample ' + color} />
                <span>{t(color)}</span>
              </label>
            )}
          </For>
        </fieldset>
        <p class="muted">{t("Saved only on this device. Reduced-motion settings are respected automatically; no external fonts or analytics are loaded.")}</p>
      </section>
    </>
  )
}
