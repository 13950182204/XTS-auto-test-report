/**
 * XTS 自动测试脚本（`scripts/xts_run_test.mjs` / `scripts/xts_probe_devices.mjs`）的
 * stdout 行协议解析（与 mirror-progress.ts 同款约定：纯函数、单行 JSON、不含凭据）。
 *
 * - 进度行 `XTS_TEST_PROGRESS={"percent":…,"stage":…,"suite":…,"devices":[…],"etaSeconds":…}`
 * - 轮次行 `XTS_TEST_ROUND={"suite":"acts","round":2,"ok":false,"failedModules":[…],"archivedTo":"…"}`
 * - 结果行 `XTS_TEST_RESULT={"ok":…,"message":…,"rounds":[…],"unpassed":[…]}`
 */

export const XTS_TEST_PROGRESS_PREFIX = 'XTS_TEST_PROGRESS='
export const XTS_TEST_ROUND_PREFIX = 'XTS_TEST_ROUND='
export const XTS_TEST_RESULT_PREFIX = 'XTS_TEST_RESULT='
export const XTS_PROBE_RESULT_PREFIX = 'XTS_PROBE_RESULT='

/** 进度行里的单台设备视图（done 为该设备已开始执行的模块序号，完成总数以顶层为准）。 */
export type XtsTestDevice = {
  sn: string
  currentModule?: string
  done?: number
  total?: number
}

export type XtsTestProgress = {
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

export type XtsTestRound = {
  suite: string
  suiteIndex?: number
  suiteTotal?: number
  round: number
  ok: boolean
  failedModules: string[]
  archivedTo?: string
  message?: string
  /** 前置检查未过被跳过（如 DCTS 盒子连通预检失败）——没跑，不算失败模块。 */
  skipped?: boolean
}

export type XtsTestResult = {
  ok: boolean
  message?: string
  plan?: Array<{ suite: string; mode: string; modules?: number }>
  screens?: Record<string, string>
  rounds?: XtsTestRound[]
  unpassed?: Array<{ suite: string; module: string }>
  /** 前置检查未过被跳过的套件（如 DCTS 盒子连通预检失败）。 */
  skipped?: Array<{ suite: string; reason: string }>
  artifacts?: string
  dryRun?: boolean
  commands?: Array<{ suite: string; command: string }>
}

/** 探测脚本（--probe-only 语义）的结果行。 */
export type XtsProbeDevice = {
  sn: string
  online: boolean
  screen?: 'yes' | 'no'
}

/** 测试盒子探测结果（/test/probe 附加项）。 */
export type XtsProbeBox = {
  sn: string
  online: boolean
  ip?: string
  sameSubnet?: boolean
}

export type XtsProbeResult = {
  ok: boolean
  message?: string
  screen?: 'yes' | 'no' | 'mixed' | 'unknown'
  devices?: XtsProbeDevice[]
  box?: XtsProbeBox
  error?: string
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function clampPercent(value: unknown): number | undefined {
  const number = finiteNumber(value)
  if (number === undefined) return undefined
  return Math.max(0, Math.min(100, Math.round(number)))
}

function parseObject(line: string, prefix: string): Record<string, unknown> | undefined {
  if (!line.startsWith(prefix)) return undefined
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function parseDevices(value: unknown): XtsTestDevice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const devices: XtsTestDevice[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const sn = trimText(record.sn)
    if (!sn) continue
    const device: XtsTestDevice = { sn }
    const currentModule = trimText(record.currentModule)
    if (currentModule) device.currentModule = currentModule
    const done = finiteNumber(record.done)
    if (done !== undefined && done >= 0) device.done = Math.round(done)
    const total = finiteNumber(record.total)
    if (total !== undefined && total >= 0) device.total = Math.round(total)
    devices.push(device)
  }
  return devices
}

/** 进度行：percent/stage 缺一不可（非法行被忽略，前端保留上一条进度）。 */
export function parseXtsTestProgressLine(line: string): XtsTestProgress | undefined {
  const value = parseObject(line, XTS_TEST_PROGRESS_PREFIX)
  if (!value) return undefined
  const percent = clampPercent(value.percent)
  const stage = trimText(value.stage)
  if (percent === undefined || !stage) return undefined
  const progress: XtsTestProgress = { percent, stage }
  const detail = trimText(value.detail)
  if (detail) progress.detail = detail
  const suite = trimText(value.suite)
  if (suite) progress.suite = suite
  const suiteIndex = finiteNumber(value.suiteIndex)
  if (suiteIndex !== undefined) progress.suiteIndex = Math.round(suiteIndex)
  const suiteTotal = finiteNumber(value.suiteTotal)
  if (suiteTotal !== undefined) progress.suiteTotal = Math.round(suiteTotal)
  const round = finiteNumber(value.round)
  if (round !== undefined) progress.round = Math.round(round)
  const devices = parseDevices(value.devices)
  if (devices && devices.length > 0) progress.devices = devices
  const etaSeconds = finiteNumber(value.etaSeconds)
  if (etaSeconds !== undefined && etaSeconds >= 0) progress.etaSeconds = Math.round(etaSeconds)
  return progress
}

/** 轮次行：suite/round/ok 是契约字段；failedModules 缺省为空数组。 */
export function parseXtsTestRoundLine(line: string): XtsTestRound | undefined {
  const value = parseObject(line, XTS_TEST_ROUND_PREFIX)
  if (!value || typeof value.ok !== 'boolean') return undefined
  const suite = trimText(value.suite)
  const round = finiteNumber(value.round)
  if (!suite || round === undefined) return undefined
  const failedModules = Array.isArray(value.failedModules)
    ? value.failedModules.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const parsed: XtsTestRound = { suite, round: Math.round(round), ok: value.ok, failedModules }
  const suiteIndex = finiteNumber(value.suiteIndex)
  if (suiteIndex !== undefined) parsed.suiteIndex = Math.round(suiteIndex)
  const suiteTotal = finiteNumber(value.suiteTotal)
  if (suiteTotal !== undefined) parsed.suiteTotal = Math.round(suiteTotal)
  const archivedTo = trimText(value.archivedTo)
  if (archivedTo) parsed.archivedTo = archivedTo
  if (value.skipped === true) parsed.skipped = true
  const message = trimText(value.message)
  if (message) parsed.message = message
  return parsed
}

/** 结果行：ok 必须是布尔值；其余字段能取到就带上。 */
export function parseXtsTestResultLine(line: string): XtsTestResult | undefined {
  const value = parseObject(line, XTS_TEST_RESULT_PREFIX)
  if (!value || typeof value.ok !== 'boolean') return undefined
  const result: XtsTestResult = { ok: value.ok }
  const message = trimText(value.message)
  if (message) result.message = message
  const artifacts = trimText(value.artifacts)
  if (artifacts) result.artifacts = artifacts
  if (value.dryRun === true) result.dryRun = true
  if (Array.isArray(value.plan)) {
    result.plan = value.plan
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        suite: trimText(item.suite),
        mode: trimText(item.mode),
        modules: finiteNumber(item.modules),
      }))
      .filter((item) => item.suite !== '')
  }
  if (value.screens !== null && typeof value.screens === 'object' && !Array.isArray(value.screens)) {
    const screens: Record<string, string> = {}
    for (const [sn, screen] of Object.entries(value.screens as Record<string, unknown>)) {
      const text = trimText(screen)
      if (sn && text) screens[sn] = text
    }
    if (Object.keys(screens).length > 0) result.screens = screens
  }
  if (Array.isArray(value.rounds)) {
    result.rounds = value.rounds
      .map((item) => (typeof item === 'string' ? undefined : parseXtsTestRoundLine(`${XTS_TEST_ROUND_PREFIX}${JSON.stringify(item)}`)))
      .filter((item): item is XtsTestRound => item !== undefined)
  }
  if (Array.isArray(value.unpassed)) {
    result.unpassed = value.unpassed
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ suite: trimText(item.suite), module: trimText(item.module) }))
      .filter((item) => item.suite !== '' || item.module !== '')
  }
  if (Array.isArray(value.skipped)) {
    result.skipped = value.skipped
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ suite: trimText(item.suite), reason: trimText(item.reason) }))
      .filter((item) => item.suite !== '' || item.reason !== '')
  }
  if (Array.isArray(value.commands)) {
    result.commands = value.commands
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ suite: trimText(item.suite), command: trimText(item.command) }))
      .filter((item) => item.command !== '')
  }
  return result
}

