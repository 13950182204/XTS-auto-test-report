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
      <div className="page-head--bar">
        <h1>测试盒子</h1>
        <span className="page-head__meta">只确认盒子在线 · USB 即插即用 · 网络走 hdc tconn · DCTS 配网由应用自动执行</span>
      </div>
      <div className="workbench">
        <div className="workbench__main">
          <Panel title="盒子地址" meta="填 SN 或 IP:Port，自动识别" actions={
            <button className="btn btn--small" disabled={listLoading} onClick={() => void refreshList()}>{listLoading ? '刷新中…' : '刷新'}</button>
          }>
            <div className="dev-input-row">
              <input className="input input--mono" value={boxAddr} placeholder="SN 或 IP:Port"
                onChange={(event) => setBoxAddr(event.target.value)} />
              {boxAddrType !== 'unknown' ? <span className="chip chip--acts">{boxAddrType === 'usb' ? 'USB' : '网络'}</span> : null}
              <span className={`dot ${boxOnline ? 'dot--on' : 'dot--off'}`} />
              <button className="btn btn--primary" disabled={!boxAddr.trim()} onClick={() => connectBox()}>连接</button>
            </div>
          </Panel>

          <Panel title="DCTS 配网" meta="自动执行 · 无需人工">
            {pairing ? (
              <div className="row fade">
                <span className="spinner" />
                <div className="row-main">
                  <span className="row-title">{str(device.message) || '正在连接盒子并等待 dcct 配对…'}</span>
                </div>
                <span className="dots"><span /><span /><span /></span>
              </div>
            ) : (
              <p className="empty">测试盒子空闲。跑到 DCTS 时会自动触发盒子与被测设备的配网，进度显示在这里。</p>
            )}
          </Panel>

          {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
          {pageNote ? <StatusLine tone="ok">{pageNote}</StatusLine> : null}
        </div>
        <div className="workbench__side">
          <Panel title="盒子状态" meta={boxOnline ? '在线' : '离线'}>
            {boxAddr.trim() ? (
              <div className={`row ${boxOnline ? 'row--ready' : ''}`}>
                <div className="row-top">
                  <span className={`dot ${boxOnline ? 'dot--on' : 'dot--off'}`} />
                  <span className="name" title={boxAddr}>{boxAddr}</span>
                  <span className={`chip ${boxOnline ? 'chip--ok' : 'chip--blocked'} push-right`}>{boxOnline ? '在线' : '离线'}</span>
                </div>
                <p className="path">{boxAddrType === 'usb' ? 'USB 连接' : '网络连接（hdc tconn）'}</p>
              </div>
            ) : (
              <p className="empty">还没有填写盒子地址。</p>
            )}
          </Panel>
          <Panel title="说明" fill>
            <p className="note">盒子经 hdc 连接本机（USB 或网络），不是被测设备。绿点 = 在线；DCTS 前会自动触发盒子与被测设备的配网（拉起 dcct → 自动配对 → 连接确认），无需在此页手动操作。</p>
          </Panel>
        </div>
      </div>
    </>
  )
}
