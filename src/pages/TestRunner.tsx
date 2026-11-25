import { useEffect, useRef, useState, type ReactElement } from 'react'
import { request, type DeviceListResponse, type DeviceListItem, type RunState, type TestRound, type TestState } from '../api.js'
import { Bar, Chip, Field, Panel, StatusLine, asArray, asRecord, clampPercent, formatEta, num, str, suiteLabel } from '../components.js'

/** XTS 自动测试页：串行 SSTS → HATS → DCTS(仅有屏+盒子) → ACTS。盒子在「测试盒子」页管理；被测设备从此页空闲列表多选。 */

const TEST_SUITES = ['ssts', 'hats', 'dcts', 'acts'] as const

type Values = { testCasesPath: string; deviceSns: string; testBoxSn: string; workbookPath: string }

export function TestRunnerPage(props: { state: RunState; test: TestState }): ReactElement {
  const [values, setValues] = useState<Values>({ testCasesPath: '', deviceSns: '', testBoxSn: '', workbookPath: '' })
  const [pageError, setPageError] = useState('')
  const [pageNote, setPageNote] = useState('')
  const [idleDevices, setIdleDevices] = useState<DeviceListItem[]>([])
  const [selectedDuts, setSelectedDuts] = useState<string[]>([])
  const [selectedSuites, setSelectedSuites] = useState<string[]>([...TEST_SUITES])
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const hydrated = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)
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
      // 回显已选 DUT
      const sns = (value.deviceSns ?? '').split(';').map((item) => item.trim()).filter(Boolean)
      if (sns.length > 0) setSelectedDuts(sns)
      hydrated.current = true
    })()
    return () => { active = false }
  }, [])

  // 路径改动防抖存入 settings——下次打开应用仍是上次的值，不是旧默认值。
  useEffect(() => {
    if (!hydrated.current) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void request('settings', 'POST', { testCasesPath: values.testCasesPath.trim(), workbookPath: values.workbookPath.trim() })
    }, 800)
    return () => window.clearTimeout(saveTimer.current)
  }, [values.testCasesPath, values.workbookPath])

  function refreshIdle(): void {
    setListLoading(true)
    void (async () => {
      const response = await request<DeviceListResponse>('device/list?excludeBox=1', 'GET')
      setListLoading(false)
      if (response.ok) setIdleDevices((response.devices ?? []).filter((item) => !item.busy))
    })()
  }

  useEffect(() => { refreshIdle() }, [])

  function toggleDut(sn: string): void {
    setSelectedDuts((previous) => previous.includes(sn) ? previous.filter((item) => item !== sn) : [...previous, sn])
  }

  function toggleSuite(suite: string): void {
    setSelectedSuites((previous) => previous.includes(suite) ? previous.filter((item) => item !== suite) : [...TEST_SUITES.filter((item) => previous.includes(item) || item === suite)])
  }

  async function start(): Promise<void> {
    setPageError(''); setPageNote('')
    if (selectedDuts.length === 0) { setPageError('请先从空闲设备中点选至少一台被测设备。'); return }
    if (selectedSuites.length === 0) { setPageError('请至少选择一个要执行的套件。'); return }
    // 选中项可能含上次会话遗留的 SN（不在当前空闲列表、掉线后卡片不显示）——
    // 启动前按实时设备列表校验，遗留项自动剔除并提示，避免脚本因设备不在线直接失败。
    const listResponse = await request<DeviceListResponse>('device/list?excludeBox=1', 'GET')
    const onlineSns = new Set((listResponse.devices ?? []).filter((item) => !item.busy).map((item) => item.sn))
    const offline = selectedDuts.filter((sn) => !onlineSns.has(sn))
    if (offline.length > 0) {
      setSelectedDuts(selectedDuts.filter((sn) => onlineSns.has(sn)))
      setPageError(`以下已选设备当前不在线（上次会话遗留的选择，已自动移除）：${offline.map(snShort).join('、')}。请刷新后重新点选。`)
      return
    }
    void request('settings', 'POST', { deviceSns: selectedDuts.join(';'), testCasesPath: values.testCasesPath.trim(), workbookPath: values.workbookPath.trim() })
    const response = await request<{ ok: boolean; message?: string; error?: string }>('test/start', 'POST', {
      testCasesPath: values.testCasesPath.trim(),
      workbookPath: values.workbookPath.trim(),
      deviceSns: selectedDuts.join(';'),
      suites: selectedSuites.join(','),
      onlyFailed,
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
      <div className="page-head--bar">
        <h1>XTS 自动测试</h1>
        <span className="page-head__meta">HATS / ACTS 并行 · SSTS / DCTS 单机自动取第一台 · 每轮归档 report\&lt;套件&gt;\report-n</span>
        <span className="page-head__actions">
          <button className="btn btn--small btn--danger" disabled={!testRunning} onClick={() => { void request('test/stop', 'POST') }}>停止测试</button>
          <button className="btn btn--primary" disabled={hostRunning || testBusy || selectedDuts.length === 0 || selectedSuites.length === 0} onClick={() => void start()}>
            {testBusy ? '测试中…' : onlyFailed ? '增量补测' : `开始测试（${selectedSuites.length} 个套件）`}
          </button>
        </span>
      </div>
      <div className="workbench">
        <div className="workbench__main">
          <Panel title="测试配置" meta={`测试盒子 ${values.testBoxSn ? snShort(values.testBoxSn) : '未设置'}`}>
            <div className="grid">
              <Field id="t-testcases" label="测试用例路径" wide mono pick="directory" value={values.testCasesPath} placeholder="点右侧「选择文件夹」选 testcase 目录"
                hint="选 xts-acts 套件根目录（含 ssts/ hats/ dcts/ acts/）；选到某个套件目录（如 …\testcase\ssts）也会自动归一到套件根"
                onChange={(value) => setValues((v) => ({ ...v, testCasesPath: value }))} />
              <Field id="t-workbook" label="设备目录（报告归档根）" wide mono pick="directory" value={values.workbookPath}
                placeholder="点右侧「选择文件夹」选设备目录"
                hint="报告归档到 该目录\report\<套件>\report-n"
                onChange={(value) => setValues((v) => ({ ...v, workbookPath: value }))} />
            </div>
          </Panel>

          <Panel title="被测设备" meta={`空闲 ${idleDevices.length} 台 · 已选 ${selectedDuts.length} 台`} actions={
            <button className="btn btn--small" disabled={listLoading} onClick={() => refreshIdle()}>{listLoading ? '刷新中…' : '刷新'}</button>
          }>
            {listLoading ? (
              <div className="dev-skeletons"><div className="sk" /><div className="sk" /><div className="sk" /></div>
            ) : idleDevices.length > 0 ? (
              <div className="picker">
                {idleDevices.map((item) => (
                  <div className={`pick-item${selectedDuts.includes(item.sn) ? ' sel' : ''}`} key={item.sn}
                    onClick={() => toggleDut(item.sn)}>
                    <span className={`dot ${selectedDuts.includes(item.sn) ? 'dot--on' : 'dot--idle'}`} />
                    <div className="pick-body">
                      <div className="pick-title">{`设备 · ${item.type === 'network' ? '网络' : 'USB'}`}</div>
                      <div className="pick-sub" title={`${item.sn}${item.ip ? ` · ${item.ip}` : ''}`}>{`${snShort(item.sn)}${item.ip ? ` · ${item.ip}` : ''}`}</div>
                    </div>
                    {selectedDuts.includes(item.sn) ? <span className="chip chip--sel">已选</span> : <span className="chip">空闲</span>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">当前没有空闲设备。请连接设备后点「刷新」。</p>
            )}
            {selectedDuts.filter((sn) => !idleDevices.some((item) => item.sn === sn)).length > 0 ? (
              <div className="actions">
                {selectedDuts.filter((sn) => !idleDevices.some((item) => item.sn === sn)).map((sn) => (
                  <button key={sn} className="chip chip--sel"
                    title="上次会话遗留的选中项，点击移除" onClick={() => toggleDut(sn)}>
                    {`已选·不在线 ${snShort(sn)} ✕`}
                  </button>
                ))}
              </div>
            ) : null}
          </Panel>

          <Panel title="执行" meta="点选套件，未选中的跳过">
            <div className="suite-picker">
              {TEST_SUITES.map((suite) => (
                <div className={`pick-item${selectedSuites.includes(suite) ? ' sel' : ''}`} key={suite}
                  onClick={() => toggleSuite(suite)}>
                  <div className="pick-body">
                    <div className="pick-title">{suiteLabel(suite)}</div>
                  </div>
                  {selectedSuites.includes(suite) ? <span className="chip chip--sel">执行</span> : <span className="chip">跳过</span>}
                </div>
              ))}
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={onlyFailed} onChange={(event) => setOnlyFailed(event.target.checked)} />
              <span>只跑未通过模块（增量）——按最新归档报告补跑失败 + 没跑完的模块</span>
            </label>
            {selectedDuts.length === 0 ? <span className="hint">请先点选被测设备</span> : null}
            {selectedSuites.length === 0 ? <span className="hint">请选择套件</span> : null}
          </Panel>

          <p className="note">轮次报告完整归档到设备目录 report\&lt;套件&gt;\report-1、report-2 …，编号递增不覆盖；补测上限 2 轮，仍失败的标红走豁免。</p>
          {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
          {pageNote ? <StatusLine tone="ok">{pageNote}</StatusLine> : null}
          {test.message && !testBusy ? <StatusLine tone={test.ok === false ? 'error' : 'ok'}>{str(test.message)}</StatusLine> : null}
        </div>

        <div className="workbench__side">
          <Panel title="流水线" meta={`套件串行 · ${screen === 'yes' ? '有屏' : screen === 'no' ? '无屏' : '方案待探测'}`}>
            {!showPipeline ? (
              <p className="empty">尚未开始测试。配置完成后点右上角「开始测试」。</p>
            ) : (
              <>
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
                    {detail ? <p className="path" title={detail}>{detail}</p> : null}
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
                            <span className="name" title={sn}>{snShort(sn)}</span>
                            <span className="path push-right" title={str(device.currentModule)}>{str(device.currentModule) || '等待调度'}</span>
                          </div>
                          <Bar percent={devicePercent} label={`${sn} 测试进度`} />
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </>
            )}
          </Panel>

          <Panel title="轮次记录" meta="编号递增不覆盖" fill scroll>
            {rounds.length === 0 ? (
              <p className="empty">还没有完成的轮次。每轮结束后这里会记录判卷结果与归档位置。</p>
            ) : (
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
                        {round.message ? <p className="path" title={round.message}>{round.message}</p> : null}
                      </li>
                    )
                  }
                  return (
                    <li className={`row ${round.ok ? 'row--ready' : 'row--blocked'}`} key={`${round.suite}-${roundNo}`}>
                      <div className="row-top">
                        <Chip tone={round.ok ? 'ok' : 'warn'}>{suite}</Chip>
                        <span className="name">{`第 ${roundNo} 轮 · ${round.ok ? `全部通过${round.unavailable ? ` · ${round.unavailable} 模块未运行` : ''}` : round.stopped ? '已停止' : `${round.failedModules.length} 模块失败`}`}</span>
                        {round.archivedTo ? <span className="path push-right" title={round.archivedTo}>已归档 {round.archivedTo}</span> : null}
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
                {test.phase === 'stopping' ? <p className="muted list-note">正在停止测试，当前套件已完成模块的报告会被归档。</p> : null}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}
