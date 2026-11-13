import { useEffect, useState , type ReactElement } from 'react'
import { request, type RunState, type ScanResponse } from '../api.js'
import { Bar, Chip, Field, Panel, StatusLine, asArray, asRecord, clampPercent, num, str } from '../components.js'

/** 豁免资料页：识别目录 / 预检 / 保存草稿（长任务后台执行）。 */

export function WaiverPage(props: { state: RunState }): ReactElement {
  const [waiverAssessmentNumber, setWaiverAssessmentNumber] = useState('')
  const [waiverPath, setWaiverPath] = useState('')
  const [scan, setScan] = useState<ScanResponse | null>(null)
  const [busyLocal, setBusyLocal] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pageNote, setPageNote] = useState('')
  const { state } = props

  const hostRunning = state.phase !== 'idle'
  const busy = busyLocal || hostRunning
  const progress = asRecord(state.progress)
  const percent = clampPercent(num(progress?.percent))
  const stage = str(progress?.stage)
  const detail = str(progress?.detail)
  const batch = asRecord(state.batch)
  const batchItems = asArray(batch?.items).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>
  const batchCompleted = batchItems.filter((item) => ['saved', 'skipped', 'blocked', 'retryable', 'preflight'].includes(str(item.status))).length
  const batchTotal = num(batch?.taskCount) ?? batchItems.length
  const isWaiver = state.kind === 'waiver'

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string> }>('settings', 'GET')
      if (!active || !response.ok || !response.settings) return
      const value = response.settings
      setWaiverAssessmentNumber(value.waiverAssessmentNumber ?? '')
      setWaiverPath(value.waiverPath ?? '')
    })()
    return () => { active = false }
  }, [])

  async function run(action: 'waiver/scan' | 'waiver/preflight' | 'waiver/save', dryNote?: string): Promise<void> {
    setBusyLocal(true); setPageError(''); setPageNote('')
    const saved = await request<{ ok: boolean; message?: string }>('settings', 'POST', {
      waiverAssessmentNumber: waiverAssessmentNumber.trim(),
      waiverPath: waiverPath.trim(),
    })
    if (!saved.ok) { setBusyLocal(false); setPageError(saved.message || '设置保存失败。'); return }
    const response = await request<{ ok: boolean; message?: string; error?: string }>(action, 'POST', {
      waiverPath: waiverPath.trim(),
      waiverAssessmentNumber: waiverAssessmentNumber.trim(),
    })
    setBusyLocal(false)
    if (action === 'waiver/scan') {
      if (response.ok) setScan(response as ScanResponse)
      else setPageError(response.message || '识别失败。')
      return
    }
    if (!response.ok) setPageError(response.message || '操作失败。')
    else setPageNote(response.message || dryNote || '已开始。')
  }

  return (
    <>
      <div className="page-head">
        <h1>豁免资料</h1>
        <p>按目录自动识别测试套分类与平台提交路径；预检与保存草稿为浏览器长任务，后台执行。</p>
      </div>

      <Panel title="豁免配置" meta="只保存草稿，绝不提交">
        <div className="grid">
          <Field id="w-assessment" label="测评编号（豁免）" value={waiverAssessmentNumber} placeholder="例如 OHC007500008641" disabled={busy} onChange={(value) => setWaiverAssessmentNumber(value)} />
          <Field id="w-path" label="豁免资料路径" wide value={waiverPath} placeholder="目录或单个 .txt，例如 D:\ohos\XTS6.1\CDOHong\CDO-RK3568\exemption"
            hint="Acts / ActsValidator / Hats / Dcts / Ssts 目录；附件优先 .zip，缺失用 .txt。"
            disabled={busy} onChange={(value) => setWaiverPath(value)} />
        </div>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void run('waiver/scan')}>识别目录</button>
          <button className="btn" disabled={busy} onClick={() => void run('waiver/preflight')}>豁免资料预检</button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void run('waiver/save')}>{hostRunning && isWaiver ? '处理中…' : '保存豁免草稿'}</button>
        </div>
        <p className="note">任一条失败即停；「保存豁免草稿」只保存草稿，不点「申请豁免/提交/确认提交」，也不调用 /exempt/submit。</p>
      </Panel>

      {scan ? (
        <Panel title="识别结果" meta={scanSummary(scan)}>
          {scan.items && scan.items.length > 0 ? (
            <ul className="list">
              {scan.items.slice(0, 10).map((item, index) => (
                <li className={`row ${item.ready ? 'row--ready' : 'row--blocked'}`} key={`${item.sourceReport}-${index}`}>
                  <div className="row-top">
                    {item.testCategory ? <Chip tone={categoryTone(item.testCategory)}>{item.testCategory}</Chip> : null}
                    <span className="name">{item.moduleName && item.testsuite ? `${item.moduleName}#${item.testsuite}` : item.sourceReport}</span>
                    <span className="muted">{`${item.caseCount} 条用例`}</span>
                    <span className="path">{Math.round(item.ready ? 100 : 0)}%</span>
                  </div>
                  <Bar percent={item.ready ? 100 : 0} danger={!item.ready} label={`${item.moduleName} 就绪度`} />
                  {item.submissionPath ? <p className="path">{`提交路径：${item.submissionPath}`}</p> : null}
                  {item.problems.length > 0 ? <p className="problem">{item.problems.join('；')}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{scan.ok ? '这个路径下没有找到 .txt 豁免报告。' : (scan.error || scan.message || '识别失败。')}</p>
          )}
          {scan.items && scan.items.length > 10 ? <p className="muted">{`另有 ${scan.items.length - 10} 条未列出（共 ${scan.items.length} 条）。`}</p> : null}
        </Panel>
      ) : (
        <p className="empty">还没有识别结果：点「识别目录」预览分类与提交路径。</p>
      )}

      {isWaiver && batchItems.length > 0 ? (
        <Panel title={`豁免批次进度（${batchCompleted}/${batchTotal}）`} meta={str(batch?.rootPath)}>
          <ul className="list">
            {batchItems.map((item, index) => {
              const percent = clampPercent(num(item.percent)) ?? 0
              const tone = str(item.status)
              return (
                <li className={`row ${tone === 'blocked' || tone === 'retryable' ? 'row--blocked' : tone === 'saved' || tone === 'preflight' ? 'row--ready' : ''}`} key={`${str(item.workbookPath)}-${index}`}>
                  <div className="row-top">
                    {str(item.testCategory) ? <Chip tone={categoryTone(str(item.testCategory))}>{str(item.testCategory)}</Chip> : null}
                    <span className="name">{str(item.name) || str(item.directory) || `任务 ${index + 1}`}</span>
                    <span className="path">{Math.round(percent)}%</span>
                  </div>
                  <Bar percent={percent} danger={tone === 'blocked'} label={`${str(item.name)} 进度`} />
                  <p className="path">{[str(item.stage) || tone, str(item.detail)].filter(Boolean).join('：')}</p>
                </li>
              )
            })}
          </ul>
        </Panel>
      ) : null}

      {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
      {pageNote ? <StatusLine tone="ok">{pageNote}</StatusLine> : null}
      {isWaiver && state.message && state.phase === 'idle' && !pageNote ? <StatusLine tone={state.ok === false ? 'error' : 'ok'}>{str(state.message)}</StatusLine> : null}
    </>
  )
}

function categoryTone(category: string): string {
  if (category === 'ACTS') return 'acts'
  if (category === 'ACTS-Validator') return 'ok'
  return 'warn'
}

function scanSummary(scan: ScanResponse): string {
  const items = scan.items ?? []
  const summary = scan.summary
  const parts = [`${num(summary?.total) ?? items.length} 条`]
  const byCategory = summary?.byCategory ?? {}
  for (const [category, count] of Object.entries(byCategory)) {
    if (Number(count) > 0) parts.push(`${category} ${count}`)
  }
  const blocked = num(summary?.blocked) ?? items.filter((item) => !item.ready).length
  if (blocked > 0) parts.push(`待修复 ${blocked}`)
  return parts.join(' · ')
}
