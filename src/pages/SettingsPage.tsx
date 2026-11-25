import { useEffect, useState, type ReactElement } from 'react'
import { Panel, StatusLine } from '../components.js'
import { getThemePreference, setThemePreference, type ThemePreference } from '../theme.js'

/** 设置页：应用自身配置（外观主题等）。业务配置在各自页面编辑。 */

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; swatch: string }> = [
  { id: 'dark', label: '深色', swatch: '#141519' },
  { id: 'light', label: '浅色', swatch: '#f2f4f8' },
  { id: 'system', label: '跟随系统', swatch: 'linear-gradient(90deg,#141519 50%,#f2f4f8 50%)' },
]

export function SettingsPage(): ReactElement {
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference())
  const [note, setNote] = useState('')
  const [noteTone, setNoteTone] = useState<'ok' | 'error'>('ok')

  useEffect(() => {
    setTheme(getThemePreference())
  }, [])

  function changeTheme(preference: ThemePreference): void {
    setThemePreference(preference)
    setTheme(preference)
    setNoteTone('ok')
    setNote(`外观已切换为${THEME_OPTIONS.find((option) => option.id === preference)?.label ?? preference}。`)
  }

  return (
    <>
      <div className="page-head--bar">
        <h1>设置</h1>
        <span className="page-head__meta">只放软件配置 · 平台账号在各功能页登录管理</span>
      </div>
      <div className="workbench workbench--single">
        <div className="workbench__main main-narrow">
          <Panel title="外观">
            <div className="theme-grid">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={`theme-card${theme === option.id ? ' theme-card--active' : ''}`}
                  onClick={() => changeTheme(option.id)}
                >
                  <span className="theme-swatch" style={{ background: option.swatch }} />
                  <span className="theme-label">{option.label}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="关于">
            <p className="path">{`XTS 报告上传 · v0.3.0`}</p>
            <p className="path">凭据保存在本机用户数据目录（0600 / DPAPI 加密）；业务脚本与 DSH 插件同源。</p>
          </Panel>

          {note ? <StatusLine tone={noteTone}>{note}</StatusLine> : null}
        </div>
      </div>
    </>
  )
}
