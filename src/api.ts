/** 渲染进程 API 层：本地主进程服务（端口由主进程经 query 注入）+ /status 轮询。 */

const port = new URLSearchParams(window.location.search).get('port') || ''
export const API_BASE = `http://127.0.0.1:${port}/api/xts-reporter`

export type ApiResult = { ok: boolean; message?: string; error?: string; errors?: string[] }

export async function request<T extends ApiResult>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    return { ok: false, message: '无法连接本地服务（网络请求失败，请确认应用主进程正常运行）。' } as T
  }
  const raw = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(raw) as T & { error?: unknown }
    if (parsed && typeof parsed === 'object') {
      if (parsed.ok === false && !parsed.message && typeof parsed.error === 'string' && parsed.error) {
        return { ...parsed, message: parsed.error } as T
      }
      return parsed
    }
  } catch {
    // 非 JSON 响应走下面的兜底文案。
  }
  return { ok: false, message: `本地服务返回了无法解析的响应（HTTP ${response.status}）${raw ? `：${raw.slice(0, 120)}` : ''}` } as T
}

// —— 状态形状（与服务端 state/test 一致） ——

export type ProgressState = {
  percent: number
  stage: string
  detail?: string
  itemIndex?: number
  itemTotal?: number
  itemPercent?: number
  workbookPath?: string
}

export type BatchItem = {
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
  items: BatchItem[]
}

export type RunState = {
  kind?: 'phase2' | 'waiver' | 'mirror'
  phase: 'idle' | 'preflight' | 'saving' | 'uploading'
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  message?: string
  errors?: string[]
  summary?: Record<string, unknown>
  progress?: ProgressState
  batch?: BatchState
  mirror?: Record<string, unknown>
}

export type TestDevice = { sn: string; currentModule?: string; done?: number; total?: number }

export type TestProgressState = ProgressState & {
  suite?: string
  suiteIndex?: number
  suiteTotal?: number
  round?: number
  devices?: TestDevice[]
  etaSeconds?: number
}

export type TestRound = {
  suite: string
  round: number
  ok: boolean
  failedModules: string[]
  archivedTo?: string
  message?: string
  skipped?: boolean
  suiteIndex?: number
  suiteTotal?: number
}

export type TestState = {
  phase: 'idle' | 'probing' | 'running' | 'stopping'
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  message?: string
  errors?: string[]
  plan?: Array<{ suite: string; mode: string; modules?: number; singleDevice?: boolean }>
  screens?: Record<string, string>
  progress?: TestProgressState & { suite?: string; suiteIndex?: number; suiteTotal?: number; round?: number; devices?: TestDevice[]; etaSeconds?: number }
  rounds?: TestRound[]
  unpassed?: Array<{ suite: string; module: string }>
}

export type StatusResponse = { ok: boolean; state: RunState; test: TestState }

export type SettingsResponse = {
  ok: boolean
  settings?: Record<string, string>
  hasPassword?: boolean
  message?: string
}

export type DraftItem = {
  workbookPath?: string
  name?: string
  assessmentNumber?: string
  applicationId?: string
  processingStatus?: string
  processedAt?: string
  notes?: string
  resumable?: boolean
}

export type DraftsResponse = ApiResult & {
  root?: string
  items?: DraftItem[]
  skipped?: Array<{ workbookPath?: string; name?: string; detail?: string }>
  summary?: { total?: number; skipped?: number }
}

export type ScanItem = {
  sourceReport: string
  categoryFolder: string
  testCategory: string
  moduleName: string
  testsuite: string
  caseCount: number
  testcases: string[]
  attachmentPath: string
  attachmentKind: string
  evidenceRelative: string[]
  submissionPath: string
  ready: boolean
  problems: string[]
}

export type ScanResponse = ApiResult & {
  root?: string
  items?: ScanItem[]
  summary?: { total?: number; ready?: number; blocked?: number; byCategory?: Record<string, number> }
}

export type ProbeDevice = { sn: string; online: boolean; screen?: 'yes' | 'no' }
export type ProbeBox = { sn: string; online: boolean; ip?: string; sameSubnet?: boolean }

export type ProbeResponse = ApiResult & {
  screen?: 'yes' | 'no' | 'mixed' | 'unknown'
  devices?: ProbeDevice[]
  box?: ProbeBox
}

/** 轮询 /status：App 级单份，所有页面共享。 */
export function useStatusPolling(onTick: (state: RunState, test: TestState) => void, intervalMs = 2500): () => void {
  let active = true
  const tick = async () => {
    const response = await request<StatusResponse>('status', 'GET')
    if (active && response.ok) onTick(response.state, response.test)
  }
  void tick()
  const timer = window.setInterval(() => { void tick() }, intervalMs)
  return () => {
    active = false
    window.clearInterval(timer)
  }
}
