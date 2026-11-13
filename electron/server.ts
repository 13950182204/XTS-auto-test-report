import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, win32 } from 'node:path'
import { derivePaths } from './derive-paths.js'
import { parseMirrorProgressLine, parseMirrorResultLine, type MirrorResult } from './mirror-progress.js'
import {
  parseXtsProbeResultLine,
  parseXtsTestProgressLine,
  parseXtsTestResultLine,
  parseXtsTestRoundLine,
  type XtsProbeResult,
  type XtsTestDevice,
  type XtsTestResult,
} from './xts-test-progress.js'
import { spawn } from 'node:child_process'
import {
  batchFromValue,
  killTree,
  parseProgressLine,
  parseStructuredLine,
  runScript,
  scriptNodeEnv,
  scriptsDirectory,
  type BatchItemState,
  type BatchState,
  type ProgressState,
} from './script-runner.js'
import { defaultSettingsFilePath, SettingsStore, settingsView, type Phase2Settings } from './settings-store.js'
import { CredentialVault } from './vault.js'

/**
 * 本地 API 服务（数据面 1:1 移植自插件 phase2-routes.ts + test 路由）：
 * 状态机、后台长任务、stdout 行协议解析、全部 /api/* 路由形状与插件一致，
 * 渲染进程据此实现同样的交互行为。
 */

export const API_PREFIX = '/api/xts-reporter'

const DEFAULT_TESTCASES_PATH = 'D:\\ohos\\XTS6.1\\testcase'
const DEFAULT_TEST_BOX_SN = '370100654d4d43202010000071dd7b00'
const MIRROR_UPLOAD_TIMEOUT_MS = 45 * 60 * 1000
export interface WaiverScanItem {
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

export interface WaiverScanSummary {
  total: number
  ready: number
  blocked: number
  byCategory: Record<string, number>
}

export interface WaiverScanResult {
  ok: boolean
  root?: string
  items?: WaiverScanItem[]
  summary?: WaiverScanSummary
  error?: string
}

type RunState = {
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

const state: RunState = { phase: 'idle' }

type TestProgressState = {
  percent: number
  stage: string
  detail?: string
  suite?: string
  suiteIndex?: number
  suiteTotal?: number
  round?: number
  devices?: XtsTestDevice[]
  etaSeconds?: number
}

type TestState = {
  phase: 'idle' | 'probing' | 'running' | 'stopping'
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  message?: string
  errors?: string[]
  plan?: Array<{ suite: string; mode: string; modules?: number }>
  screens?: Record<string, string>
  progress?: TestProgressState
  rounds?: Array<{ suite: string; round: number; ok: boolean; failedModules: string[]; archivedTo?: string; skipped?: boolean }>
  unpassed?: Array<{ suite: string; module: string }>
}

const testState: TestState = { phase: 'idle' }
let testProcess: { killTree(): void; pid?: number } | null = null
let testResult: XtsTestResult | undefined

/** 设备连接页：盒子连接 + 被测设备配网的独立状态。 */
type DeviceState = {
  phase: 'idle' | 'pairing'
  startedAt?: string
  finishedAt?: string
  ok?: boolean
  message?: string
}

const deviceState: DeviceState = { phase: 'idle' }
let deviceProcess: { killTree(): void; pid?: number } | null = null

function updateState(patch: Partial<RunState>): void {
  Object.assign(state, patch)
}

function updateTestState(patch: Partial<TestState>): void {
  Object.assign(testState, patch)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 64 * 1024) throw new Error('请求体过大。')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象。')
  }
  return parsed as Record<string, unknown>
}

function inputPath(body: Record<string, unknown>, settings: Phase2Settings): string {
  return text(body.inputPath) || text(body.workbookPath) || text(settings.workbookPath)
}

function attachmentSettings(workbook: string): Record<string, string> {
  const raw = workbook.trim()
  const normalized = raw.replaceAll('/', '\\')
  const directory = win32.dirname(normalized)
  return {
    selfCheckPath: `${directory}\\OpenHarmony设备兼容性规范5.x自检表_标准系统.xlsx`,
    reportPath: `${directory}\\report\\report.zip`,
    mirrorPath: '',
  }
}

function parseSnsList(value: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const token of value.split(/[\n\r;,\s]+/)) {
    const sn = token.trim()
    if (!sn || seen.has(sn)) continue
    seen.add(sn)
    result.push(sn)
  }
  return result
}

// —— 行协议解析（与插件同款） ——

function applyBatchProgress(batch: BatchState | undefined, progress: ProgressState): { batch?: BatchState; progress: ProgressState } {
  if (!batch || !progress.itemIndex || !progress.itemTotal) return { batch, progress }
  const itemIndex = progress.itemIndex
  const itemPercent = progress.itemPercent ?? progress.percent
  const items = batch.items.map((item) => item.taskIndex === itemIndex
    ? { ...item, status: item.status === 'skipped' ? item.status : 'saving', percent: itemPercent, stage: progress.stage, detail: progress.detail, workbookPath: progress.workbookPath || item.workbookPath }
    : item)
  const overall = Math.round(((itemIndex - 1) * 100 + itemPercent) / progress.itemTotal)
  return { batch: { ...batch, taskCount: progress.itemTotal, items }, progress: { ...progress, percent: Math.max(0, Math.min(100, overall)), itemPercent } }
}

function applyBatchItemResult(batch: BatchState | undefined, value: Record<string, unknown>): BatchState | undefined {
  if (!batch) return batch
  const taskIndex = Number(value.taskIndex)
  const status = text(value.status)
  const stage = ({ saved: '已完成', skipped: '已跳过', blocked: '已停止', retryable: '待重试' } as Record<string, string>)[status] || status
  const items = batch.items.map((item) => item.taskIndex === taskIndex ? {
    ...item,
    status: status || item.status,
    percent: ['saved', 'skipped', 'blocked', 'retryable'].includes(status) ? 100 : item.percent,
    stage: stage || item.stage,
    detail: text(value.message) || item.detail,
    applicationId: text(value.applicationId) || item.applicationId,
    assessmentNumber: text(value.assessmentNumber) || item.assessmentNumber,
    testCategory: text(value.testCategory) || item.testCategory,
    submissionPath: text(value.submissionPath) || item.submissionPath,
    code: text(value.code) || item.code,
  } : item)
  return { ...batch, items }
}

function batchFromSummary(summary: Record<string, unknown> | undefined): BatchState | undefined {
  if (!summary || !Array.isArray(summary.items)) return undefined
  return batchFromValue(summary)
}

function parsePreflight(output: string): { ok: boolean; errors?: string[]; summary?: Record<string, unknown>; message?: string } {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as { ok: boolean; errors?: string[]; summary?: Record<string, unknown>; message?: string }
      }
    } catch {
      // 预检结果行前会有进度行，正常。
    }
  }
  return { ok: false, errors: [output || '预检进程未返回结果。'], message: '工作簿预检失败。' }
}

