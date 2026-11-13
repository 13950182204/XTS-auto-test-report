import { useState, type ReactElement } from 'react'
import { request } from '../api.js'
import { Field, StatusLine } from '../components.js'

/** 登录页：平台账号真实登录验证；支持记住多个账号（本地加密），下拉选择免输密码。 */

type SavedAccount = { username: string; savedAt: string }

export function LoginPage(props: { onLoggedIn: (username: string) => void }): ReactElement {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [accounts, setAccounts] = useState<SavedAccount[]>([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function loadAccounts(): Promise<void> {
    const response = await request<{ ok: boolean; accounts?: SavedAccount[] }>('auth/accounts', 'GET')
    if (response.ok) setAccounts(response.accounts ?? [])
  }

  function pickAccount(account: SavedAccount): void {
    setUsername(account.username)
    setPassword('')
    setDropdownOpen(false)
  }

  async function removeAccount(account: SavedAccount): Promise<void> {
    const response = await request<{ ok: boolean; accounts?: SavedAccount[] }>('auth/accounts/delete', 'POST', { username: account.username })
    if (response.ok) {
      setAccounts(response.accounts ?? [])
      if (username === account.username) setUsername('')
    }
  }

  async function login(): Promise<void> {
    setBusy(true)
    setError('')
    const response = await request<{ ok: boolean; message?: string; error?: string; username?: string }>('auth/login', 'POST', {
      username: username.trim(),
      password,
      remember,
    })
    setBusy(false)
    if (!response.ok) {
      setError(response.message || '登录失败。')
      return
    }
    props.onLoggedIn(response.username ?? username.trim())
  }

  const savedPasswordAvailable = password === '' && accounts.some((account) => account.username === username.trim())

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <span className="sidebar__logo">XT</span>
          <div className="login__brand-name">
            <b>OpenHarmony XTS 报告上传</b>
            <span>使用兼容性测评平台账号登录</span>
          </div>
        </div>

        <div className="field">
          <span className="label">平台账号</span>
          <input
            id="l-username"
            className="input"
            value={username}
            placeholder="账号 / 手机号 / 邮箱"
            autoComplete="off"
            disabled={busy}
            onFocus={() => { void loadAccounts(); setDropdownOpen(accounts.length > 0 || true) }}
            onBlur={() => { window.setTimeout(() => setDropdownOpen(false), 150) }}
            onChange={(event) => { setUsername(event.target.value); setDropdownOpen(false) }}
          />
          {dropdownOpen && accounts.length > 0 ? (
            <div className="account-menu">
              {accounts.map((account) => (
                <div
                  className={`account-menu__item${account.username === username.trim() ? ' account-menu__item--active' : ''}`}
                  key={account.username}
                  onMouseDown={(event) => { event.preventDefault(); pickAccount(account) }}
                >
                  <span className="account-menu__name" onMouseDown={(event) => { event.preventDefault(); pickAccount(account) }}>{account.username}</span>
                  <button
                    className="account-menu__remove"
                    title="删除此账号"
                    onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void removeAccount(account) }}
                  >×</button>
                </div>
              ))}
            </div>
          ) : null}
          {savedPasswordAvailable ? <span className="hint">已记住该账号，密码留空即可直接登录。</span> : null}
        </div>

        <Field id="l-password" label="平台密码" type="password" value={password} disabled={busy}
          placeholder={savedPasswordAvailable ? '已记住，留空直接登录' : undefined}
          onChange={setPassword} />

        <label className="login__remember">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
          <span>记住密码（本机加密保存，可存多个账号）</span>
        </label>

        <div className="actions">
          <button className="btn btn--primary" disabled={busy || !username.trim()} onClick={() => void login()}>
            {busy ? '正在登录平台…' : '登录'}
          </button>
        </div>
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      </div>
    </div>
  )
}
