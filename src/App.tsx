import { useEffect, useState, type ReactElement } from 'react'
import { useStatusPolling, type RunState, type TestState } from './api.js'
import { Bar, asRecord, clampPercent, num, str } from './components.js'
import { MaterialsPage } from './pages/Materials.js'
import { TestRunnerPage } from './pages/TestRunner.js'
import { MirrorPage } from './pages/Mirror.js'
import { WaiverPage } from './pages/Waiver.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { OverviewPage } from './pages/Overview.js'

type PageId = 'overview' | 'materials' | 'test' | 'mirror' | 'waiver' | 'settings'

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'overview', label: '概览', icon: '◆' },
  { id: 'materials', label: '评测资料', icon: '▤' },
  { id: 'test', label: 'XTS 自动测试', icon: '▶' },
  { id: 'mirror', label: '镜像固件上传', icon: '⬆' },
  { id: 'waiver', label: '豁免资料', icon: '✎' },
  { id: 'settings', label: '设置', icon: '⚙' },
]

export function App(): ReactElement {
  const [page, setPage] = useState<PageId>('overview')
  const [status, setStatus] = useState<{ state: RunState; test: TestState }>({ state: { phase: 'idle' }, test: { phase: 'idle' } })

  useEffect(() => useStatusPolling((state, test) => setStatus({ state, test })), [])

  const { state, test } = status
  const running = state.phase !== 'idle' || test.phase === 'running' || test.phase === 'stopping'
  const progress = asRecord(state.progress)
  const percent = clampPercent(num(progress?.percent))
  const testPercent = clampPercent(num(asRecord(test.progress)?.percent))
  const taskPercent = state.phase !== 'idle' ? percent : test.phase === 'running' ? testPercent : undefined
  const taskLabel = state.phase !== 'idle'
    ? ({ preflight: '预检中', saving: '资料任务执行中', uploading: '固件上传中' } as Record<string, string>)[state.phase] ?? '任务执行中'
    : test.phase === 'running' ? 'XTS 自动测试进行中' : test.phase === 'stopping' ? '正在停止测试' : ''

  let body: ReactElement
  if (page === 'materials') body = <MaterialsPage state={state} test={test} reloadTick={0} />
  else if (page === 'test') body = <TestRunnerPage state={state} test={test} />
  else if (page === 'mirror') body = <MirrorPage state={state} />
  else if (page === 'waiver') body = <WaiverPage state={state} />
  else if (page === 'settings') body = <SettingsPage state={state} test={test} />
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
          <span>{`本地任务 ${state.phase === 'idle' && test.phase === 'idle' ? '空闲' : '执行中'}`}</span>
          <span>v0.1.0 · 数据不出本机（除平台上传）</span>
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
        {body}
      </main>
    </div>
  )
}
