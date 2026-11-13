import { useEffect, useState , type ReactElement } from 'react'
import { request, type RunState, type TestState } from '../api.js'
import { Bar, Panel, StatusLine, asRecord, clampPercent, num, str } from '../components.js'

/** 概览页：四个能力入口 + 当前任务状态。 */

export function OverviewPage(props: { state: RunState; test: TestState; onNavigate: (page: 'materials' | 'test' | 'mirror' | 'waiver') => void }): ReactElement {
  const { state, test, onNavigate } = props
  const [account, setAccount] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string> }>('settings', 'GET')
      if (active && response.ok) setAccount(response.settings?.username ?? '')
    })()
    return () => { active = false }
  }, [])

  const progress = asRecord(state.progress)
  const percent = clampPercent(num(progress?.percent))
  const testProgress = asRecord(test.progress)
  const testPercent = clampPercent(num(testProgress?.percent))

  const cards: Array<{ id: 'materials' | 'test' | 'mirror' | 'waiver'; title: string; desc: string; foot: string }> = [
    { id: 'materials', title: '评测资料', desc: '预检、五步保存到「未提交」；草稿支持解除关联与平台核验。', foot: `设备目录：${str(state.progress?.workbookPath) || '未设置'}` },
    { id: 'test', title: 'XTS 自动测试', desc: '串行 SSTS → HATS → DCTS(仅有屏) → ACTS，失败自动补测，报告逐轮归档。', foot: test.phase !== 'idle' ? `当前：${str(testProgress?.stage) || '进行中'}` : '空闲' },
    { id: 'mirror', title: '镜像固件上传', desc: '上传到平台「企业空间 → 镜像管理」，同名自动跳过，进度实时。', foot: '需要已保存账号密码' },
    { id: 'waiver', title: '豁免资料', desc: '按目录识别测试套分类与平台提交路径，批量保存草稿（绝不提交）。', foot: '只保存草稿' },
  ]

  return (
    <>
      <div className="page-head">
        <h1>概览</h1>
        <p>{account ? `当前账号 ${account}` : '先在「设置」里填平台账号密码'}</p>
      </div>

      <div className="overview-grid">
        {cards.map((card) => (
          <button className="cap-card" key={card.id} onClick={() => onNavigate(card.id)}>
            <h3>{card.title}</h3>
            <p>{card.desc}</p>
            <span className="cap-foot">{card.foot}</span>
          </button>
        ))}
      </div>

      {state.phase !== 'idle' ? (
        <Panel title="当前资料任务" meta={str(progress?.stage)}>
          <div className="progress-top">
            <span>{str(progress?.stage)}</span>
            <span className="muted">{Math.round(percent ?? 0)}%</span>
          </div>
          <Bar percent={percent ?? 0} danger={state.ok === false} label="资料任务进度" />
          {str(progress?.detail) ? <p className="path">{str(progress?.detail)}</p> : null}
        </Panel>
      ) : null}

      {test.phase === 'running' ? (
        <Panel title="XTS 自动测试进行中" meta={str(testProgress?.stage)}>
          <div className="progress-top">
            <span>{str(testProgress?.stage)}</span>
            <span className="muted">{Math.round(testPercent ?? 0)}%</span>
          </div>
          <Bar percent={testPercent ?? 0} label="XTS 测试进度" />
          {str(testProgress?.detail) ? <p className="path">{str(testProgress?.detail)}</p> : null}
        </Panel>
      ) : null}

      {state.finishedAt && state.message ? <StatusLine tone={state.ok === false ? 'error' : 'ok'}>{str(state.message)}</StatusLine> : null}
    </>
  )
}
