import { useState, type ReactElement, type ReactNode } from 'react'
import { request } from './api.js'

/** 共享展示组件：面板 / chips / 进度条 / 状态行 / 字段（设计系统见 styles.css）。 */

export function Panel(props: { title: string; meta?: string; actions?: ReactNode; fill?: boolean; scroll?: boolean; scrollMax?: number; children?: ReactNode }): ReactElement {
  return (
    <div className={`panel${props.fill ? ' panel--fill' : ''}`}>
      <div className="panel-head">
        <span className="panel-title">{props.title}</span>
        {props.meta ? <span className="panel-meta">{props.meta}</span> : null}
        {props.actions ? <span className="panel-head__actions">{props.actions}</span> : null}
      </div>
      {props.scroll ? (
        <div className="panel__scroll" style={props.scrollMax ? { maxHeight: props.scrollMax } : undefined}>{props.children}</div>
      ) : props.children}
    </div>
  )
}

/** mono 长文本（SN / 路径）：单行截断，悬停显示全文。 */
export function MonoLine(props: { value: string }): ReactElement {
  return <span className="mono-line" title={props.value}>{props.value}</span>
}

export function Chip(props: { tone: string; children: string }): ReactElement {
  return <span className={`chip chip--${props.tone}`}>{props.children}</span>
}

export function Bar(props: { percent: number; danger?: boolean; label?: string }): ReactElement {
  return (
    <div className="bar" role="progressbar" aria-label={props.label ?? '进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(props.percent)}>
      <div className={props.danger ? 'danger' : ''} style={{ width: `${Math.max(0, Math.min(100, props.percent))}%` }} />
    </div>
  )
}

export function StatusLine(props: { tone: 'ok' | 'error' | 'warn' | 'plain'; children: string }): ReactElement | null {
  if (!props.children) return null
  return <div className={`status ${props.tone === 'plain' ? '' : `status--${props.tone}`}`} role="status">{props.children}</div>
}

export type FieldProps = {
  id: string
  label: string
  value: string
  hint?: string
  placeholder?: string
  type?: string
  wide?: boolean
  mono?: boolean
  textarea?: boolean
  disabled?: boolean
  /** 路径字段：显示「选择…」按钮走系统对话框，输入框本身只读（用户要求不再手填路径）。 */
  pick?: 'directory' | 'file'
  /** 第二个选择按钮（例如固件包既能选文件也能选所在目录）。 */
  altPick?: 'directory' | 'file'
  /** 文件对话框的扩展名过滤，不带点（zip / 7z / txt）。 */
  extensions?: string[]
  onChange: (value: string) => void
}

export function Field(props: FieldProps): ReactElement {
  const className = `input${props.mono ? ' input--mono' : ''}`
  const [picking, setPicking] = useState(false)
  const pickable = props.pick !== undefined || props.altPick !== undefined
  const readOnly = props.pick !== undefined
  const [pickerError, setPickerError] = useState('')

  async function pick(mode: 'directory' | 'file'): Promise<void> {
    if (props.disabled || picking) return
    setPicking(true); setPickerError('')
    const response = await request<{ ok: boolean; path?: string; canceled?: boolean; message?: string }>('dialog/pick', 'POST', {
      mode,
      title: `${mode === 'file' ? '选择文件' : '选择文件夹'} · ${props.label}`,
      defaultPath: props.value,
      extensions: props.extensions ?? [],
    })
    setPicking(false)
    if (!response.ok) { setPickerError(response.message || '打开选择框失败。'); return }
    if (response.path) props.onChange(response.path)
  }

  const buttons = pickable ? (
    <span className="field-path__actions">
      {props.pick ? (
        <button type="button" className="btn btn--small" disabled={props.disabled || picking} onClick={() => void pick(props.pick!)}>
          {picking ? '…' : props.pick === 'directory' ? '选择文件夹' : '选择文件'}
        </button>
      ) : null}
      {props.altPick ? (
        <button type="button" className="btn btn--small" disabled={props.disabled || picking} onClick={() => void pick(props.altPick!)}>
          {props.altPick === 'directory' ? '选文件夹' : '选文件'}
        </button>
      ) : null}
    </span>
  ) : null

  return (
    <label className={`field${props.wide ? ' field--wide' : ''}`} htmlFor={props.id}>
      <span className="label">{props.label}</span>
      {props.textarea ? (
        <textarea id={props.id} className={className} value={props.value} placeholder={props.placeholder} disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)} />
      ) : pickable ? (
        <span className="field-path">
          <input id={props.id} className={className} type="text" value={props.value} placeholder={props.placeholder}
            disabled={props.disabled} readOnly={readOnly} onChange={(event) => props.onChange(event.target.value)} />
          {buttons}
        </span>
      ) : (
        <input id={props.id} className={className} type={props.type ?? 'text'} value={props.value} placeholder={props.placeholder}
          disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} />
      )}
      {props.hint ? <span className="hint">{props.hint}</span> : null}
      {pickerError ? <span className="hint hint--error">{pickerError}</span> : null}
    </label>
  )
}

export function emptyToNull(value: ReactElement | null | undefined): ReactElement | null {
  return value ?? null
}

export function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Math.max(0, Math.min(100, value))
}

export function num(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function formatEta(seconds: unknown): string {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const totalMinutes = Math.round(value / 60)
  if (totalMinutes < 1) return '预计剩余 1 分钟以内'
  if (totalMinutes < 60) return `预计剩余约 ${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `预计剩余约 ${hours} 小时 ${minutes} 分` : `预计剩余约 ${hours} 小时`
}

export function suiteLabel(suite: string): string {
  return ({ ssts: 'SSTS', hats: 'HATS', dcts: 'DCTS', acts: 'ACTS' } as Record<string, string>)[suite] ?? suite.toUpperCase()
}
