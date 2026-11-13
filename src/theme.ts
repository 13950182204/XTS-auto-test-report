/** 应用外观配置：主题（深色/浅色/跟随系统），持久化在 localStorage。 */

export type ThemePreference = 'dark' | 'light' | 'system'

const KEY = 'app.theme'

export function getThemePreference(): ThemePreference {
  const value = window.localStorage.getItem(KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark'
}

export function setThemePreference(preference: ThemePreference): void {
  window.localStorage.setItem(KEY, preference)
  applyTheme(preference)
}

export function applyTheme(preference: ThemePreference): void {
  const resolved = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : preference
  document.documentElement.dataset.theme = resolved
}

/** 启动时应用已保存的主题；跟随系统时监听系统切换。 */
export function initTheme(): void {
  applyTheme(getThemePreference())
  const media = window.matchMedia('(prefers-color-scheme: light)')
  media.addEventListener('change', () => {
    if (getThemePreference() === 'system') applyTheme('system')
  })
}