function formatSaveFailure(summary?: Record<string, unknown>): string | undefined {
  const results = Array.isArray(summary?.results) ? summary.results : []
  const first = results[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return undefined
  const value = first as Record<string, unknown>
  const code = text(value.code)
  const message = text(value.message)
  if (!message) return undefined
  return code ? `${code}: ${message}` : message
}

function parseSave(output: string): { summary?: Record<string, unknown>; failureMessage?: string } {
  const marker = [...output.split(/\r?\n/)].reverse().find((line: string) => line.startsWith('PHASE2_RESULT_JSON='))
  if (!marker) return {}
  try {
    const value: unknown = JSON.parse(marker.slice('PHASE2_RESULT_JSON='.length))
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const summary = value as Record<string, unknown>
      return { summary, failureMessage: formatSaveFailure(summary) }
    }
  } catch {
    // 结构化标记坏了就走普通错误文案。
  }
  return {}
}

/** 评测资料/豁免批量处理的**后台收尾**（与插件 v1.2.5 同款长任务模式）。 */
async function finishPhase2Run(
  execution: Promise<{ code: number; output: string }>,
  options: { kind: 'phase2' | 'waiver'; isDirectoryInput?: boolean; dryRun?: boolean },
): Promise<void> {
  const finishedAt = new Date().toISOString()
  try {
    const result = await execution
    const ok = result.code === 0
    const parsed = parseSave(result.output)
    let message: string
    if (ok) {
      message = options.kind === 'waiver'
        ? (options.dryRun ? '豁免资料预检完成：未创建草稿、未提交。' : '豁免草稿已保存（未提交；最终提交必须人工完成）。')
        : (options.isDirectoryInput ? '批量评测资料已处理完成，尚未最终提交。' : '评测资料已保存，尚未最终提交。')
    } else {
      message = parsed.failureMessage || result.output || (options.kind === 'waiver' ? '豁免草稿处理失败。' : '评测资料处理失败。')
    }
    updateState({
      kind: options.kind,
      phase: 'idle',
      finishedAt,
      ok,
      message,
      errors: ok ? undefined : [message],
      summary: parsed.summary,
      batch: batchFromSummary(parsed.summary) || state.batch,
      progress: { percent: 100, stage: ok ? '已完成' : '已停止', detail: message },
    })
  } catch (error) {
    const message = `任务执行失败：${error instanceof Error ? error.message : String(error)}`
    updateState({
      kind: options.kind,
      phase: 'idle',
      finishedAt: new Date().toISOString(),
      ok: false,
      message,
      errors: [message],
      progress: { percent: 100, stage: '已停止', detail: message },
    })
  }
}

// —— 豁免扫描解析 ——

const WAIVER_SCAN_PREFIX = 'WAIVER_SCAN_JSON='

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => text(entry)).filter((entry) => entry !== '') : []
}

function parseScanItem(value: unknown): WaiverScanItem | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const testcases = textList(item.testcases)
  const rawCount = Number(item.caseCount)
  return {
    sourceReport: text(item.sourceReport),
    categoryFolder: text(item.categoryFolder),
    testCategory: text(item.testCategory),
    moduleName: text(item.moduleName),
    testsuite: text(item.testsuite),
    caseCount: Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : testcases.length,
    testcases,
    attachmentPath: text(item.attachmentPath),
    attachmentKind: text(item.attachmentKind),
    evidenceRelative: textList(item.evidenceRelative),
    submissionPath: text(item.submissionPath),
    ready: item.ready === true,
    problems: textList(item.problems),
  }
}

function parseScanSummary(value: unknown, items: WaiverScanItem[]): WaiverScanSummary {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const byCategory: Record<string, number> = {}
  const rawByCategory = source.byCategory
  if (rawByCategory !== null && typeof rawByCategory === 'object' && !Array.isArray(rawByCategory)) {
    for (const [key, raw] of Object.entries(rawByCategory as Record<string, unknown>)) {
      const count = Number(raw)
      if (Number.isFinite(count)) byCategory[key] = count
    }
  }
  const rawTotal = Number(source.total)
  const total = Number.isFinite(rawTotal) ? rawTotal : items.length
  const rawReady = Number(source.ready)
  const ready = Number.isFinite(rawReady) ? rawReady : items.filter((item) => item.ready).length
  const rawBlocked = Number(source.blocked)
  const blocked = Number.isFinite(rawBlocked) ? rawBlocked : Math.max(0, total - ready)
  return { total, ready, blocked, byCategory }
}

function parseWaiverScan(output: string): { ok: boolean; root?: string; items?: WaiverScanItem[]; summary?: WaiverScanSummary; error?: string } | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseStructuredLine<Record<string, unknown>>(line, WAIVER_SCAN_PREFIX)
    if (!parsed) continue
    if (parsed.ok !== true) {
      return { ok: false, error: text(parsed.error) || text(parsed.message) || '识别豁免资料失败。' }
    }
    const items = Array.isArray(parsed.items)
      ? parsed.items.map(parseScanItem).filter((item): item is WaiverScanItem => item !== undefined)
      : []
    return { ok: true, root: text(parsed.root), items, summary: parseScanSummary(parsed.summary, items) }
  }
  return undefined
}

// —— 草稿列表 / 解除关联 / 平台核验 ——

const PHASE2_DRAFTS_PREFIX = 'PHASE2_DRAFTS_JSON='

export interface Phase2DraftItem {
  directory?: string
  workbookPath?: string
  name?: string
  sheetName?: string
  type?: string
  assessmentNumber?: string
  applicationId?: string
  processingStatus?: string
  processedAt?: string
  notes?: string
  resumable?: boolean
}

export interface Phase2DraftsResult {
  ok: boolean
  root?: string
  items?: Phase2DraftItem[]
  skipped?: Array<{ workbookPath?: string; name?: string; detail?: string }>
  summary?: { total?: number; skipped?: number }
  error?: string
}

function parsePhase2Drafts(output: string): Phase2DraftsResult | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseStructuredLine<Phase2DraftsResult>(line, PHASE2_DRAFTS_PREFIX)
    if (parsed) return parsed
  }
  return undefined
}

const PHASE2_UNBIND_PREFIX = 'PHASE2_UNBIND_JSON='

function parsePhase2Unbind(output: string): { ok: boolean; workbookPath?: string; message?: string; error?: string } | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseStructuredLine<{ ok: boolean; workbookPath?: string; message?: string; error?: string }>(line, PHASE2_UNBIND_PREFIX)
    if (parsed) return parsed
  }
  return undefined
}

const PHASE2_VERIFY_PREFIX = 'PHASE2_VERIFY_JSON='

interface Phase2VerifyResult {
  ok: boolean
  results?: Array<Record<string, unknown>>
  summary?: Record<string, unknown>
  message?: string
  error?: string
}

function parsePhase2Verify(output: string): Phase2VerifyResult | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseStructuredLine<Phase2VerifyResult>(line, PHASE2_VERIFY_PREFIX)
    if (parsed) return parsed
  }
  return undefined
}

