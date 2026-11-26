import { useEffect, useState, type ReactElement } from 'react'
import { request } from '../api.js'
import { Bar, Chip, Field, Panel, StatusLine, num } from '../components.js'

/** 报告复审：核对一个设备目录的 report/ 与 exemption/ 是否满足提交要求。 */

type ReviewSuite = {
  key: string
  label: string
  reportDir?: string
  rounds?: number
  expectedModules?: number
  expectedSource?: string
  referenceTests?: number
  referenceModules?: number
  ranModules?: number
  tests?: number
  failures?: number
  missingModules?: string[]
  failedItems?: ReviewItem[]
  exemptedItems?: ReviewItem[]
  unexemptedItems?: ReviewItem[]
  problems?: string[]
  ok?: boolean
}

type ReviewItem = {
  module?: string
  testsuites?: string[]
  caseCount?: number
  cases?: string[]
  failureCount?: number
  round?: string
  waiverPath?: string
  waiverReports?: string[]
}

type Review = {
  deviceDir?: string
  screen?: string
  screenSource?: string
  minSetDir?: string
  suites?: ReviewSuite[]
  verdict?: string
  summary?: { suites?: number; passed?: number; blocked?: number; unexempted?: number; missingModules?: number }
  notes?: string[]
}

export function ReportReviewPage(): ReactElement {
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<Review | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string> }>('settings', 'GET')
      if (active && response.ok && response.settings) setDir(response.settings.workbookPath ?? '')
    })()
    return () => { active = false }
  }, [])

  async function run(): Promise<void> {
    setBusy(true); setError('')
    const response = await request<{ ok: boolean; review?: Review; message?: string }>('report/review', 'POST', { dir: dir.trim() })
    setBusy(false)
    if (!response.ok || !response.review) { setError(response.message || '复审失败。'); return }
    setReview(response.review)
  }

  const suites = review?.suites ?? []
  const verdict = review?.verdict ?? ''
  const summary = review?.summary ?? {}
  const screenLabel = review?.screen === 'yes' ? '有屏' : review?.screen === 'no' ? '无屏' : '未知'
  const failedEntries = suites.flatMap((suite) => (suite.failedItems ?? []).map((item) => ({ suite, item })))
  const missingEntries = suites.flatMap((suite) => (suite.missingModules ?? []).map((module) => ({ suite, module })))
  const failedCount = failedEntries.length
  const missingCount = missingEntries.length

  return (
    <>
      <div className="page-head--bar">
        <h1>报告复审</h1>
        <span className="page-head__meta">按最小测试集核对 report/ 是否跑全跑通；没通过的必须在 exemption/ 里有豁免</span>
        <span className="page-head__actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => void run()}>{busy ? '复审中…' : '开始复审'}</button>
        </span>
      </div>
      <div className="workbench">
        <div className="workbench__main">
          <Panel title="复审对象">
            <div className="grid">
              <Field id="rr-dir" label="设备目录" wide pick="directory" value={dir} placeholder="点右侧「选择文件夹」选设备目录"
                hint="目录里要有 OpenHarmony兼容性申请资料.xlsx、report/、exemption/"
                disabled={busy} onChange={setDir} />
            </div>
          </Panel>

          {error ? <StatusLine tone="error">{error}</StatusLine> : null}

          {review ? (
            <>
              <Panel title="结论" meta={`${num(summary.passed) ?? 0}/${num(summary.suites) ?? suites.length} 套件通过`}>
                <div className="grid">
                  <div className="row-top">
                    <Chip tone={verdict === 'pass' ? 'ok' : 'warn'}>{verdict === 'pass' ? '可以提交' : '还有阻塞项'}</Chip>
                    <span className="chip chip--neutral">{`${screenLabel}设备`}</span>
                    {review.screenSource ? <span className="path">{review.screenSource}</span> : null}
                  </div>
                  <p className="path" title={review.minSetDir}>{`最小测试集：${review.minSetDir || '未匹配到'}`}</p>
                  {review.notes?.length ? <p className="problem">{review.notes.join('；')}</p> : null}
                </div>
              </Panel>

              <Panel title="套件明细" scroll scrollMax={260}>
                <ul className="list">
                  {suites.map((suite) => (
                    <li className={`row ${suite.ok ? 'row--ready' : 'row--blocked'}`} key={suite.key}>
                      <div className="row-top">
                        <Chip tone={suite.ok ? 'ok' : 'warn'}>{suite.label ?? suite.key}</Chip>
                        <span className="name">{(num(suite.expectedModules) ?? 0) > 0
                          ? `期望 ${num(suite.expectedModules)} 模块 · 实跑 ${num(suite.ranModules) ?? 0} · 用例 ${num(suite.tests) ?? 0}`
                          : (num(suite.referenceTests) ?? 0) > 0
                            ? `期望 ${num(suite.referenceTests)} 用例（参考口径）· 实跑 ${num(suite.ranModules) ?? 0} 模块 · 用例 ${num(suite.tests) ?? 0}`
                            : `无最小集清单 · 实跑 ${num(suite.ranModules) ?? 0} 模块 · 用例 ${num(suite.tests) ?? 0}`}</span>
                        <span className="pct push-right">{`失败 ${num(suite.failures) ?? 0}`}</span>
                      </div>
                      <Bar percent={suite.ok ? 100 : 55} danger={!suite.ok} label={`${suite.label} 复审`} />
                      <p className="path">{`缺失 ${suite.missingModules?.length ?? 0} · 有豁免 ${suite.exemptedItems?.length ?? 0} · 未豁免 ${suite.unexemptedItems?.length ?? 0}${suite.reportDir ? ` · ${suite.rounds ?? 1} 轮` : ''}`}</p>
                      {suite.problems?.length ? <p className="problem">{suite.problems.join('；')}</p> : null}
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="未通过模块" meta={failedCount > 0 ? `${failedCount} 个模块` : '无'} scroll scrollMax={280}>
                {failedEntries.length === 0 ? (
                  <p className="empty">没有失败模块。</p>
                ) : (
                  <ul className="list">
                    {failedEntries.map(({ suite, item }) => (
                      <li className={`row ${item.waiverPath ? '' : 'row--blocked'}`} key={`${suite.key}-${item.module}`}>
                        <div className="row-top">
                          <Chip tone={item.waiverPath ? 'ok' : 'warn'}>{item.waiverPath ? '已豁免' : '未豁免'}</Chip>
                          <Chip tone="neutral">{suite.label ?? suite.key}</Chip>
                          <span className="name" title={item.module}>{item.module ?? ''}</span>
                          <span className="pct push-right">{`${item.caseCount ?? item.failureCount ?? 0} 条失败`}</span>
                        </div>
                        {item.testsuites?.length ? <p className="path">{`测试套：${item.testsuites.join('、')}`}</p> : null}
                        {item.cases?.length ? <p className="path" title={item.cases.join(', ')}>{`用例：${item.cases.slice(0, 6).join('、')}${item.cases.length > 6 ? ' …' : ''}`}</p> : null}
                        <p className="path" title={item.waiverPath}>{item.waiverPath ? `豁免：${item.waiverPath}` : '缺豁免资料（需在 exemption/ 下补）'}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="没跑到的模块" meta={missingCount > 0 ? `${missingCount} 个` : '无'} scroll scrollMax={220}>
                {missingEntries.length === 0 ? (
                  <p className="empty">最小测试集里的模块都跑到了。</p>
                ) : (
                  <ul className="list">
                    {missingEntries.map(({ suite, module }) => (
                      <li className="row row--blocked" key={`${suite.key}-m-${module}`}>
                        <div className="row-top">
                          <Chip tone="warn">{suite.label ?? suite.key}</Chip>
                          <span className="name" title={module}>{module}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </>
          ) : (
            <Panel title="复审结果">
              <p className="empty">还没有复审结果：选好设备目录后点右上角「开始复审」。</p>
            </Panel>
          )}
        </div>

        <div className="workbench__side">
          <Panel title="复审口径" fill scroll>
            <ul className="list">
              <li className="row"><div className="row-top"><span className="name">期望模块</span><span className="pct push-right">最小测试集_有屏/无屏</span></div><p className="path">按申请资料「是否带屏」选对应清单，跑全才算过</p></li>
              <li className="row"><div className="row-top"><span className="name">多轮聚合</span><span className="pct push-right">取并集</span></div><p className="path">增量补测只含失败子集，已跑模块按所有轮次并集算</p></li>
              <li className="row"><div className="row-top"><span className="name">真失败</span><span className="pct push-right">result=false 且 status=run</span></div><p className="path">status=disable/skip 是被忽略用例，不算失败</p></li>
              <li className="row"><div className="row-top"><span className="name">豁免覆盖</span><span className="pct push-right">exemption/&lt;分类&gt;/&lt;模块或套件&gt;</span></div><p className="path">失败模块或测试套在对应目录下存在即算已豁免</p></li>
              <li className="row"><div className="row-top"><span className="name">无屏方案</span><span className="pct push-right">跳过 DCTS / VALIDATOR</span></div><p className="path">这两项没有无屏最小集，不检也不算缺</p></li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  )
}
