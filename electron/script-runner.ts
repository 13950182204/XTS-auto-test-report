import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMirrorProgressLine } from './mirror-progress.js'

/**
 * 脚本运行器（与插件 phase2-routes.ts 的 runScript 同款签名与解析行为）。
 *
 * DSH 插件与本应用都跑在 Electron 里：`process.execPath` 指向 Electron 二进制，
 * spawn 脚本需要 `ELECTRON_RUN_AS_NODE=1`，同一个二进制在该变量下退化成普通 Node，
 * 业务脚本零改动复用。
 */

/** 脚本目录：<应用根>/scripts（out/main/ 向上三级）。 */
export function scriptsDirectory(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts')
}

export function scriptNodeEnv(): NodeJS.ProcessEnv {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

export function redact(value: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, '[已隐藏]'), value)
}

export type ProgressState = {
  percent: number
  stage: string
  detail?: string
  itemIndex?: number
  itemTotal?: number
  itemPercent?: number
  workbookPath?: string
}

export type BatchItemState = {
  directory?: string
  workbookPath?: string
  name?: string
  taskIndex?: number
  status: string
  percent: number
  stage: string
  detail?: string
  applicationId?: string
  assessmentNumber?: string
  testCategory?: string
  submissionPath?: string
  code?: string
}

export type BatchState = {
  mode?: 'single' | 'batch'
  rootPath?: string
  taskCount: number
  skippedCount: number
  items: BatchItemState[]
}

export function parseStructuredLine<T>(line: string, prefix: string): T | undefined {
  if (!line.startsWith(prefix)) return undefined
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as T : undefined
  } catch {
    return undefined
  }
}

/** 进度行解析：镜像脚本用 MIRROR_PROGRESS= 前缀，资料脚本用 PHASE2_PROGRESS=，字段同构。 */
export function parseProgressLine(line: string): ProgressState | undefined {
  const mirror = parseMirrorProgressLine(line)
  if (mirror) return mirror
  if (!line.startsWith('PHASE2_PROGRESS=')) return undefined
  try {
    const parsed: unknown = JSON.parse(line.slice('PHASE2_PROGRESS='.length))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = parsed as Record<string, unknown>
    const rawPercent = Number(value.percent)
    const rawItemPercent = Number(value.itemPercent)
    const stage = typeof value.stage === 'string' ? value.stage.trim() : ''
    if (!Number.isFinite(rawPercent) || !stage) return undefined
    return {
      percent: Math.max(0, Math.min(100, Math.round(rawPercent))),
      stage,
      detail: typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined,
      itemIndex: Number.isFinite(Number(value.itemIndex)) ? Number(value.itemIndex) : undefined,
      itemTotal: Number.isFinite(Number(value.itemTotal)) ? Number(value.itemTotal) : undefined,
      itemPercent: Number.isFinite(rawItemPercent)
        ? Math.max(0, Math.min(100, Math.round(rawItemPercent)))
        : Math.max(0, Math.min(100, Math.round(rawPercent))),
      workbookPath: typeof value.workbookPath === 'string' && value.workbookPath.trim() ? value.workbookPath.trim() : undefined,
    }
  } catch {
    return undefined
  }
}