function parseProbeOutput(output: string): XtsProbeResult | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseXtsProbeResultLine(line)
    if (parsed) return parsed
  }
  return undefined
}

function mirrorArtifactsDirectory(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  return join(tmpdir(), `oh-mirror-upload-${stamp}`)
}

function mirrorResultMessage(result: MirrorResult, dryRun: boolean): string {
  if (result.ok) return result.message || (dryRun ? '镜像固件校验通过（未上传）。' : '镜像固件已上传完成。')
  const code = result.errorCode ? `${result.errorCode}: ` : ''
  return `${code}${result.message || (dryRun ? '镜像固件校验失败。' : '镜像固件上传失败。')}`
}

function parseMirrorResult(output: string): MirrorResult | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseMirrorResultLine(line)
    if (parsed) return parsed
  }
  return undefined
}

async function finishMirrorRun(execution: Promise<{ code: number; output: string }>, options: { dryRun: boolean }): Promise<void> {
  const finishedAt = new Date().toISOString()
  try {
    const result = await execution
    const parsed = parseMirrorResult(result.output)
    const ok = result.code === 0 && parsed?.ok === true
    const label = options.dryRun ? '校验' : '上传'
    let message: string
    if (ok) {
      message = mirrorResultMessage(parsed as MirrorResult, options.dryRun)
    } else if (parsed && parsed.ok === false) {
      message = mirrorResultMessage(parsed, options.dryRun)
    } else if (parsed) {
      message = `镜像固件${label}异常结束（脚本退出码 ${result.code}）${result.output ? `：${result.output.slice(-500)}` : '。'}`
    } else {
      message = `镜像固件${label}没有返回结果（脚本退出码 ${result.code}）${result.output ? `：${result.output.slice(-500)}` : '。'}`
    }
    updateState({
      kind: 'mirror',
      phase: 'idle',
      finishedAt,
      ok,
      message,
      errors: ok ? undefined : [message],
      mirror: parsed?.ok ? {
        fileName: parsed.fileName,
        fileSize: parsed.fileSize,
        platformStatus: parsed.platformStatus,
        skipped: parsed.skipped,
        duplicates: parsed.duplicates,
      } : undefined,
      progress: { percent: 100, stage: '已结束', detail: message },
    })
  } catch (error) {
    const message = `镜像固件处理失败：${error instanceof Error ? error.message : String(error)}`
    updateState({ kind: 'mirror', phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message], progress: { percent: 100, stage: '已结束', detail: message } })
  }
}

// —— 主服务 ——

