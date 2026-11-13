import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 凭据保险库：多平台账号密码本地加密存储。
 * 加密用 Electron safeStorage（Windows = DPAPI，绑定当前 OS 用户），
 * 文件即使被拷走也无法在别的机器/用户下解密。
 */

export interface SavedAccount {
  username: string
  /** safeStorage.encryptString 的 base64；明文只存在于主进程内存。 */
  password: string
  savedAt: string
}

const FILE = 'credentials.json'

export class CredentialVault {
  private readonly filePath: string
  private cache: SavedAccount[] | undefined

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, FILE)
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private load(): SavedAccount[] {
    if (this.cache !== undefined) return this.cache
    try {
      if (!existsSync(this.filePath)) {
        this.cache = []
        return this.cache
      }
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).accounts
        : undefined
      this.cache = Array.isArray(raw)
        ? raw
          .filter((item): item is { username: string; password: string; savedAt?: string } => {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
            return typeof (item as Record<string, unknown>).username === 'string'
              && typeof (item as Record<string, unknown>).password === 'string'
          })
          .map((item) => ({
            username: String(item.username),
            password: String(item.password),
            savedAt: typeof item.savedAt === 'string' ? item.savedAt : '',
          }))
        : []
    } catch {
      this.cache = []
    }
    return this.cache
  }

  private save(accounts: SavedAccount[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 })
    this.cache = accounts
  }

  /** 已保存账号清单（不含任何密码材料）。 */
  list(): Array<{ username: string; savedAt: string }> {
    return this.load()
    .map(({ username, savedAt }) => ({ username, savedAt }))
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
  }

  has(username: string): boolean {
    const key = username.trim().toLowerCase()
    return this.load().some((account) => account.username.toLowerCase() === key)
  }

  /** 取某账号的明文密码（仅主进程内存使用，绝不返回给渲染进程）。 */
  decryptPassword(username: string): string | undefined {
    const key = username.trim().toLowerCase()
    const account = this.load().find((item) => item.username.toLowerCase() === key)
    if (!account) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(account.password, 'base64'))
    } catch {
      return undefined
    }
  }

  /** 记住账号密码（加密落盘）；同名覆盖。可用性异常时抛中文错误。 */
  remember(username: string, password: string): void {
    if (!this.available()) {
      throw new Error('本机不支持凭据加密存储（safeStorage 不可用），无法记住密码。')
    }
    const encrypted = safeStorage.encryptString(password).toString('base64')
    const accounts = this.load().filter((item) => item.username.toLowerCase() !== username.trim().toLowerCase())
    accounts.push({ username: username.trim(), password: encrypted, savedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
    this.save(accounts)
  }

  forget(username: string): void {
    const key = username.trim().toLowerCase()
    this.save(this.load().filter((item) => item.username.toLowerCase() !== key))
  }
}
