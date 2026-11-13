import { useEffect, useState, type ReactElement } from 'react'
import { request, type DeviceListResponse, type DeviceState } from '../api.js'
import { Panel, StatusLine, str } from '../components.js'

/** 测试盒子页：只管盒子连接（SN / IP:Port 自动识别），在线即确认可用。 */

export function TestBoxPage(props: { device: DeviceState }): ReactElement {
  const { device } = props
  const [boxAddr, setBoxAddr] = useState('')
  const [boxAddrType, setBoxAddrType] = useState<'usb' | 'network' | 'unknown'>('unknown')
  const [boxOnline, setBoxOnline] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pageNote, setPageNote] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string> }>('settings', 'GET')
      if (active && response.ok && response.settings) setBoxAddr(response.settings.testBoxSn ?? '')
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    setBoxAddrType(
      !boxAddr.trim() ? 'unknown' : /[.:]/.test(boxAddr.trim()) ? 'network' : 'usb',
    )
  }, [boxAddr])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshList() }, 400)
    return () => { window.clearTimeout(timer) }
  }, [boxAddr])

  async function refreshList(): Promise<void> {
    setListLoading(true)
    const response = await request<DeviceListResponse>('device/list', 'GET')
    setListLoading(false)
    if (response.ok) setBoxOnline((response.devices ?? []).some((item) => item.sn === boxAddr.trim()))
  }

  function connectBox(): void {
    setPageError(''); setPageNote('')
    void (async () => {
      const response = await request<{ ok: boolean; message?: string; error?: string }>('device/connect', 'POST', { address: boxAddr.trim() })
      if (!response.ok) setPageError(response.message || '连接失败。')
      else setPageNote(response.message || '已连接。')
      void refreshList()
    })()
  }

  const pairing = device.phase === 'pairing'

  return (
    <>
      <div className="page-head">
        <h1>测试盒子</h1>
        <p>确认盒子在线；DCTS 前会自动触发盒子与被测设备的配网。</p>
      </div>

      <Panel title="测试盒子" meta="填 SN 或 IP:Port，自动识别">
        <div className="dev-input-row">
          <input className="input input--mono" value={boxAddr} placeholder="SN 或 IP:Port"
            onChange={(event) => setBoxAddr(event.target.value)} />
          {boxAddrType !== 'unknown' ? <span className="chip chip--acts">{boxAddrType === 'usb' ? 'USB' : '网络'}</span> : null}
          <span className={`dot ${boxOnline ? 'dot--on' : 'dot--off'}`} />
        </div>
        <div className="actions">
          <button className="btn" disabled={listLoading} onClick={() => void refreshList()}>{listLoading ? '刷新中…' : '刷新'}</button>
          <button className="btn" disabled={!boxAddr.trim()} onClick={() => connectBox()}>连接</button>
        </div>
        {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
        {pageNote ? <StatusLine tone="ok">{pageNote}</StatusLine> : null}
      </Panel>

      {pairing ? (
        <Panel title="配网进行中" meta="DCTS 前置">
          <div className="row fade">
            <span className="spinner" />
            <div className="row-main">
              <span className="row-title">{str(device.message) || '正在连接盒子并等待 dcct 配对…'}</span>
            </div>
            <span className="dots"><span /><span /><span /></span>
          </div>
        </Panel>
      ) : null}
    </>
  )
}
