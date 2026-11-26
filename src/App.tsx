import { useEffect, useState, type ReactElement } from 'react'
import { request, useStatusPolling, type DeviceState, type RunState, type TestState } from './api.js'
import { Bar, asRecord, clampPercent, num, str } from './components.js'
import { initTheme } from './theme.js'
import { TestBoxPage } from './pages/Devices.js'
import { MaterialsPage } from './pages/Materials.js'
import { TestRunnerPage } from './pages/TestRunner.js'
import { MirrorPage } from './pages/Mirror.js'
import { WaiverPage } from './pages/Waiver.js'
import { ReportReviewPage } from './pages/ReportReview.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { OverviewPage } from './pages/Overview.js'
import { LoginPage } from './pages/Login.js'

type PageId = 'overview' | 'devices' | 'materials' | 'test' | 'mirror' | 'waiver' | 'review' | 'settings'

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'overview', label: '概览', icon: '◆' },
  { id: 'devices', label: '测试盒子', icon: '⇄' },
  { id: 'materials', label: '评测资料', icon: '▤' },
  { id: 'test', label: 'XTS 自动测试', icon: '▶' },
  { id: 'mirror', label: '镜像固件上传', icon: '⬆' },
  { id: 'waiver', label: '豁免资料', icon: '✎' },
  { id: 'review', label: '报告复审', icon: '✓' },
  { id: 'settings', label: '设置', icon: '⚙' },
]

type Auth = { checked: boolean; loggedIn: boolean; username: string }

/** 登录门：未登录只渲染登录页；已登录进主界面（侧边栏底部可退出账号）。 */
export function App(): ReactElement {
  const [auth, setAuth] = useState<Auth>({ checked: false, loggedIn: false, username: '' })
  const [page, setPage] = useState<PageId>('overview')
  const [status, setStatus] = useState<{ state: RunState; test: TestState; device: DeviceState }>({ state: { phase: 'idle' }, test: { phase: 'idle' }, device: { phase: 'idle' } })
  const [logoutArmed, setLogoutArmed] = useState(false)

  useEffect(() => {
    initTheme()
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; loggedIn?: boolean; username?: string }>('auth/status', 'GET')
      if (active && response.ok) {
        setAuth({ checked: true, loggedIn: response.loggedIn === true, username: response.username ?? '' })
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!auth.loggedIn) return undefined
    return useStatusPolling((state, test, device) => setStatus({ state, test, device }))
  }, [auth.loggedIn])

  async function doLogout(): Promise<void> {
    await request('auth/logout', 'POST')
    setLogoutArmed(false)
    setStatus({ state: { phase: 'idle' }, test: { phase: 'idle' }, device: { phase: 'idle' } })
    setAuth({ checked: true, loggedIn: false, username: '' })
    setPage('overview')
  }

  if (!auth.checked) {
    return (
      <div className="login">
        <p className="empty">正在启动…</p>
      </div>
    )
  }
  if (!auth.loggedIn) {
    return <LoginPage onLoggedIn={(username) => setAuth({ checked: true, loggedIn: true, username })} />
  }

  const { state, test, device } = status
  const running = state.phase !== 'idle' || test.phase === 'running' || test.phase === 'stopping' || device.phase === 'pairing'
  const progress = asRecord(state.progress)
  const percent = clampPercent(num(progress?.percent))
  const testPercent = clampPercent(num(asRecord(test.progress)?.percent))
  const taskPercent = state.phase !== 'idle' ? percent : test.phase === 'running' ? testPercent : undefined
  const taskLabel = state.phase !== 'idle'
    ? ({ preflight: '预检中', saving: '资料任务执行中', uploading: '固件上传中' } as Record<string, string>)[state.phase] ?? '任务执行中'
    : test.phase === 'running' ? 'XTS 自动测试进行中' : test.phase === 'stopping' ? '正在停止测试'
    : device.phase === 'pairing' ? '设备配网中' : ''

  let body: ReactElement
  if (page === 'devices') body = <TestBoxPage device={device} />
  else if (page === 'materials') body = <MaterialsPage state={state} test={test} reloadTick={0} />
  else if (page === 'test') body = <TestRunnerPage state={state} test={test} />
  else if (page === 'mirror') body = <MirrorPage state={state} />
  else if (page === 'waiver') body = <WaiverPage state={state} />
  else if (page === 'review') body = <ReportReviewPage />
  else if (page === 'settings') body = <SettingsPage />
  else body = <OverviewPage state={state} test={test} onNavigate={setPage} />

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__logo">XT</span>
          <span className="sidebar__brand-name"><b>XTS 报告上传</b><span>OpenHarmony 兼容性助手</span></span>
        </div>
        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <button key={item.id} className={`sidebar__item${page === item.id ? ' active' : ''}`} onClick={() => setPage(item.id)}>
              <span className="ico">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">
          <span className="sidebar__account">{`账号 ${auth.username || '（未设置）'}`}</span>
          {logoutArmed ? (
            <div className="row-actions">
              <button className="btn btn--small btn--danger" onClick={() => void doLogout()}>确认退出</button>
              <button className="btn btn--small" onClick={() => setLogoutArmed(false)}>取消</button>
            </div>
          ) : (
            <button className="btn btn--small" onClick={() => setLogoutArmed(true)}>退出账号</button>
          )}
          <span>{`本地任务 ${state.phase === 'idle' && test.phase === 'idle' ? '空闲' : '执行中'}`}</span>
        </div>
      </aside>
      <main className="content">
        {taskLabel ? (
          <div className={`taskbar${running ? '' : ' idle'}`}>
            <span className="taskbar__label">{taskLabel}</span>
            {taskPercent !== undefined ? <div className="bar"><div style={{ width: `${taskPercent}%` }} /></div> : null}
            <span className="taskbar__meta">{str(asRecord(state.progress)?.detail) || str(asRecord(test.progress)?.detail) || ''}</span>
          </div>
        ) : null}
        <div className="page-host">{body}</div>
      </main>
    </div>
  )
}
