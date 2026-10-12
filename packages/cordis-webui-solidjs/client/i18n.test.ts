import { afterEach, describe, expect, it, vi } from 'vitest'
import { language, languageStorageKey, setLanguage, t } from './i18n.js'
afterEach(() => {
  vi.restoreAllMocks()
  setLanguage('en-US')
  localStorage.clear()
})
describe('WebUI language selection', () => {
  it('translates labels and persists an explicit selection', () => {
    setLanguage('zh-CN')
    expect(language()).toBe('zh-CN')
    expect(t('Overview')).toBe('概览')
    expect(t('Platform accounts')).toBe('平台账号')
    expect(t('Untranslated plugin name')).toBe('Untranslated plugin name')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem(languageStorageKey)).toBe('zh-CN')
    setLanguage('en-US')
    expect(t('Overview')).toBe('Overview')
  })
  it('works when storage access is denied', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage denied') })
    expect(() => setLanguage('zh-CN')).not.toThrow()
    expect(t('Database')).toBe('数据库')
  })
})
