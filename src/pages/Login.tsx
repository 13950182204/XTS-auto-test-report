import { useState, type ReactElement } from 'react'
import { request } from '../api.js'
import { Field, StatusLine } from '../components.js'

/** 登录页：平台账号真实登录验证（无头浏览器）通过后进入主界面。 */

export function LoginPage(props: { onLoggedIn: (username: string) => void }): ReactElement {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function login(): Promise<void> {
    setBusy(true)
    setError('')
    const response = await request<{ ok: boolean; message?: string; error?: string; username?: string }>('auth/login', 'POST', {
      username: username.trim(),
      password,
    })
    setBusy(false)
    if (!response.ok) {
      setError(response.message || '登录失败。')
      return
    }
    props.onLoggedIn(response.username ?? username.trim())
  }

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
        <Field id="l-username" label="平台账号" value={username} disabled={busy} onChange={setUsername} />
        <Field id="l-password" label="平台密码" type="password" value={password} disabled={busy}
          onChange={setPassword} hint="登录会用无头浏览器真实登录平台验证一次；凭据只保存在本机（0600）。" />
        <div className="actions">
          <button className="btn btn--primary" disabled={busy || !username.trim() || !password} onClick={() => void login()}>
            {busy ? '正在登录平台…' : '登录'}
          </button>
        </div>
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
        <p className="note">忘记密码请到兼容性测评平台找回；退出账号可在主界面侧边栏底部操作，设备目录等配置会保留。</p>
      </div>
    </div>
  )
}
