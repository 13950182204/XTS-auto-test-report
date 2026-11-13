import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 应用自持设置存储（移植自插件 settings-store.ts，去掉 DSH/旧版迁移逻辑）。
 * 平铺 JSON、字段白名单、写入走临时文件 + rename 原子替换，0600。
 */

export const STRING_FIELDS = [
  'username',
  'password',
  'workbookPath',
  'selfCheckPath',
  'reportPath',
  'mirrorPath',
  'contactPhone',
  'contactEmail',
  'waiverPath',
  'waiverAssessmentNumber',
  'testCasesPath',
  'deviceSns',
  'testBoxSn',
] as const

export type Phase2Settings = Partial<Record<(typeof STRING_FIELDS)[number], string>>

export const DEFAULT_SETTINGS: Phase2Settings = {
  contactPhone: '13950182204',
  contactEmail: '102438@dnake.com',
  testCasesPath: 'D:\\ohos\\XTS6.1\\testcase',
  testBoxSn: '370100654d4d43202010000071dd7b00',
}

export function defaultSettingsFilePath(userDataDir: string): string {
  return join(userDataDir, 'settings.json')
}

export class SettingsStore {
  readonly filePath: string
  private cache: Phase2Settings | undefined

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private load(): Phase2Settings {
    if (this.cache !== undefined) return this.cache
    try {
      this.cache = existsSync(this.filePath) ? pickSettings(JSON.parse(readFileSync(this.filePath, 'utf8'))) : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  read(): Phase2Settings {
    return { ...DEFAULT_SETTINGS, ...this.load() }
  }

  merge(patch: Phase2Settings): Phase2Settings {
    const next: Phase2Settings = { ...this.load() }
    for (const field of STRING_FIELDS) {
      const value = patch[field]
      if (typeof value === 'string') next[field] = value.trim()
    }
    this.write(next)
    return { ...DEFAULT_SETTINGS, ...next }
  }

  private write(value: Phase2Settings): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp-${String(process.pid)}`
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.filePath)
      try {
        chmodSync(this.filePath, 0o600)
      } catch {
        // Windows 上 chmod 只影响只读位。
      }
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // 清理失败不掩盖原始错误。
      }
      throw error
    }
    this.cache = { ...value }
  }
}

/** 只保留已知字符串字段，顺手 trim；不认识的键一律丢弃。 */
export function pickSettings(value: unknown): Phase2Settings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const result: Phase2Settings = {}
  for (const field of STRING_FIELDS) {
    const raw = record[field]
    if (typeof raw === 'string') result[field] = raw.trim()
  }
  return result
}

/** 对外视图：密码只报「有没有」，绝不回显。 */
export function settingsView(settings: Phase2Settings): { settings: Omit<Phase2Settings, 'password'>; hasPassword: boolean } {
  const { password, ...rest } = settings
  return { settings: rest, hasPassword: typeof password === 'string' && password !== '' }
}
