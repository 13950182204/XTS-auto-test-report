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
      <div className="page-head">
        <h1>镜像固件上传</h1>
        <p>上传到平台「企业空间 → 镜像管理」，长任务后台执行、进度实时同步；平台已有同名固件自动跳过。</p>
      </div>

      <Panel title="固件包">
        <div className="grid">
          <Field id="mi-path" label="固件包路径" wide value={mirrorPath} placeholder="单个 .zip / .7z，或包含固件包的目录"
            hint="支持 .zip / .7z（也接受 tar 系列）；文件名只用中文、英文、数字、空格 _ - . ( )。"
            disabled={busy} onChange={(value) => setMirrorPath(value)} />
        </div>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void run(true)}>校验固件</button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void run(false)}>{running ? '上传中…' : '上传固件'}</button>
        </div>
        <p className="note">评测资料预检通过后会自动开始上传固件；平台已有同名固件时自动跳过；只上传文件，不删改任何镜像。{hasPassword ? '' : '（真实上传需要已保存账号密码）'}</p>
      </Panel>

      {isMirror ? (
        <Panel title={title} meta={meta}>
          <div className="progress-top">
            <span>{stage || (running ? '上传中' : '已结束')}</span>
            <span className="muted">{Math.round(value)}%</span>
          </div>
          <Bar percent={value} danger={failed} label="镜像固件上传进度" />
          {detail ? <p className="path">{detail}</p> : null}
          {str(mirror?.platformStatus) ? <p className="path">{`平台回执：${str(mirror?.platformStatus)}`}</p> : null}
          {duplicates > 1 ? <p className="problem">{`平台「镜像管理」里有 ${duplicates} 条同名镜像，属历史重复；这里只提示不删除，需要时请到平台手动清理。`}</p> : null}
          {running ? <p className="muted">上传期间不要关闭应用；完成后这里会显示平台回执。</p> : null}
        </Panel>
      ) : null}

      {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
      {isMirror && state.message && !running ? <StatusLine tone={state.ok === false ? 'error' : 'ok'}>{str(state.message)}</StatusLine> : null}
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