export async function startServer(userDataDir: string, rendererDir: string, log: (line: string) => void): Promise<{ port: number; close(): void }> {
  const store = new SettingsStore(defaultSettingsFilePath(userDataDir))
  const vault = new CredentialVault(userDataDir)

  function currentSettings(): Phase2Settings {
    return store.read()
  }

  // 各处理器（与插件 handler 一一对应；方法判定在内部做）。

  async function handleStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, message: '只支持 GET。' })
    sendJson(res, 200, { ok: true, state: { ...state }, test: { ...testState }, device: { ...deviceState } })
  }

  async function handleSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...settingsView(currentSettings()) })
      return
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST/GET。' })
    try {
      const body = await readBody(req)
      const patch: Phase2Settings = {}
      for (const field of ['username', 'workbookPath', 'selfCheckPath', 'reportPath', 'mirrorPath', 'contactPhone', 'contactEmail', 'waiverPath', 'waiverAssessmentNumber', 'testCasesPath', 'deviceSns', 'testBoxSn'] as const) {
        if (field in body) patch[field] = text(body[field])
      }
      const password = text(body.password)
      if (password !== '') patch.password = password
      const saved = store.merge(patch)
      log('设置已保存')
      sendJson(res, 200, { ok: true, ...settingsView(saved) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, message: `设置保存失败：${message}` })
    }
  }

  async function handlePathsDerive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    try {
      const body = await readBody(req)
      const input = text(body.workbookPath) || text(body.path)
      sendJson(res, 200, derivePaths(input))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: `推导路径失败：${message}` })
    }
  }

  async function handlePreflight(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST。' })
    if (state.phase !== 'idle') return sendJson(res, 409, { ok: false, message: '已有任务正在执行，请等待当前任务结束。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const path = inputPath(body, value)
      if (!path) return sendJson(res, 400, { ok: false, message: '没有提供对应的申请表格文件或批量目录，已停止执行。' })
      const isDirectoryInput = !path.toLowerCase().endsWith('.xlsx')
      updateState({ kind: 'phase2', phase: 'preflight', startedAt: new Date().toISOString(), finishedAt: undefined, ok: undefined, message: isDirectoryInput ? '正在扫描批量目录。' : '正在读取工作簿。', errors: undefined, summary: undefined, batch: undefined, progress: { percent: 5, stage: isDirectoryInput ? '扫描批量目录' : '读取工作簿', detail: isDirectoryInput ? '正在检查一级子目录中的申请表。' : '正在检查设备类型和必填字段。' } })
      const result = await runScript('preflight_phase2.mjs', ['--input', path], {}, [], (progress) => updateState({ progress, message: progress.detail || progress.stage }), (batch) => updateState({ batch }), (itemResult) => updateState({ batch: applyBatchItemResult(state.batch, itemResult) }))
      const parsed = parsePreflight(result.output)
      const response = { ...parsed, ok: result.code === 0 && parsed.ok }
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: response.ok, message: response.message, errors: response.errors, summary: response.summary, batch: batchFromSummary(response.summary), progress: { percent: 100, stage: response.ok ? '预检完成' : '预检失败', detail: response.ok ? response.message || '工作簿和附件路径可以使用。' : response.message } })
      sendJson(res, response.ok ? 200 : 422, { ...response, batch: state.batch })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message], progress: { percent: 100, stage: '预检失败', detail: message } })
      sendJson(res, 400, { ok: false, message, errors: [message] })
    }
  }

  async function handleSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST。' })
    if (state.phase !== 'idle') return sendJson(res, 409, { ok: false, message: '已有任务正在执行，请等待当前任务结束。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const path = inputPath(body, value)
      const username = text(value.username) || text(process.env.OH_USERNAME)
      const password = text(value.password) || text(process.env.OH_PASSWORD)
      if (!username || !password) return sendJson(res, 400, { ok: false, message: '没有填写对应账号密码，已停止执行。' })
      if (!path) return sendJson(res, 400, { ok: false, message: '没有提供对应的申请表格文件或批量目录，已停止执行。' })
      const isDirectoryInput = !path.toLowerCase().endsWith('.xlsx')
      const scriptName = isDirectoryInput ? 'phase2_batch.mjs' : 'fill_phase2.mjs'
      const scriptArgs = isDirectoryInput ? ['--input', path, '--save'] : ['--phase2', '--workbook', path, '--save']
      const attachments = isDirectoryInput ? {} : attachmentSettings(path)
      updateState({ kind: 'phase2', phase: 'saving', startedAt: new Date().toISOString(), finishedAt: undefined, ok: undefined, message: '正在启动浏览器流程。', errors: undefined, summary: undefined, batch: undefined, progress: { percent: 2, stage: '启动流程', detail: isDirectoryInput ? '正在扫描批量目录。' : '正在登录兼容性测评平台。' } })
      const execution = runScript(scriptName, scriptArgs, {
        OH_USERNAME: username,
        OH_PASSWORD: password,
        OH_CONTACT_PHONE: text(value.contactPhone) || '13950182204',
        OH_CONTACT_EMAIL: text(value.contactEmail) || '102438@dnake.com',
        OH_SELF_CHECK_PATH: attachments.selfCheckPath || '',
        OH_REPORT_PATH: attachments.reportPath || '',
        OH_MIRROR_PATH: '',
      }, [username, password], (progress) => {
        const merged = applyBatchProgress(state.batch, progress)
        updateState({ progress: merged.progress, batch: merged.batch, message: progress.detail || progress.stage })
      }, (batch) => updateState({ batch }), (itemResult) => updateState({ batch: applyBatchItemResult(state.batch, itemResult) }))
      // 浏览器长任务：立即返回「已开始」，后台收尾（与插件 v1.2.5 同款）。
      sendJson(res, 200, {
        ok: true,
        message: isDirectoryInput ? '已开始批量处理评测资料，进度见下方。' : '已开始处理评测资料，进度见下方。',
        batch: state.batch,
      })
      void finishPhase2Run(execution, { kind: 'phase2', isDirectoryInput })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message], progress: { percent: 100, stage: '已停止', detail: message } })
      sendJson(res, 400, { ok: false, message, errors: [message] })
    }
  }

  async function handleWaiverRun(req: http.IncomingMessage, res: http.ServerResponse, mode: 'preflight' | 'save'): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST。' })
    if (state.phase !== 'idle') return sendJson(res, 409, { ok: false, message: '已有任务正在执行，请等待当前任务结束。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const waiverPath = text(body.waiverPath) || text(value.waiverPath)
      const assessment = text(body.waiverAssessmentNumber) || text(value.waiverAssessmentNumber)
      const username = text(value.username) || text(process.env.OH_USERNAME)
      const password = text(value.password) || text(process.env.OH_PASSWORD)
      if (!username || !password) return sendJson(res, 400, { ok: false, message: '没有填写对应账号密码，已停止执行。' })
      if (!assessment) return sendJson(res, 400, { ok: false, message: '没有填写对应测评编号，已停止执行。' })
      if (!waiverPath) return sendJson(res, 400, { ok: false, message: '没有填写豁免资料路径，已停止执行。' })
      const dryRun = mode === 'preflight'
      updateState({
        kind: 'waiver',
        phase: dryRun ? 'preflight' : 'saving',
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        ok: undefined,
        message: dryRun ? '正在解析豁免资料并预检。' : '正在解析豁免资料并保存草稿。',
        errors: undefined,
        summary: undefined,
        batch: undefined,
        progress: { percent: 2, stage: '解析豁免资料', detail: waiverPath },
      })
      const execution = runScript('waiver_batch.mjs', [
        '--input', waiverPath,
        '--assessment', assessment,
        dryRun ? '--dry-run' : '--save',
      ], { OH_USERNAME: username, OH_PASSWORD: password }, [username, password], (progress) => updateState({ progress, message: progress.detail || progress.stage }), (batch) => updateState({ batch }), (itemResult) => updateState({ batch: applyBatchItemResult(state.batch, itemResult) }))
      sendJson(res, 200, { ok: true, message: dryRun ? '已开始豁免资料预检，进度见下方。' : '已开始保存豁免草稿，进度见下方。', batch: state.batch })
      void finishPhase2Run(execution, { kind: 'waiver', dryRun })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateState({ kind: 'waiver', phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message], progress: { percent: 100, stage: '已停止', detail: message } })
      sendJson(res, 400, { ok: false, message, errors: [message] })
    }
  }

  async function handleWaiverScan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const path = text(body.waiverPath) || text(value.waiverPath)
      if (!path) return sendJson(res, 200, { ok: false, error: '没有填写豁免资料路径，无法识别。' })
      const result = await runScript('waiver_batch.mjs', ['--input', path, '--scan'], {}, [])
      const parsed = parseWaiverScan(result.output)
      if (!parsed) return sendJson(res, 200, { ok: false, error: '识别进程未返回结果。' })
      sendJson(res, 200, parsed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: `识别豁免资料失败：${message}` })
    }
  }

  async function handlePhase2Drafts(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    try {
      const body = await readBody(req)
      const workbookPath = text(body.workbookPath) || text(currentSettings().workbookPath)
      if (!workbookPath) return sendJson(res, 200, { ok: false, error: '没有填写设备目录，无法检查草稿。' })
      if (!existsSync(workbookPath)) return sendJson(res, 200, { ok: false, error: `设备目录不存在：${workbookPath}` })
      const result = await runScript('list_phase2_drafts.mjs', ['--input', workbookPath], {}, [])
      const parsed = parsePhase2Drafts(result.output)
      if (!parsed) {
        const detail = result.output ? `无法解析草稿检查结果：${result.output.slice(-500)}` : '草稿检查进程未返回结果。'
        return sendJson(res, 200, { ok: false, error: detail })
      }
      if (parsed.ok === false) return sendJson(res, 200, { ok: false, error: parsed.error || '检查草稿失败。' })
      sendJson(res, 200, { ok: true, root: parsed.root, items: parsed.items ?? [], skipped: parsed.skipped ?? [], summary: parsed.summary })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: `检查草稿失败：${message}` })
    }
  }

  async function handlePhase2DraftUnbind(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    if (state.phase !== 'idle') return sendJson(res, 409, { ok: false, error: '已有任务正在执行（会写同一份工作簿），请等待其结束后再解除关联。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const workbookPath = text(body.workbookPath) || text(value.workbookPath)
      if (!workbookPath) return sendJson(res, 200, { ok: false, error: '没有提供工作簿路径，无法解除关联。' })
      if (!existsSync(workbookPath)) return sendJson(res, 200, { ok: false, error: `工作簿不存在：${workbookPath}` })
      const assessmentNumber = text(body.assessmentNumber)
      const applicationId = text(body.applicationId)
      if (!assessmentNumber && !applicationId) return sendJson(res, 200, { ok: false, error: '没有提供测评编号或申请标识，无法定位要解除的草稿。' })
      updateState({ kind: 'phase2', phase: 'preflight', startedAt: new Date().toISOString(), finishedAt: undefined, ok: undefined, message: '正在解除草稿关联（仅本机工作簿，平台记录不动）。', errors: undefined, batch: undefined, progress: { percent: 10, stage: '解除关联', detail: '正在清除工作簿里的申请标识与测评编号。' } })
      const result = await runScript('unbind_draft.mjs', [
        '--workbook', workbookPath,
        '--assessment-number', assessmentNumber,
        '--application-id', applicationId,
      ], {}, [])
      const parsed = parsePhase2Unbind(result.output)
      const ok = result.code === 0 && parsed?.ok === true
      const message = parsed?.message || parsed?.error || (ok ? '已解除草稿关联。' : `解除关联失败（脚本退出码 ${result.code}）：${result.output.slice(-300)}`)
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok, message, errors: ok ? undefined : [message], progress: { percent: 100, stage: ok ? '已解除' : '解除失败', detail: message } })
      if (!ok) return sendJson(res, 200, { ok: false, error: message })
      sendJson(res, 200, { ok: true, workbookPath: parsed?.workbookPath || workbookPath, message })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message] })
      sendJson(res, 200, { ok: false, error: `解除关联失败：${message}` })
    }
  }

  async function handlePhase2DraftVerify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    if (state.phase !== 'idle') return sendJson(res, 409, { ok: false, error: '已有任务正在执行，请等待当前任务结束。' })
    let artifactsDir = ''
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const username = text(value.username) || text(process.env.OH_USERNAME)
      const password = text(value.password) || text(process.env.OH_PASSWORD)
      if (!username || !password) return sendJson(res, 200, { ok: false, error: '没有填写对应账号密码，无法登录平台核验。' })
      const workbookPath = text(body.workbookPath) || text(value.workbookPath)
      if (!workbookPath) return sendJson(res, 200, { ok: false, error: '没有填写设备目录，无法核验草稿。' })
      if (!existsSync(workbookPath)) return sendJson(res, 200, { ok: false, error: `设备目录不存在：${workbookPath}` })
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
      artifactsDir = join(tmpdir(), `oh-draft-verify-${stamp}`)
      mkdirSync(artifactsDir, { recursive: true })
      updateState({ kind: 'phase2', phase: 'preflight', startedAt: new Date().toISOString(), finishedAt: undefined, ok: undefined, message: '正在登录平台核验草稿状态…', errors: undefined, batch: undefined, progress: { percent: 10, stage: '平台核验', detail: '正在登录兼容性测评平台并逐条核对申请状态。' } })
      const result = await runScript('verify_draft_status.mjs', ['--input', workbookPath, '--artifacts', artifactsDir], {
        OH_USERNAME: username,
        OH_PASSWORD: password,
      }, [username, password], (progress) => updateState({ progress, message: progress.detail || progress.stage }))
      const parsed = parsePhase2Verify(result.output)
      const ok = result.code === 0 && parsed?.ok === true
      const message = parsed?.message || parsed?.error || (ok ? '平台核验完成。' : `平台核验失败（脚本退出码 ${result.code}）：${result.output.slice(-300)}`)
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok, message, errors: ok ? undefined : [message], progress: { percent: 100, stage: ok ? '核验完成' : '核验失败', detail: message } })
      if (!ok) return sendJson(res, 200, { ok: false, error: message })
      sendJson(res, 200, { ok: true, message, results: parsed?.results ?? [], summary: parsed?.summary ?? {} })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message] })
      sendJson(res, 200, { ok: false, error: `平台核验失败：${message}` })
    }
  }

  async function handleMirrorUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    if (state.phase !== 'idle') return sendJson(res, 200, { ok: false, error: '正在处理其他任务，请稍后再试。' })
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    try {
      const value = currentSettings()
      const mirrorPath = text(body.mirrorPath) || text(value.mirrorPath)
      if (!mirrorPath) return sendJson(res, 200, { ok: false, error: '没有填写镜像固件路径，已停止执行。' })
      if (!existsSync(mirrorPath)) return sendJson(res, 200, { ok: false, error: `镜像固件路径不存在：${mirrorPath}` })
      const dryRun = body.dryRun === true
      const username = text(value.username) || text(process.env.OH_USERNAME)
      const password = text(value.password) || text(process.env.OH_PASSWORD)
      if (!dryRun && (!username || !password)) return sendJson(res, 200, { ok: false, error: '没有填写对应账号密码，已停止执行。' })
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
      const artifactsDir = join(tmpdir(), `oh-mirror-upload-${stamp}`)
      mkdirSync(artifactsDir, { recursive: true })
      updateState({
        kind: 'mirror',
        phase: 'uploading',
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        ok: undefined,
        message: dryRun ? '正在校验镜像固件。' : '正在上传镜像固件。',
        errors: undefined,
        summary: undefined,
        batch: undefined,
        mirror: undefined,
        progress: dryRun
          ? { percent: 0, stage: '校验固件', detail: '正在校验固件文件与文件名规则。' }
          : { percent: 0, stage: '启动上传', detail: '正在登录兼容性测评平台。' },
      })
      const execution = runScript('mirror_upload.mjs', [
        '--input', mirrorPath,
        '--artifacts', artifactsDir,
        dryRun ? '--dry-run' : '--upload',
      ], { OH_USERNAME: username, OH_PASSWORD: password }, [username, password], (progress) => updateState({ progress, message: progress.detail || progress.stage }), undefined, undefined, MIRROR_UPLOAD_TIMEOUT_MS)
      sendJson(res, 200, {
        ok: true,
        message: dryRun ? '已开始校验固件，进度见进度条。' : '已开始上传固件，进度见进度条。',
        artifacts: artifactsDir,
      })
      void finishMirrorRun(execution, { dryRun })
    } catch (error) {
      const message = `镜像固件上传启动失败：${error instanceof Error ? error.message : String(error)}`
      updateState({ kind: 'mirror', phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message], progress: { percent: 100, stage: '已结束', detail: message } })
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  function handleTestLine(line: string): void {
    const progress = parseXtsTestProgressLine(line)
    if (progress) {
      updateTestState({ progress, message: progress.detail || progress.stage })
      return
    }
    const round = parseXtsTestRoundLine(line)
    if (round) {
      const rounds = [...(testState.rounds ?? []).filter((item) => !(item.suite === round.suite && item.round === round.round)), round]
      updateTestState({ rounds })
    }
    const result = parseXtsTestResultLine(line)
    if (result) testResult = result
  }

  async function finishTestRun(execution: Promise<{ code: number; output: string }>): Promise<void> {
    const finishedAt = new Date().toISOString()
    try {
      const result = await execution
      const parsed = testResult
      const ok = result.code === 0 && parsed?.ok === true
      const fallback = result.code === 0
        ? 'XTS 测试已结束。'
        : `XTS 测试异常结束（脚本退出码 ${result.code}）${result.output ? `：${result.output.slice(-500)}` : '。'}`
      const message = parsed?.message || fallback
      updateTestState({
        phase: 'idle',
        finishedAt,
        ok,
        message,
        errors: ok ? undefined : [message],
        plan: parsed?.plan ?? testState.plan,
        screens: parsed?.screens ?? testState.screens,
        unpassed: parsed?.unpassed ?? testState.unpassed,
        progress: { percent: 100, stage: ok ? '测试完成' : '测试结束', detail: message },
      })
    } catch (error) {
      const message = `XTS 测试收尾失败：${error instanceof Error ? error.message : String(error)}`
      updateTestState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message], progress: { percent: 100, stage: '测试结束', detail: message } })
    } finally {
      testProcess = null
      testResult = undefined
    }
  }

  async function handleTestStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST。' })
    if (testState.phase !== 'idle') return sendJson(res, 409, { ok: false, message: 'XTS 测试已在进行中，请等待其结束或先停止。' })
    if (state.phase !== 'idle') return sendJson(res, 409, { ok: false, message: '已有资料任务正在执行，请等待其结束后再开始测试。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const testCasesPath = text(body.testCasesPath) || text(value.testCasesPath) || DEFAULT_TESTCASES_PATH
      const sns = parseSnsList(text(body.deviceSns) || text(value.deviceSns))
      const workbookPath = text(body.workbookPath) || text(value.workbookPath)
      if (!existsSync(testCasesPath)) return sendJson(res, 400, { ok: false, message: `测试用例路径不存在：${testCasesPath}` })
      if (sns.length === 0) return sendJson(res, 400, { ok: false, message: '没有填写被测设备 SN，已停止执行。' })
      if (!workbookPath) return sendJson(res, 400, { ok: false, message: '没有填写设备目录，测试报告不知道归档到哪里，已停止执行。' })
      if (!existsSync(workbookPath)) return sendJson(res, 400, { ok: false, message: `设备目录不存在：${workbookPath}` })
      const screen = text(body.screen) === 'yes' ? 'yes' : text(body.screen) === 'no' ? 'no' : ''
      const testBoxSn = text(body.testBoxSn) || text(value.testBoxSn) || DEFAULT_TEST_BOX_SN
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
      const artifactsDir = join(tmpdir(), `oh-xts-test-${stamp}`)
      try {
        mkdirSync(artifactsDir, { recursive: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return sendJson(res, 400, { ok: false, message: `无法创建测试工作目录：${message}` })
      }
      updateTestState({
        phase: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        ok: undefined,
        message: '正在启动 XTS 测试（探测设备、生成配置）。',
        errors: undefined,
        plan: undefined,
        screens: undefined,
        rounds: undefined,
        unpassed: undefined,
        progress: { percent: 0, stage: '启动测试', detail: '正在校验设备与测试集清单。' },
      })
      const scriptArgs = [
        '--testcases', testCasesPath,
        '--sns', sns.join(';'),
        '--workbook', workbookPath,
        '--artifacts', artifactsDir,
        '--box-sn', testBoxSn,
      ]
      if (screen) scriptArgs.push('--screen', screen)
      const { execution, child } = runTestScript('xts_run_test.mjs', scriptArgs)
      testProcess = child
      sendJson(res, 200, { ok: true, message: 'XTS 测试已开始，进度见流水线。', artifacts: artifactsDir })
      void finishTestRun(execution)
    } catch (error) {
      const message = `XTS 测试启动失败：${error instanceof Error ? error.message : String(error)}`
      updateTestState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message, errors: [message] })
      sendJson(res, 400, { ok: false, message })
    }
  }

  async function handleTestStop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST。' })
    if (testState.phase === 'idle') return sendJson(res, 200, { ok: true, message: '当前没有进行中的测试。' })
    if (testProcess?.pid) killTree(testProcess.pid)
    updateTestState({ phase: 'stopping', message: '正在停止测试，已归档的轮次保留。' })
    sendJson(res, 200, { ok: true, message: '停止指令已发出，测试进程终止后状态会回到空闲。' })
  }

  async function handleTestProbe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '只支持 POST。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const sns = parseSnsList(text(body.deviceSns) || text(value.deviceSns))
      if (sns.length === 0) return sendJson(res, 200, { ok: false, error: '没有填写被测设备 SN，无法探测。' })
      const probingWhenIdle = testState.phase === 'idle'
      if (probingWhenIdle) updateTestState({ phase: 'probing', message: '正在探测设备有屏/无屏…' })
      try {
        const probeArgs = ['--sns', sns.join(';')]
        const testBoxSn = text(body.testBoxSn) || text(value.testBoxSn)
        if (testBoxSn) probeArgs.push('--box-sn', testBoxSn)
        const result = await runScript('xts_probe_devices.mjs', probeArgs, {}, [], undefined, undefined, undefined, 3 * 60 * 1000)
        const parsed = parseProbeOutput(result.output)
        if (!parsed?.ok) {
          return sendJson(res, 200, { ok: false, error: parsed?.error || `设备探测失败（脚本退出码 ${result.code}）。` })
        }
        return sendJson(res, 200, { ok: true, screen: parsed.screen, devices: parsed.devices, box: parsed.box, message: parsed.message })
      } finally {
        if (probingWhenIdle && testState.phase === 'probing') updateTestState({ phase: 'idle' })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: `设备探测失败：${message}` })
    }
  }

  function runTestScript(script: string, args: string[]): { execution: Promise<{ code: number; output: string }>; child: { killTree(): void; pid?: number } | null } {
    // XTS 脚本走自己的原始行协议（XTS_TEST_PROGRESS/ROUND/RESULT），需要原始行，
    // 与 PHASE2/MIRROR 的结构化回调不同，这里单独 spawn。
    const child = spawn(process.execPath, [join(scriptsDirectory(), script), ...args], {
      env: { ...process.env, ...scriptNodeEnv() },
      windowsHide: true,
    })
    const execution = new Promise<{ code: number; output: string }>((resolve) => {
      let output = ''
      let buffer = ''
      const feed = (chunk: Buffer | string) => {
        const chunkText = chunk.toString()
        output += chunkText
        buffer += chunkText
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) handleTestLine(line)
      }
      child.stdout?.on('data', feed)
      child.stderr?.on('data', feed)
      child.once('error', (error) => {
        output += `\n${error.message}`
        resolve({ code: 1, output })
      })
      child.once('close', (code) => {
        if (buffer.trim()) handleTestLine(buffer)
        resolve({ code: typeof code === 'number' ? code : 1, output })
      })
    })
    return { execution, child: { pid: child.pid, killTree: () => killTree(child.pid) } }
  }

