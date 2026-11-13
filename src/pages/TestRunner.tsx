import { useEffect, useState, type ReactElement } from 'react'
import { request, type RunState, type TestRound, type TestState } from '../api.js'
import { Bar, Chip, Field, Panel, StatusLine, asArray, asRecord, clampPercent, formatEta, num, str, suiteLabel } from '../components.js'

/** XTS 自动测试页：串行 SSTS → HATS → DCTS(仅有屏+盒子) → ACTS。SN 与盒子在「设备连接」页管理。 */

const TEST_SUITES = ['ssts', 'hats', 'dcts', 'acts'] as const

type Values = { testCasesPath: string; deviceSns: string; testBoxSn: string; workbookPath: string }

export function TestRunnerPage(props: { state: RunState; test: TestState }): ReactElement {
  const [values, setValues] = useState<Values>({ testCasesPath: '', deviceSns: '', testBoxSn: '', workbookPath: '' })
  const [pageError, setPageError] = useState('')
  const [pageNote, setPageNote] = useState('')
  const { state, test } = props

  const hostRunning = state.phase !== 'idle'
  const testRunning = test.phase === 'running'
  const testBusy = test.phase === 'running' || test.phase === 'stopping'

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string> }>('settings', 'GET')
      if (!active || !response.ok || !response.settings) return
      const value = response.settings
      setValues((previous) => ({
        ...previous,
        testCasesPath: value.testCasesPath ?? '',
        deviceSns: value.deviceSns ?? '',
        testBoxSn: value.testBoxSn ?? '',
        workbookPath: value.workbookPath ?? '',
      }))
    })()
    return () => { active = false }
  }, [])

  async function start(): Promise<void> {
    setPageError(''); setPageNote('')
    const response = await request<{ ok: boolean; message?: string; error?: string }>('test/start', 'POST', {
      testCasesPath: values.testCasesPath.trim(),
      workbookPath: values.workbookPath.trim(),
    })
    if (!response.ok) setPageError(response.message || 'XTS 测试启动失败。')
    else setPageNote(response.message || 'XTS 测试已开始。')
  }

  const progress = asRecord(test.progress)
  const percent = clampPercent(num(progress?.percent))
  const stage = str(progress?.stage)
  const detail = str(progress?.detail)
  const eta = formatEta(progress?.etaSeconds)
  const rounds = asArray(test.rounds).map(asRecord).filter(Boolean) as TestRound[]
  const plan = asArray(test.plan).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>
  const screen = test.screens && typeof test.screens === 'object' ? Object.values(test.screens as Record<string, unknown>)[0] : undefined
  const showPipeline = percent !== undefined || testBusy || Boolean(test.finishedAt) || rounds.length > 0
  const devices = asArray(progress?.devices).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>

  const stateBySuite = new Map<string, 'wait' | 'done' | 'fail' | 'running' | 'skip'>()
  for (const suite of TEST_SUITES) stateBySuite.set(suite, 'wait')
  for (const item of plan) stateBySuite.set(str(item.suite), 'wait')
  for (const round of rounds) stateBySuite.set(str(round.suite), round.skipped === true ? 'skip' : round.ok === true ? 'done' : 'fail')
  const currentSuite = str(progress?.suite)
  if (testBusy && currentSuite && stateBySuite.has(currentSuite)) stateBySuite.set(currentSuite, 'running')
  const roundBySuite = new Map<string, TestRound>()
  for (const round of rounds) roundBySuite.set(str(round.suite), round)
  const slotTone = (suite: string): string => stateBySuite.get(suite) ?? 'skip'
  const slotSub = (suite: string): string => {
    if (!stateBySuite.has(suite)) return screen === 'no' ? '无屏 · 跳过' : '仅无屏方案跳过'
    const round = roundBySuite.get(suite)
    if (round) {
      if (round.skipped === true) return '已跳过 · 前置检查未过'
      const failed = round.failedModules.length
      return round.ok === true ? `全部通过（第 ${round.round} 轮）` : `${failed} 模块失败`
    }
    if (stateBySuite.get(suite) === 'running') {
      const doneTotal = devices.reduce((sum, item) => sum + (num(item.done) ?? 0), 0)
      return `进行中 · 已开始 ${doneTotal} 模块（${devices.length} 台设备）`
    }
    const planned = plan.find((item) => str(item.suite) === suite)
    return planned ? `待执行 · ${num(planned.modules) ?? '?'} 模块` : '待执行'
  }
  const snShort = (sn: string): string => (sn.length > 18 ? `${sn.slice(0, 8)}…${sn.slice(-6)}` : sn)

  return (
    <>
      <div className="page-head">
        <h1>XTS 自动测试</h1>
        <p>串行 SSTS → HATS → DCTS(仅有屏+盒子) → ACTS。SN 与盒子在「设备连接」页管理。</p>
      </div>

      <Panel title="测试配置" meta="SN 与盒子在「设备连接」页设置">
        <div className="grid">
          <Field id="t-testcases" label="测试用例路径" wide mono value={values.testCasesPath} placeholder="D:\ohos\XTS6.1\testcase"
            hint="xts-acts 套件根目录（含 ssts/ hats/ dcts/ acts/）"
            onChange={(value) => setValues((v) => ({ ...v, testCasesPath: value }))} />
          <Field id="t-workbook" label="设备目录（报告归档根）" wide mono value={values.workbookPath}
            placeholder="D:\ohos\XTS6.1\CDOHong\CDO-RK3568"
            hint="报告归档到 该目录\report\<套件>\report-n"
            onChange={(value) => setValues((v) => ({ ...v, workbookPath: value }))} />
        </div>
        {values.deviceSns || values.testBoxSn ? (
          <div className="row-top" style={{ gap: 14 }}>
            <Chip tone="acts">{`盒子 ${snShort(values.testBoxSn)}`}</Chip>
            <Chip tone="neutral">{`DUT ${values.deviceSns.split(';').map((item) => snShort(item.trim())).join(' · ')}`}</Chip>
          </div>
        ) : (
          <p className="hint">请先在「设备连接」页连接盒子并选择被测设备。</p>
        )}
        <div className="actions">
          <button className="btn btn--primary" disabled={hostRunning || testBusy} onClick={() => void start()}>{testBusy ? '测试中…' : '开始测试'}</button>
          <button className="btn btn--danger" disabled={!testRunning} onClick={() => { void request('test/stop', 'POST') }}>停止测试</button>
        </div>
      </Panel>

      {showPipeline ? (
        <Panel title="测试流水线" meta={`套件串行 · ${screen === 'yes' ? '有屏' : screen === 'no' ? '无屏' : '方案待探测'}`}>
          <div className="pipe">
            {TEST_SUITES.map((suite, index) => {
              const tone = slotTone(suite)
              return (
                <div className={`pipe-stage${tone === 'wait' ? '' : ` pipe-stage--${tone}`}`} key={suite}>
                  <span className="pipe-name"><span className="pipe-step">{index + 1}</span>{suiteLabel(suite)}</span>
                  <span className="pipe-sub">{slotSub(suite)}</span>
                </div>
              )
            })}
          </div>
          {percent !== undefined ? (
            <>
              <div className="progress-top">
                <span>{stage || '测试状态'}</span>
                <span className="muted">{eta ? `${eta} · ` : ''}{Math.round(percent)}%</span>
              </div>
              <Bar percent={percent} danger={test.ok === false} label="XTS 自动测试总体进度" />
              {detail ? <p className="path">{detail}</p> : null}
            </>
          ) : null}
          {devices.length > 0 ? (
            <ul className="list">
              {devices.map((device) => {
                const sn = str(device.sn)
                const total = num(device.total) ?? 0
                const done = num(device.done) ?? 0
                const devicePercent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
                return (
                  <li className="row row--running" key={sn}>
                    <div className="row-top">
                      <Chip tone="acts">执行中</Chip>
                      <span className="name">{snShort(sn)}</span>
                      <span className="path" style={{ marginLeft: 'auto' }}>{str(device.currentModule) || '等待调度'}</span>
                    </div>
                    <Bar percent={devicePercent} label={`${sn} 测试进度`} />
                  </li>
                )
              })}
            </ul>
          ) : null}
          {rounds.length > 0 ? (
            <ul className="list">
              {rounds.map((round, index) => {
                const suite = suiteLabel(round.suite)
                const roundNo = round.round || index + 1
                if (round.skipped === true) {
                  return (
                    <li className="row row--warn" key={`${round.suite}-${roundNo}`}>
                      <div className="row-top">
                        <Chip tone="warn">{suite}</Chip>
                        <span className="name">已跳过 · 前置检查未过</span>
                      </div>
                      {round.message ? <p className="path">{round.message}</p> : null}
                    </li>
                  )
                }
                return (
                  <li className={`row ${round.ok ? 'row--ready' : 'row--blocked'}`} key={`${round.suite}-${roundNo}`}>
                    <div className="row-top">
                      <Chip tone={round.ok ? 'ok' : 'warn'}>{suite}</Chip>
                      <span className="name">{`第 ${roundNo} 轮 · ${round.ok ? '全部通过' : `${round.failedModules.length} 模块失败`}`}</span>
                      {round.archivedTo ? <span className="path" style={{ marginLeft: 'auto' }}>已归档 {round.archivedTo}</span> : null}
                    </div>
                    {!round.ok && round.failedModules.length > 0 ? <p className="path">{`失败模块将自动增量补测（上限 2 轮）→ 归档为 report-${roundNo + 1}`}</p> : null}
                  </li>
                )
              })}
              {asArray(test.unpassed).length > 0 ? (
                <li className="row row--blocked">
                  <div className="row-top">
                    <Chip tone="blocked">未通过</Chip>
                    <span className="name">{`${asArray(test.unpassed).length} 个模块达到补测上限仍未通过`}</span>
                  </div>
                  <p className="problem">{asArray(test.unpassed).map(asRecord).map((item) => `${suiteLabel(str(item?.suite))} ${str(item?.module)}`).join('、')}</p>
                </li>
              ) : null}
            </ul>
          ) : null}
          {test.phase === 'stopping' ? <p className="muted">正在停止测试，已归档的轮次保留。</p> : null}
        </Panel>
      ) : null}

      {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
      {pageNote ? <StatusLine tone="ok">{pageNote}</StatusLine> : null}
      {test.message && !testBusy ? <StatusLine tone={test.ok === false ? 'error' : 'ok'}>{str(test.message)}</StatusLine> : null}
    </>
  )
}
