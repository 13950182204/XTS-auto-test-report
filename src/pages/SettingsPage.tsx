import { useEffect, useState, type ReactElement } from 'react'
import { request } from '../api.js'
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
  const [guideBusy, setGuideBusy] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    setTheme(getThemePreference())
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; version?: string }>('app/info', 'GET')
      if (active && response.ok && response.version) setVersion(response.version)
    })()
    return () => { active = false }
  }, [])

  function changeTheme(preference: ThemePreference): void {
    setThemePreference(preference)
    setTheme(preference)
    setNoteTone('ok')
    setNote(`外观已切换为${THEME_OPTIONS.find((option) => option.id === preference)?.label ?? preference}。`)
  }

  async function openGuide(): Promise<void> {
    setGuideBusy(true)
    const response = await request<{ ok: boolean; message?: string }>('guide/open', 'POST')
    setGuideBusy(false)
    if (response.ok) {
      setNoteTone('ok')
      setNote('已用系统默认浏览器打开使用教程。')
      return
    }
    setNoteTone('error')
    setNote(String(response.message ?? '打开教程失败。'))
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

          <Panel title="帮助">
            <div className="row-top">
              <span className="name">完整使用教程</span>
              <span className="pct push-right">带交互引导的图文说明</span>
            </div>
            <p className="path">从登录到报告复审的完整流程：每个按钮在哪、判定口径怎么算、常见问题怎么排。</p>
            <div className="row-actions">
              <button className="btn" disabled={guideBusy} onClick={() => void openGuide()}>{guideBusy ? '正在打开…' : '打开教程'}</button>
            </div>
          </Panel>

          <Panel title="关于">
            <p className="path">{`XTS 报告上传 · v${version || '—'}`}</p>
            <p className="path">凭据保存在本机用户数据目录（0600 / DPAPI 加密）；业务脚本与 DSH 插件同源。</p>
          </Panel>

          {note ? <StatusLine tone={noteTone}>{note}</StatusLine> : null}
        </div>
      </div>
    </>
  )
}
