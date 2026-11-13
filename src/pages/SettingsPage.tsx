import { useEffect, useState , type ReactElement } from 'react'
import { request, type RunState, type TestState } from '../api.js'
import { Field, Panel, StatusLine } from '../components.js'

/** 设置页：账号 / 默认路径 / 测试盒子等集中管理。 */

const FIELDS: Array<{ id: string; label: string; hint?: string; mono?: boolean; wide?: boolean; type?: string }> = [
  { id: 'username', label: '平台账号' },
  { id: 'password', label: '平台密码', type: 'password', hint: '已保存则留空沿用；输入新值即覆盖。' },
  { id: 'workbookPath', label: '设备目录（或批量父目录）', mono: true, wide: true },
  { id: 'testCasesPath', label: '测试用例路径（XTS 自动测试）', mono: true, wide: true, hint: 'xts-acts 套件根目录，默认 D:\\ohos\\XTS6.1\\testcase。' },
  { id: 'testBoxSn', label: '测试盒子 SN（DCTS 必需）', mono: true, wide: true, hint: '盒子经 hdc 连接本机；默认 370100654d4d43202010000071dd7b00。' },
  { id: 'mirrorPath', label: '固件包路径（默认值）', mono: true, wide: true },
  { id: 'contactPhone', label: '企业联系电话' },
  { id: 'contactEmail', label: '企业邮箱' },
  { id: 'waiverPath', label: '豁免资料路径（默认值）', mono: true, wide: true },
  { id: 'waiverAssessmentNumber', label: '测评编号（豁免默认值）' },
]

export function SettingsPage(props: { state: RunState; test: TestState }): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({})
  const [hasPassword, setHasPassword] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [note, setNote] = useState('')
  const [noteTone, setNoteTone] = useState<'ok' | 'error'>('ok')

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string>; hasPassword?: boolean }>('settings', 'GET')
      if (!active || !response.ok || !response.settings) return
      setValues(response.settings)
      setHasPassword(response.hasPassword === true)
      setLoaded(true)
    })()
    return () => { active = false }
  }, [])

  async function save(): Promise<void> {
    const patch: Record<string, string> = {}
    for (const field of FIELDS) patch[field.id] = (values[field.id] ?? '').trim()
    if (!patch.password) delete patch.password
    const response = await request<{ ok: boolean; message?: string }>('settings', 'POST', patch)
    setNoteTone(response.ok ? 'ok' : 'error')
    setNote(response.ok ? '设置已保存。' : (response.message || '设置保存失败。'))
    if (response.ok && patch.password) {
      setHasPassword(true)
      setValues((previous) => ({ ...previous, password: '' }))
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>设置</h1>
        <p>账号、默认路径与测试配置集中管理；设置持久化在本机用户数据目录（0600）。</p>
      </div>

      <Panel title="全部设置" meta={hasPassword ? '已保存密码' : '未保存密码'}>
        <div className="grid">
          {FIELDS.map((field) => (
            <Field
              key={field.id}
              id={`s-${field.id}`}
              label={field.label}
              value={values[field.id] ?? ''}
              type={field.id === 'password' ? 'password' : 'text'}
              hint={field.id === 'password' && hasPassword ? '已保存密码，留空则沿用' : field.hint}
              placeholder={field.id === 'password' && hasPassword ? '已保存密码，留空则沿用' : undefined}
              mono={field.mono}
              wide={field.wide}
              onChange={(value) => setValues((previous) => ({ ...previous, [field.id]: value }))}
            />
          ))}
        </div>
        <div className="actions">
          <button className="btn btn--primary" disabled={!loaded} onClick={() => void save()}>保存全部设置</button>
        </div>
        {!loaded ? <p className="muted">正在读取设置…</p> : null}
        {note ? <StatusLine tone={noteTone}>{note}</StatusLine> : null}
      </Panel>
    </>
  )
}