/** 探测结果行（scripts/xts_probe_devices.mjs）。 */
export function parseXtsProbeResultLine(line: string): XtsProbeResult | undefined {
  const value = parseObject(line, XTS_PROBE_RESULT_PREFIX)
  if (!value || typeof value.ok !== 'boolean') return undefined
  const result: XtsProbeResult = { ok: value.ok }
  const message = trimText(value.message)
  if (message) result.message = message
  const error = trimText(value.error)
  if (error) result.error = error
  const screen = trimText(value.screen)
  if (['yes', 'no', 'mixed', 'unknown'].includes(screen)) result.screen = screen as XtsProbeResult['screen']
  if (value.box !== null && typeof value.box === 'object' && !Array.isArray(value.box)) {
    const record = value.box as Record<string, unknown>
    const boxSn = trimText(record.sn)
    if (boxSn) {
      result.box = { sn: boxSn, online: record.online === true }
      const boxIp = trimText(record.ip)
      if (boxIp) result.box.ip = boxIp
      if (record.sameSubnet === true) result.box.sameSubnet = true
    }
  }
  if (Array.isArray(value.devices)) {
    result.devices = value.devices
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
      .map((item) => {
        const sn = trimText(item.sn)
        const device: XtsProbeDevice = { sn, online: item.online === true }
        const deviceScreen = trimText(item.screen)
        if (deviceScreen === 'yes' || deviceScreen === 'no') device.screen = deviceScreen
        return device
      })
      .filter((item) => item.sn !== '')
  }
  return result
}
