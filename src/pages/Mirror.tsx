import { useEffect, useState , type ReactElement } from 'react'
import { request, type RunState } from '../api.js'
import { Bar, Chip, Field, Panel, StatusLine, asRecord, clampPercent, num, str } from '../components.js'

/** 镜像固件上传页：校验 / 上传（长任务，进度轮询）+ 平台回执。 */

export function MirrorPage(props: { state: RunState }): ReactElement {
  const [mirrorPath, setMirrorPath] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [busyLocal, setBusyLocal] = useState(false)
  const [pageError, setPageError] = useState('')
  const { state } = props

  const hostRunning = state.phase !== 'idle'
  const busy = busyLocal || hostRunning
  const mirror = asRecord(state.mirror)
  const progress = asRecord(state.progress)
  const percent = clampPercent(num(progress?.percent))
  const stage = str(progress?.stage)
  const detail = str(progress?.detail)
  const isMirror = state.kind === 'mirror'
  const failed = state.ok === false
  const running = state.phase === 'uploading'
  const skipped = mirror?.skipped === true
  const duplicates = num(mirror?.duplicates) ?? 0
  const value = percent ?? (running ? 0 : failed || !isMirror ? 0 : 100)
  const title = !isMirror ? '镜像固件上传' : running ? '正在上传固件' : failed ? '固件上传失败' : skipped ? '平台已有这条固件，未重复上传' : '固件上传完成'
  const meta = [str(mirror?.fileName), formatSize(num(mirror?.fileSize))].filter(Boolean).join(' · ')

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string>; hasPassword?: boolean }>('settings', 'GET')
      if (!active || !response.ok || !response.settings) return
      setMirrorPath(response.settings.mirrorPath ?? '')
      setHasPassword(response.hasPassword === true)
    })()
    return () => { active = false }
  }, [])

  async function run(dryRun: boolean): Promise<void> {
    setBusyLocal(true); setPageError('')
    const saved = await request<{ ok: boolean; message?: string }>('settings', 'POST', { mirrorPath: mirrorPath.trim() })
    if (!saved.ok) { setBusyLocal(false); setPageError(saved.message || '设置保存失败。'); return }
    const response = await request<{ ok: boolean; message?: string; error?: string }>('mirror/upload', 'POST', { mirrorPath: mirrorPath.trim(), dryRun })
    setBusyLocal(false)
    if (!response.ok) setPageError(response.message || '操作失败。')
  }

  return (
    <>
      <div className="page-head--bar">
        <h1>镜像固件上传</h1>
        <span className="page-head__meta">上传到平台「企业空间 → 镜像管理」· 平台已有同名固件自动跳过 · 长任务后台执行</span>
        <span className="page-head__actions">
          <button className="btn btn--small" disabled={busy} onClick={() => void run(true)}>校验固件</button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void run(false)}>{running ? '上传中…' : '上传固件'}</button>
        </span>
      </div>
      <div className="workbench">
        <div className="workbench__main">
          <Panel title="固件包">
            <div className="grid">
              <Field id="mi-path" label="固件包路径" wide mono pick="file" altPick="directory" extensions={['zip', '7z']} value={mirrorPath} placeholder="点右侧按钮选固件包（.zip / .7z）或它所在的目录"
                hint="型号-8 位日期命名（.zip / .7z）；上传前查重，同名跳过并显示已有记录的上传时间"
                disabled={busy} onChange={(value) => setMirrorPath(value)} />
            </div>
          </Panel>
          <Panel title="平台规则">
            <p className="note">上传到平台「企业空间 → 镜像管理」。平台已有同名固件时自动跳过并显示原上传时间；同名记录未完成（&lt;100%）时平台会沿用该记录续传。目录里出现多份固件时，文件名含 8 位日期的优先。</p>
            <p className="note">评测资料提交第 4 步会按文件名在平台镜像库中选择刚上传的固件，所以先传固件再提交资料。</p>
          </Panel>
          {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
        </div>
        <div className="workbench__side">
          <Panel title={title} meta={meta || undefined}>
            {isMirror ? (
              <>
                <div className="progress-top">
                  <span>{stage || (running ? '上传中' : '已结束')}</span>
                  <span className="muted">{Math.round(value)}%</span>
                </div>
                <Bar percent={value} danger={failed} label="镜像固件上传进度" />
                {detail ? <p className="path" title={detail}>{detail}</p> : null}
                {str(mirror?.platformStatus) ? <p className="path" title={`平台回执：${str(mirror?.platformStatus)}`}>{`平台回执：${str(mirror?.platformStatus)}`}</p> : null}
                {duplicates > 1 ? <p className="problem">{`平台「镜像管理」里有 ${duplicates} 条同名镜像，属历史重复；这里只提示不删除，需要时请到平台手动清理。`}</p> : null}
                {running ? <p className="muted">上传期间不要关闭应用；完成后这里会显示平台回执。</p> : null}
              </>
            ) : (
              <p className="empty">还没有上传任务。选好固件包后点右上角「上传固件」，进度会显示在这里。</p>
            )}
          </Panel>
          <Panel title="平台回执" fill scroll>
            {isMirror && state.message && !running ? (
              <StatusLine tone={state.ok === false ? 'error' : 'ok'}>{str(state.message)}</StatusLine>
            ) : (
              <p className="empty">{running ? '上传完成后平台回执显示在这里。' : '还没有平台回执。'}</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