/** 登录验证脚本（`scripts/login_check.mjs`）的结果行。 */
const AUTH_PREFIX = 'AUTH_JSON='

function parseAuthResult(output: string): { ok: boolean; username?: string; error?: string } | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const parsed = parseStructuredLine<{ ok: boolean; username?: string; error?: string }>(line, AUTH_PREFIX)
    if (parsed) return parsed
  }
  return undefined
}

/**
 * 登录状态：settings 里有账号密码即视为已登录（凭据是登录时真实验证过才落盘的）。
 */
async function handleAuthStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET。' })
  const value = currentSettings()
  const loggedIn = text(value.username) !== '' && text(value.password) !== ''
  sendJson(res, 200, { ok: true, loggedIn, username: loggedIn ? text(value.username) : '' })
}

/**
 * 登录：凭据优先取保险库（勾选记住过的账号可不输密码），否则用表单输入；
 * 先存 settings，再用无头浏览器真实登录平台验证一次；失败回滚凭据（恢复旧值），
 * 不把错密码留在设置里。纯验证用途，不写任何平台数据。
 * remember 默认 true：验证通过后把账号密码加密存入保险库，供下次下拉选择。
 */
async function handleAuthLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
  let artifactsDir = ''
  try {
    const body = await readBody(req)
    const username = text(body.username)
    const remember = body.remember !== false
    let password = text(body.password)
    if (!username) return sendJson(res, 200, { ok: false, error: '请填写账号。' })
    if (!password) {
      // 密码留空 = 用保险库里该账号记住的密码（账号下拉选择的场景）。
      password = vault.decryptPassword(username) ?? ''
      if (!password) return sendJson(res, 200, { ok: false, error: '请填写密码（该账号没有记住的密码）。' })
    }
    const previous = currentSettings()
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
    artifactsDir = join(tmpdir(), `oh-login-check-${stamp}`)
    mkdirSync(artifactsDir, { recursive: true })
    // 先落盘（后续任务要用），验证失败再回滚。
    store.merge({ username, password })
    updateState({ kind: 'phase2', phase: 'preflight', startedAt: new Date().toISOString(), finishedAt: undefined, ok: undefined, message: '正在登录平台验证账号…', errors: undefined, progress: { percent: 30, stage: '登录验证', detail: '正在用无头浏览器真实登录平台。' } })
    const result = await runScript('login_check.mjs', ['--artifacts', artifactsDir], {
      OH_USERNAME: username,
      OH_PASSWORD: password,
    }, [username, password], undefined, undefined, undefined, 2 * 60 * 1000)
    const parsed = parseAuthResult(result.output)
    const ok = result.code === 0 && parsed?.ok === true
    updateState({ phase: 'idle', finishedAt: new Date().toISOString(), ok, message: ok ? '登录成功。' : (parsed?.error || `登录验证失败（脚本退出码 ${result.code}）。`), progress: { percent: 100, stage: ok ? '登录成功' : '登录失败', detail: ok ? `当前账号 ${username}` : (parsed?.error || '') } })
    if (!ok) {
      // 回滚凭据，避免错密码留在设置里。
      store.merge({ username: text(previous.username), password: text(previous.password) })
      return sendJson(res, 200, { ok: false, error: parsed?.error || `登录验证失败（脚本退出码 ${result.code}）。` })
    }
    if (remember && vault.available()) {
      try {
        vault.remember(username, password)
      } catch (error) {
        log(`记住密码失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    sendJson(res, 200, { ok: true, username })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 200, { ok: false, error: `登录失败：${message}` })
  }
}

/** 已记住的账号清单（不含密码材料）。 */
async function handleAuthAccounts(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET。' })
  sendJson(res, 200, { ok: true, accounts: vault.list() })
}

/** 从保险库删除指定账号。 */
async function handleAuthAccountsDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
  const body = await readBody(req)
  const username = text(body.username)
  if (!username) return sendJson(res, 200, { ok: false, error: '没有提供要删除的账号。' })
  vault.forget(username)
  sendJson(res, 200, { ok: true, accounts: vault.list() })
}

/** 退出账号：只清凭据（username/password），设备目录/测试配置等业务设置保留。 */
async function handleAuthLogout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
  store.merge({ username: '', password: '' })
  log('已退出账号（凭据已清除，业务设置保留）')
  sendJson(res, 200, { ok: true })
}

  // —— 设备连接页（盒子连接 + 空闲被测设备点选 + 配网） ——

  const DEVICE_LIST_PREFIX = 'DEVICE_LIST_JSON='
  const DEVICE_PAIR_PREFIX = 'DEVICE_PAIR_JSON='

  function parseDeviceList(output: string): { ok: boolean; devices?: Array<Record<string, unknown>> } | undefined {
    for (const line of output.split(/\r?\n/).reverse()) {
      const parsed = parseStructuredLine<{ ok: boolean; devices?: Array<Record<string, unknown>> }>(line, DEVICE_LIST_PREFIX)
      if (parsed) return parsed
    }
    return undefined
  }

  function parseDevicePair(output: string): { ok: boolean; message?: string; error?: string; addressType?: string } | undefined {
    for (const line of output.split(/\r?\n/).reverse()) {
      const parsed = parseStructuredLine<{ ok: boolean; message?: string; error?: string; addressType?: string }>(line, DEVICE_PAIR_PREFIX)
      if (parsed) return parsed
    }
    return undefined
  }

  function updateDeviceState(patch: Partial<DeviceState>): void {
    Object.assign(deviceState, patch)
  }

  /** 忙碌设备：正在运行的 XTS 测试占用的 SN 列表。 */
  function runningTestSns(): string[] {
    if (testState.phase !== 'running' && testState.phase !== 'stopping') return []
    const progress = testState.progress as Record<string, unknown> | undefined
    const devices = Array.isArray(progress?.devices) ? progress.devices : []
    return devices.map((item: unknown) => {
      const record = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
      return typeof record.sn === 'string' ? record.sn.trim() : ''
    }).filter(Boolean)
  }

  async function handleDeviceList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' && req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 POST/GET。' })
    try {
      const busy = runningTestSns().join(';')
      const args = ['--list']
      if (busy) args.push('--busy', busy)
      const result = await runScript('device_pair.mjs', args, {}, [])
      const parsed = parseStructuredLine<{ ok: boolean; devices?: Array<Record<string, unknown>>; error?: string }>(result.output.split(/\r?\n/).reverse().find((line: string) => line.startsWith('DEVICE_LIST_JSON=')) ?? '', DEVICE_LIST_PREFIX)
      if (!parsed?.ok) return sendJson(res, 200, { ok: false, error: parsed?.error || `设备列表获取失败（脚本退出码 ${result.code}）。` })
      sendJson(res, 200, { ok: true, devices: parsed.devices ?? [] })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: `设备列表失败：${message}` })
    }
  }

  /** 连接设备：USB SN = 已在线即控到（无需操作）；网络 IP:Port = hdc tconn。 */
  async function handleDeviceConnect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    try {
      const body = await readBody(req)
      const address = text(body.address)
      if (!address) return sendJson(res, 200, { ok: false, error: '没有提供设备地址（SN 或 IP:Port）。' })
      const addressType = /[.:]/.test(address) ? 'network' : 'usb'
      if (addressType === 'usb') {
        const result = await runScript('device_pair.mjs', ['--list'], {}, [])
        const online = parseDeviceList(result.output)?.devices?.map((item) => text(item.sn)) ?? []
        const isOnline = online.some((item) => item.toLowerCase() === address.toLowerCase())
        if (!isOnline) return sendJson(res, 200, { ok: false, error: `SN ${address} 不在 hdc 在线列表里，请确认设备已连接本机。` })
        return sendJson(res, 200, { ok: true, message: `SN ${address} 已在线（USB 连接），无需额外操作。`, addressType })
      }
      const result = await runScript('device_pair.mjs', ['--tconn', address], {}, [])
      const parsed = parseStructuredLine<{ ok: boolean; message?: string }>(result.output.split(/\r?\n/).reverse().find((line: string) => line.startsWith('DEVICE_TCONN_JSON=')) ?? '', 'DEVICE_TCONN_JSON=')
      if (!parsed?.ok) return sendJson(res, 200, { ok: false, error: parsed?.message || `hdc tconn ${address} 失败。` })
      sendJson(res, 200, { ok: true, message: parsed.message, addressType })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: `连接失败：${message}` })
    }
  }

  /**
   * 配网：盒子连通预检 + 拉起 dcct + 等待人工配对完成（超时可配）。
   * 后台长任务（人工配对可能耗时数分钟），进度走 /status 的 device 字段。
   */
  async function handleDevicePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    if (deviceState.phase !== 'idle') return sendJson(res, 409, { ok: false, error: '配网已在进行中，请等待当前配网结束。' })
    try {
      const body = await readBody(req)
      const value = currentSettings()
      const boxAddr = text(body.boxAddr) || text(value.testBoxSn)
      const dutSn = text(body.dutSn)
      if (!boxAddr) return sendJson(res, 200, { ok: false, error: '没有填写测试盒子地址（SN 或 IP:Port）。' })
      if (!dutSn) return sendJson(res, 200, { ok: false, error: '没有选择被测设备。' })
      const timeoutMs = Math.max(30000, Math.floor(Number(body.timeoutMs) || 5 * 60 * 1000))
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
      const artifactsDir = join(tmpdir(), `oh-device-pair-${stamp}`)
      mkdirSync(artifactsDir, { recursive: true })
      store.merge({ testBoxSn: boxAddr, deviceSns: dutSn })
      updateDeviceState({ phase: 'pairing', startedAt: new Date().toISOString(), finishedAt: undefined, ok: undefined, message: '正在连接盒子并等待配网…' })
      const execution = runScript('device_pair.mjs', [
        '--pair', '--box', boxAddr, '--dut', dutSn, '--timeout-ms', String(timeoutMs),
        '--artifacts', artifactsDir,
      ], {}, [], (progress) => {
        updateDeviceState({ message: progress.detail || progress.stage })
      })
      sendJson(res, 200, { ok: true, message: '已开始配网，进度见下方。' })
      void (async () => {
        const finishedAt = new Date().toISOString()
        try {
          const result = await execution
          const parsed = parseDevicePair(result.output)
          const ok = result.code === 0 && parsed?.ok === true
          const message = parsed?.message || parsed?.error || (ok ? '配网完成。' : `配网失败（脚本退出码 ${result.code}）。`)
          updateDeviceState({ phase: 'idle', finishedAt, ok, message })
        } catch (error) {
          const message = `配网失败：${error instanceof Error ? error.message : String(error)}`
          updateDeviceState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message })
        } finally {
          deviceProcess = null
        }
      })()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: `配网启动失败：${message}` })
    }
  }

  async function handleDeviceStopPair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST。' })
    if (deviceState.phase !== 'pairing') return sendJson(res, 200, { ok: true, message: '当前没有进行中的配网。' })
    if (deviceProcess?.killTree) deviceProcess.killTree()
    updateDeviceState({ phase: 'idle', finishedAt: new Date().toISOString(), ok: false, message: '配网已停止。' })
    sendJson(res, 200, { ok: true, message: '配网已停止。' })
  }

  const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void>([
    [`${API_PREFIX}/status`, handleStatus],
    [`${API_PREFIX}/settings`, handleSettings],
    [`${API_PREFIX}/device/list`, handleDeviceList],
    [`${API_PREFIX}/device/pair`, handleDevicePair],
    [`${API_PREFIX}/device/stop-pair`, handleDeviceStopPair],
    [`${API_PREFIX}/device/connect`, handleDeviceConnect],
    [`${API_PREFIX}/device/list`, handleDeviceList],
    [`${API_PREFIX}/device/pair`, handleDevicePair],
    [`${API_PREFIX}/device/connect`, handleDeviceConnect],
    [`${API_PREFIX}/auth/status`, handleAuthStatus],
    [`${API_PREFIX}/auth/login`, handleAuthLogin],
    [`${API_PREFIX}/auth/logout`, handleAuthLogout],
    [`${API_PREFIX}/auth/accounts`, handleAuthAccounts],
    [`${API_PREFIX}/auth/accounts/delete`, handleAuthAccountsDelete],
    [`${API_PREFIX}/paths/derive`, handlePathsDerive],
    [`${API_PREFIX}/preflight`, handlePreflight],
    [`${API_PREFIX}/save`, handleSave],
    [`${API_PREFIX}/waiver/scan`, handleWaiverScan],
    [`${API_PREFIX}/waiver/preflight`, (req, res) => handleWaiverRun(req, res, 'preflight')],
    [`${API_PREFIX}/waiver/save`, (req, res) => handleWaiverRun(req, res, 'save')],
    [`${API_PREFIX}/phase2/drafts`, handlePhase2Drafts],
    [`${API_PREFIX}/phase2/draft/unbind`, handlePhase2DraftUnbind],
    [`${API_PREFIX}/phase2/draft/verify`, handlePhase2DraftVerify],
    [`${API_PREFIX}/mirror/upload`, handleMirrorUpload],
    [`${API_PREFIX}/test/start`, handleTestStart],
    [`${API_PREFIX}/test/stop`, handleTestStop],
    [`${API_PREFIX}/test/probe`, handleTestProbe],
  ])

  // 渲染进程静态文件托管（ES module 不能走 file://，会被 CORS 拦成黑屏）。
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
  }
  function serveRenderer(url: URL, res: http.ServerResponse): boolean {
    if (!url.pathname.startsWith('/renderer/')) return false
    const relative = url.pathname.slice('/renderer/'.length).replace(/^\/+/, '')
    const file = normalize(join(rendererDir, relative || 'index.html'))
    if (!file.startsWith(normalize(rendererDir))) {
      sendJson(res, 403, { ok: false, error: '禁止访问。' })
      return true
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      // SPA 兜底：未知路径回 index.html。
      const index = join(rendererDir, 'index.html')
      if (!existsSync(index)) {
        sendJson(res, 404, { ok: false, error: `渲染进程未构建：${rendererDir}` })
        return true
      }
      res.setHeader('content-type', MIME['.html']!)
      createReadStream(index).pipe(res)
      return true
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.setHeader('content-type', type)
    createReadStream(file).pipe(res)
    return true
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (serveRenderer(url, res)) return
    const handler = routes.get(url.pathname)
    if (!handler) {
      sendJson(res, 404, { ok: false, error: '接口不存在。' })
      return
    }
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      log(`本地 API 服务已启动：http://127.0.0.1:${port}${API_PREFIX}/status`)
      resolve({
        port,
        close: () => {
          server.close()
          if (testProcess?.pid) killTree(testProcess.pid)
        },
      })
    })
  })
}