export function batchFromValue(value: unknown): BatchState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const rawItems = Array.isArray(source.items) ? source.items : []
  const items: BatchItemState[] = rawItems
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      directory: typeof item.directory === 'string' && item.directory.trim() ? item.directory.trim() : undefined,
      workbookPath: typeof item.workbookPath === 'string' && item.workbookPath.trim() ? item.workbookPath.trim() : undefined,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
      taskIndex: Number.isFinite(Number(item.taskIndex)) ? Number(item.taskIndex) : undefined,
      status: typeof item.status === 'string' && item.status.trim() ? item.status.trim() : 'pending',
      percent: Number.isFinite(Number(item.percent)) ? Math.max(0, Math.min(100, Number(item.percent))) : 0,
      stage: typeof item.stage === 'string' && item.stage.trim() ? item.stage.trim() : '待处理',
      detail: typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim() : undefined,
      applicationId: typeof item.applicationId === 'string' && item.applicationId.trim() ? item.applicationId.trim() : undefined,
      assessmentNumber: typeof item.assessmentNumber === 'string' && item.assessmentNumber.trim() ? item.assessmentNumber.trim() : undefined,
      testCategory: typeof item.testCategory === 'string' && item.testCategory.trim() ? item.testCategory.trim() : undefined,
      submissionPath: typeof item.submissionPath === 'string' && item.submissionPath.trim() ? item.submissionPath.trim() : undefined,
      code: typeof item.code === 'string' && item.code.trim() ? item.code.trim() : undefined,
    }))
  const rawSkipped = Array.isArray(source.skipped) ? source.skipped : []
  for (const skipped of rawSkipped) {
    if (skipped === null || typeof skipped !== 'object' || Array.isArray(skipped)) continue
    const item = skipped as Record<string, unknown>
    const directory = typeof item.directory === 'string' ? item.directory.trim() : ''
    if (directory && items.some((candidate) => candidate.directory === directory)) continue
    items.push({
      directory: directory || undefined,
      name: (typeof item.name === 'string' && item.name.trim()) || directory,
      status: 'skipped',
      percent: 100,
      stage: '已跳过',
      detail: (typeof item.reason === 'string' && item.reason.trim()) || '未找到第二阶段 Excel。',
    })
  }
  items.sort((left, right) => (left.name || left.directory || '').localeCompare(right.name || right.directory || ''))
  const skippedCount = Number.isFinite(Number(source.skippedCount))
    ? Number(source.skippedCount)
    : items.filter((item) => item.status === 'skipped').length
  const taskCount = Number.isFinite(Number(source.taskCount)) ? Number(source.taskCount) : items.filter((item) => item.taskIndex).length
  const mode = typeof source.mode === 'string' ? source.mode.trim() : ''
  return {
    mode: mode === 'single' || mode === 'batch' ? mode as BatchState['mode'] : undefined,
    rootPath: typeof source.rootPath === 'string' && source.rootPath.trim() ? source.rootPath.trim() : undefined,
    taskCount,
    skippedCount,
    items,
  }
}

export interface RunScriptResult {
  code: number
  output: string
}

export type RunScriptOptions = {
  env?: NodeJS.ProcessEnv
  secrets?: string[]
  onProgress?: (progress: ProgressState) => void
  onBatchInit?: (batch: BatchState) => void
  onBatchItemResult?: (result: Record<string, unknown>) => void
  /** 硬超时；默认 15 分钟，长任务（镜像上传 45 分钟、XTS 测试 0=不限）由调用方指定。 */
  timeoutMs?: number
}

export function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  secrets: string[],
  onProgress?: (progress: ProgressState) => void,
  onBatchInit?: (batch: BatchState) => void,
  onBatchItemResult?: (result: Record<string, unknown>) => void,
  timeoutMs: number = 15 * 60 * 1000,
): Promise<RunScriptResult> & { execution: Promise<RunScriptResult>; child: import('node:child_process').ChildProcess | null } {
  let child: import('node:child_process').ChildProcess | null = null
  const execution = new Promise<RunScriptResult>((resolve) => {
    try {
      child = spawn(process.execPath, [join(scriptsDirectory(), script), ...args], {
        env: { ...process.env, ...scriptNodeEnv(), ...env },
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: 1, output: error instanceof Error ? error.message : String(error) })
      return
    }
    let output = ''
    let buffer = ''
    const feed = (chunk: Buffer | string) => {
      const text = chunk.toString()
      output += text
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const progress = parseProgressLine(line)
        if (progress) onProgress?.(progress)
        const batchInit = parseStructuredLine<Record<string, unknown>>(line, 'PHASE2_BATCH_INIT=')
        if (batchInit) onBatchInit?.(batchFromValue(batchInit) || { taskCount: 0, skippedCount: 0, items: [] })
        const itemResult = parseStructuredLine<Record<string, unknown>>(line, 'PHASE2_BATCH_ITEM_RESULT=')
        if (itemResult) onBatchItemResult?.(itemResult)
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.once('error', (error) => {
      output += `\n${error.message}`
      resolve({ code: 1, output: redact(output.trim(), secrets) })
    })
    child.once('close', (code) => {
      if (buffer.trim()) {
        const progress = parseProgressLine(buffer)
        if (progress) onProgress?.(progress)
      }
      resolve({ code: typeof code === 'number' ? code : 1, output: redact(output.trim(), secrets) })
    })
    if (timeoutMs > 0) {
      const timer = setTimeout(() => child?.kill('SIGTERM'), timeoutMs)
      child.once('close', () => clearTimeout(timer))
    }
  })
  // 返回值既是 Promise（可直接 await 拿结果），又带 execution/child（长任务后台模式用）。
  return Object.assign(execution, { execution, child }) as Promise<RunScriptResult> & { execution: Promise<RunScriptResult>; child: import('node:child_process').ChildProcess | null }
}

/** 杀掉进程树（Windows）。 */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } catch {
    // 尽力而为：进程可能刚好退出。
  }
}
