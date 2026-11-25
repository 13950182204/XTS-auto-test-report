import { useEffect, useRef, useState , type ReactElement } from 'react'
import {
  request, useStatusPolling, type RunState, type TestState, type DraftsResponse, type DraftItem,
} from '../api.js'
import { Bar, Chip, Field, Panel, StatusLine, asArray, asRecord, clampPercent, num, str } from '../components.js'

/** 评测资料页：预检 / 提交 / 草稿（解除关联 + 平台核验）/ 批次进度。 */

type Values = {
  username: string; password: string; workbookPath: string
  contactPhone: string; contactEmail: string
}

type Derived = { ok: boolean; workbookPath?: string; waiverPath?: string; mirrorPath?: string; warnings?: string[]; error?: string }

function itemKey(item: DraftItem): string {
  return `${item.workbookPath ?? ''}-${item.applicationId || item.assessmentNumber || ''}`
}

export function MaterialsPage(props: { state: RunState; test: TestState; reloadTick: number }): ReactElement {
  const [values, setValues] = useState<Values>({ username: '', password: '', workbookPath: '', contactPhone: '13950182204', contactEmail: '102438@dnake.com' })
  const [hasPassword, setHasPassword] = useState(false)
  const [drafts, setDrafts] = useState<DraftsResponse | null>(null)
  const [draftsLoading, setDraftsLoading] = useState(false)
  const [derived, setDerived] = useState<Derived | null>(null)
  const [deriveHint, setDeriveHint] = useState('')
  const [pageError, setPageError] = useState('')
  const [busyLocal, setBusyLocal] = useState(false)
  const [unbindArmedId, setUnbindArmedId] = useState('')
  const [unbindBusyId, setUnbindBusyId] = useState('')
  const [unbindError, setUnbindError] = useState('')
  const [verifyNote, setVerifyNote] = useState('')
  const derivedForRef = useRef('')
  const { state } = props

  const hostRunning = state.phase !== 'idle'
  const busy = busyLocal || hostRunning

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string>; hasPassword?: boolean }>('settings', 'GET')
      if (!active || !response.ok || !response.settings) return
      const value = response.settings
      setValues((previous) => ({
        ...previous,
        username: value.username ?? '',
        password: '',
        workbookPath: value.workbookPath ?? '',
        contactPhone: value.contactPhone ?? '13950182204',
        contactEmail: value.contactEmail ?? '102438@dnake.com',
      }))
      setHasPassword(response.hasPassword === true)
    })()
    return () => { active = false }
  }, [])

  // 路径推导（防抖）
  useEffect(() => {
    const input = values.workbookPath.trim()
    if (!input || derivedForRef.current === input) return
    derivedForRef.current = input
    const timer = window.setTimeout(() => {
      void (async () => {
        const response = await request<Derived>('paths/derive', 'POST', { workbookPath: input })
        if (derivedForRef.current !== input) return
        setDerived(response)
        setDeriveHint(response.ok
          ? [response.workbookPath ? `工作簿已识别：${response.workbookPath.split(/[\\/]/).pop()}` : '',
            response.waiverPath ? '豁免资料路径' : '', response.mirrorPath ? '固件包路径' : '', ...(response.warnings ?? [])].filter(Boolean).join('；')
          : `路径推导没跑通：${response.error ?? '未知原因'}`)
      })()
    }, 500)
    return () => { window.clearTimeout(timer) }
  }, [values.workbookPath])

  // 目录一变自动刷新草稿
  useEffect(() => {
    const input = values.workbookPath.trim()
    if (!input) { setDrafts(null); return }
    const timer = window.setTimeout(() => { void loadDrafts() }, 700)
    return () => { window.clearTimeout(timer) }
  }, [values.workbookPath])

  async function saveSettings(): Promise<boolean> {
    const response = await request<{ ok: boolean; message?: string }>('settings', 'POST', {
      username: values.username.trim(),
      workbookPath: values.workbookPath.trim(),
      contactPhone: values.contactPhone.trim() || '13950182204',
      contactEmail: values.contactEmail.trim() || '102438@dnake.com',
      ...(values.password ? { password: values.password } : {}),
    })
    if (!response.ok) { setPageError(response.message || '设置保存失败。'); return false }
    if (values.password) setHasPassword(true)
    setValues((previous) => ({ ...previous, password: '' }))
    return true
  }

  async function loadDrafts(): Promise<void> {
    const workbookPath = values.workbookPath.trim()
    if (!workbookPath) { setDrafts(null); return }
    setDraftsLoading(true)
    const response = await request<DraftsResponse>('phase2/drafts', 'POST', { workbookPath })
    setDrafts(response)
    setDraftsLoading(false)
  }

  async function runAction(action: 'preflight' | 'save' | 'phase2/draft/verify', body: Record<string, unknown>, startMessage: string): Promise<void> {
    setBusyLocal(true); setPageError(''); setVerifyNote('')
    const saved = await saveSettings()
    if (!saved) { setBusyLocal(false); return }
    const response = await request<{ ok: boolean; message?: string; error?: string }>(action, 'POST', body)
    setBusyLocal(false)
    if (action === 'phase2/draft/verify') {
      setVerifyNote(response.ok ? (response.message || '平台核验完成。') : '')
      if (!response.ok) setPageError(response.message || response.error || '平台核验失败。')
    } else if (!response.ok) {
      setPageError(response.message || '操作失败。')
    } else if (action === 'preflight' && derived?.mirrorPath) {
      // 与插件同款链路：预检通过 → 自动上传固件（平台已有同名固件时脚本内部会跳过），
      // 不传固件的话提交第 4 步会报 MIRROR_NOT_FOUND。
      const upload = await request<{ ok: boolean; message?: string; error?: string }>('mirror/upload', 'POST', { mirrorPath: derived.mirrorPath, dryRun: false })
      if (!upload.ok) setPageError(upload.error || upload.message || '固件自动上传失败，请到「镜像固件上传」页手动处理。')
    }
    void loadDrafts()
    void startMessage
  }

  function onUnbindDraft(item: DraftItem, action: 'arm' | 'confirm' | 'cancel'): void {
    const key = itemKey(item)
    if (action === 'arm') { setUnbindArmedId(key); setUnbindError(''); return }
    if (action === 'cancel') { setUnbindArmedId(''); return }
    void (async () => {
      setUnbindBusyId(key); setUnbindError('')
      const response = await request<{ ok: boolean; message?: string; error?: string }>('phase2/draft/unbind', 'POST', {
        workbookPath: item.workbookPath || values.workbookPath.trim(),
        assessmentNumber: item.assessmentNumber ?? '',
        applicationId: item.applicationId ?? '',
      })
      setUnbindBusyId(''); setUnbindArmedId('')
      if (!response.ok) setUnbindError(response.message || '解除关联失败。')
      void loadDrafts()
    })()
  }

  const progress = asRecord(state.progress)
  const percent = clampPercent(num(progress?.percent))
  const stage = str(progress?.stage)
  const detail = str(progress?.detail)
  const batch = asRecord(state.batch ?? null)
  const batchItems = asArray(batch?.items).map(asRecord).filter(Boolean) as Record<string, unknown>[]
  const batchCompleted = batchItems.filter((item) => ['saved', 'skipped', 'blocked', 'retryable', 'preflight'].includes(str(item.status))).length
  const batchTotal = num(batch?.taskCount) ?? batchItems.length
  const messages = [pageError, ...(pageError ? [] : state.errors ?? [])].filter(Boolean).join('\n')
  const draftItems = drafts?.items ?? []

  return (
    <>
      <div className="page-head--bar">
        <h1>评测资料</h1>
        <span className="page-head__meta">预检通过自动上传固件 · 五步保存到「未提交」· 确认提交仍由你在平台点</span>
        <span className="page-head__actions">
          <button className="btn btn--small" disabled={busy} onClick={() => void runAction('preflight', { workbookPath: values.workbookPath.trim() }, '')}>评测资料预检</button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void runAction('save', { workbookPath: values.workbookPath.trim() }, '')}>评测资料提交</button>
        </span>
      </div>
      <div className="workbench">
        <div className="workbench__main">
          <Panel title="申请账号与设备目录" meta={hasPassword ? '已保存密码' : '未保存密码'}>
            <div className="grid">
              <Field id="m-username" label="账号" value={values.username} disabled={busy} onChange={(value) => setValues((v) => ({ ...v, username: value }))} />
              <Field id="m-password" label="密码" type="password" value={values.password} placeholder={hasPassword ? '已保存密码，留空则沿用' : '未保存密码'} disabled={busy} onChange={(value) => setValues((v) => ({ ...v, password: value }))} />
              <Field id="m-workbook" label="设备目录（或批量父目录）" wide pick="directory" value={values.workbookPath} placeholder="点右侧「选择文件夹」选设备目录"
                hint={deriveHint || '选设备目录（或多台设备所在的父目录），自动识别工作簿并带出路径'}
                disabled={busy} onChange={(value) => setValues((v) => ({ ...v, workbookPath: value }))} />
              <Field id="m-phone" label="企业联系电话" value={values.contactPhone} disabled={busy} onChange={(value) => setValues((v) => ({ ...v, contactPhone: value }))} />
              <Field id="m-email" label="企业邮箱" value={values.contactEmail} disabled={busy} onChange={(value) => setValues((v) => ({ ...v, contactEmail: value }))} />
            </div>
          </Panel>

          <Panel title="未提交草稿" meta={`${draftItems.filter((item) => item.resumable).length} 条可直接续提交`} actions={
            <>
              <button className="btn btn--small" disabled={busy || draftsLoading} onClick={() => { void loadDrafts() }}>{draftsLoading ? '检查中…' : '刷新草稿'}</button>
              <button className="btn btn--small" disabled={busy || draftsLoading || draftItems.length === 0}
                title="登录平台核对每条草稿的真实状态并回写工作簿"
                onClick={() => void runAction('phase2/draft/verify', { workbookPath: values.workbookPath.trim() }, '')}>平台核验</button>
            </>
          } scroll scrollMax={280}>
            {drafts?.ok === false
              ? <StatusLine tone="error">{`草稿检查失败：${drafts.message || drafts.error || '未知原因'}`}</StatusLine>
              : draftItems.length > 0 ? (
                <ul className="list">
                  {draftItems.map((item) => {
                    const key = itemKey(item)
                    const armed = unbindArmedId === key
                    const busyItem = unbindBusyId === key
                    return (
                      <li className="row" key={`draft-${item.applicationId || item.workbookPath || item.name}`}>
                        <div className="row-top">
                          <Chip tone={item.assessmentNumber ? 'warn' : 'neutral'}>{item.assessmentNumber ? '未提交' : '编号待回写'}</Chip>
                          <span className="name" title={item.name || '未命名申请'}>{item.name || '未命名申请'}</span>
                          <span className="row-actions">
                            {armed ? (
                              <>
                                <button className="btn btn--small btn--danger" disabled={busyItem} onClick={() => onUnbindDraft(item, 'confirm')}>{busyItem ? '解除中…' : '确认解除'}</button>
                                <button className="btn btn--small" disabled={busyItem} onClick={() => onUnbindDraft(item, 'cancel')}>取消</button>
                              </>
                            ) : (
                              <button className="btn btn--small" disabled={unbindBusyId !== ''} onClick={() => onUnbindDraft(item, 'arm')}>解除关联</button>
                            )}
                          </span>
                        </div>
                        <p className="path" title={`${item.assessmentNumber ? `测评编号：${item.assessmentNumber}` : '测评编号：待回写'}${item.processedAt ? ` · ${item.processedAt}` : ''}${item.notes ? ` · ${item.notes}` : ''}`}>
                          {`${item.assessmentNumber ? `测评编号：${item.assessmentNumber}` : '测评编号：待回写'}${item.processedAt ? ` · ${item.processedAt}` : ''}${item.notes ? ` · ${item.notes}` : ''}`}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="empty">{draftsLoading ? '正在检查未提交草稿…' : '这个目录下没有创建过平台申请的草稿。'}</p>
              )}
            {unbindError ? <StatusLine tone="error">{unbindError}</StatusLine> : null}
            {verifyNote ? <StatusLine tone="ok">{verifyNote}</StatusLine> : null}
          </Panel>

          {messages ? <StatusLine tone={state.ok === false || pageError ? 'error' : 'ok'}>{messages}</StatusLine> : null}
        </div>

        <div className="workbench__side">
          <Panel title="本地任务进度" meta={stage || (state.phase !== 'idle' ? '进行中' : '空闲')}>
            {percent !== undefined ? (
              <>
                <div className="progress-top">
                  <span>{stage || '处理状态'}</span>
                  <span className="muted">{Math.round(percent)}%</span>
                </div>
                <Bar percent={percent} danger={state.ok === false} label="评测资料任务进度" />
                {detail ? <p className="path" title={detail}>{detail}</p> : null}
              </>
            ) : (
              <p className="empty">{state.phase !== 'idle' ? '任务正在启动…' : '当前没有进行中的资料任务。预检 / 提交 / 核验的进度会显示在这里。'}</p>
            )}
          </Panel>

          <Panel title="批次进度" meta={batchItems.length > 0 ? `${batchCompleted}/${batchTotal}` : undefined} fill scroll>
            {batchItems.length === 0 ? (
              <p className="empty">批量任务的逐条进度会显示在这里（如批量父目录多份工作簿、豁免批次）。</p>
            ) : (
              <ul className="list">
                {batchItems.map((item, index) => {
                  const percent = clampPercent(num(item.percent)) ?? 0
                  const tone = str(item.status)
                  const name = str(item.name) || str(item.directory) || `任务 ${index + 1}`
                  const category = str(item.testCategory)
                  return (
                    <li className={`row ${tone === 'blocked' || tone === 'retryable' ? 'row--blocked' : tone === 'saved' || tone === 'preflight' ? 'row--ready' : ''}`} key={`${str(item.workbookPath)}-${index}`}>
                      <div className="row-top">
                        {category ? <Chip tone={category === 'ACTS' ? 'acts' : ['HATS', 'DCTS', 'SSTS'].includes(category) ? 'warn' : 'neutral'}>{category}</Chip> : null}
                        <span className="name" title={name}>{name}</span>
                        <span className="pct push-right">{Math.round(percent)}%</span>
                      </div>
                      <Bar percent={percent} danger={tone === 'blocked'} label={`${name} 进度`} />
                      <p className="path" title={[str(item.stage) || tone, str(item.detail)].filter(Boolean).join('：')}>{[str(item.stage) || tone, str(item.detail)].filter(Boolean).join('：')}</p>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}
