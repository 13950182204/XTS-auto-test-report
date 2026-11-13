import { useEffect, useState, type ReactElement } from 'react'
import { request, type DeviceListResponse, type DeviceState, type DeviceListItem } from '../api.js'
import { Panel, StatusLine, str } from '../components.js'

/** 设备连接页：盒子一行（SN/IP 自动识别）+ 空闲被测设备点选 + 配网状态。 */

function snShort(sn: string): string {
  return sn.length > 18 ? `${sn.slice(0, 8)}…${sn.slice(-6)}` : sn
}

function detectType(address: string): 'usb' | 'network' | 'unknown' {
  if (!address.trim()) return 'unknown'
  return /[.:]/.test(address.trim()) ? 'network' : 'usb'
}

type AddressType = 'usb' | 'network' | 'unknown'

function AddressTypeChip(props: { addressType: AddressType }): ReactElement | null {
  if (props.addressType === 'unknown') return null
  return <span className="chip chip--acts">{props.addressType === 'usb' ? '已识别 USB' : '已识别 网络'}</span>
}

export function DevicesPage(props: { device: DeviceState; onNavigate: (page: 'test') => void }): ReactElement {
  const { device } = props
  const [boxAddr, setBoxAddr] = useState('')
  const [boxAddrType, setBoxAddrType] = useState<AddressType>('unknown')
  const [boxOnline, setBoxOnline] = useState(false)
  const [devices, setDevices] = useState<DeviceListItem[]>([])
  const [selectedDut, setSelectedDut] = useState('')
  const [listLoading, setListLoading] = useState(false)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pageNote, setPageNote] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      const response = await request<{ ok: boolean; settings?: Record<string, string> }>('settings', 'GET')
      if (active && response.ok && response.settings) {
        setBoxAddr(response.settings.testBoxSn ?? '')
        setLoaded(true)
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => { setBoxAddrType(detectType(boxAddr)) }, [boxAddr])

  useEffect(() => {
    if (!loaded) return
    const timer = window.setTimeout(() => { void refreshList() }, 400)
    return () => { window.clearTimeout(timer) }
  }, [boxAddr, loaded])

  async function refreshList(): Promise<void> {
    setListLoading(true)
    const response = await request<DeviceListResponse>('device/list', 'GET')
    setListLoading(false)
    if (response.ok) {
      setDevices(response.devices ?? [])
      setBoxOnline((response.devices ?? []).some((item) => item.sn === boxAddr.trim()))
    }
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

  function pairNow(): void {
    setPairingBusy(true); setPageError(''); setPageNote('')
    void (async () => {
      const response = await request<{ ok: boolean; message?: string; error?: string }>('device/pair', 'POST', {
        boxAddr: boxAddr.trim(), dutSn: selectedDut.trim(),
      })
      if (!response.ok) { setPageError(response.message || '配网启动失败。'); setPairingBusy(false); return }
      setPageNote(response.message || '已开始配网。')
    })()
  }

  function stopPair(): void {
    void request('device/stop-pair', 'POST')
  }

  // 配网结束刷新状态
  useEffect(() => {
    if (device.phase === 'idle' && device.finishedAt && pairingBusy) {
      setPairingBusy(false)
      if (device.ok) setPageNote(device.message || '配网完成。')
      else setPageError(device.message || '配网失败。')
    }
  }, [device.phase, device.finishedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const idleDevices = devices.filter((item) => !item.busy)
  const pairing = device.phase === 'pairing'

  return (
    <>
      <div className="page-head">
        <h1>设备连接</h1>
        <p>测试盒子和被测设备的连接与配网管理。</p>
      </div>

      <Panel title="测试盒子" meta="填 SN 或 IP:Port，自动识别">
        <div className="dev-input-row">
          <input className="input input--mono" value={boxAddr} placeholder="SN 或 IP:Port"
            disabled={pairing} onChange={(event) => { setBoxAddr(event.target.value); setLoaded(true) }} />
          <AddressTypeChip addressType={boxAddrType} />
          <span className={`dot ${boxOnline ? 'dot--on' : 'dot--off'}`} />
        </div>
        <div className="actions">
          <button className="btn" disabled={pairing} onClick={() => void refreshList()}>刷新在线</button>
          <button className="btn" disabled={pairing || !boxAddr.trim()} onClick={() => connectBox()}>连接</button>
        </div>
        {pageError ? <StatusLine tone="error">{pageError}</StatusLine> : null}
        {pageNote ? <StatusLine tone="ok">{pageNote}</StatusLine> : null}
      </Panel>

      <Panel title="被测设备" meta={`空闲 ${idleDevices.length} 台 · 点选即定`}>
        {listLoading ? (
          <div className="dev-skeletons"><div className="sk" /><div className="sk" /><div className="sk" /></div>
        ) : idleDevices.length > 0 ? (
          <div className="picker">
            {idleDevices.map((item) => (
              <div className={`pick-item${selectedDut === item.sn ? ' sel' : ''}`} key={item.sn}
                onClick={() => { setSelectedDut(item.sn); setPageError('') }}>
                <span className={`dot ${selectedDut === item.sn ? 'dot--on' : 'dot--idle'}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="pick-title">{item.sn === boxAddr.trim() ? '测试盒子（当前盒子）' : `设备 · ${item.type === 'network' ? '网络' : 'USB'}`}</div>
                  <div className="pick-sub">{`${snShort(item.sn)}${item.ip ? ` · ${item.ip}` : ''}`}</div>
                </div>
                {selectedDut === item.sn ? <span className="chip chip--sel">已选择</span> : <span className="chip">空闲</span>}
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">当前没有空闲设备（hdc 在线且未参与测试）。请连接设备后点「刷新在线」。</p>
        )}
      </Panel>

      {selectedDut || pairing ? (
        <Panel title="连接状态" meta={pairing ? '配网进行中' : boxOnline && selectedDut ? '盒子在线 · 被测设备已选' : '待连接'}>
          {pairing ? (
            <>
              <div className="row fade">
                <span className="spinner" />
                <div className="row-main">
                  <span className="row-title">配网进行中</span>
                  <span className="row-sub">{str(device.message) || '正在连接盒子并等待 dcct 配对…'}</span>
                </div>
                <span className="dots"><span /><span /><span /></span>
              </div>
              <div className="actions">
                <button className="btn btn--small" onClick={() => stopPair()}>停止配网</button>
              </div>
            </>
          ) : boxOnline && selectedDut ? (
            <div className="row fade">
              <span className="dot dot--on" />
              <div className="row-main">
                <span className="row-title">{`盒子 ${snShort(boxAddr.trim())} · 被测设备 ${snShort(selectedDut)}`}</span>
                <span className="row-sub">已就绪：可在「XTS 自动测试」页开始测试（DCTS 前会自动配网）</span>
              </div>
              <button className="btn btn--small" style={{ marginLeft: 'auto' }} onClick={() => props.onNavigate('test')}>去测试 ›</button>
            </div>
          ) : (
            <div className="row fade" style={{ opacity: .5 }}>
              <span className="dot dot--off" />
              <div className="row-main">
                <span className="row-title">待连接</span>
                <span className="row-sub">连接盒子和被测设备后可开始 DCTS 配网</span>
              </div>
            </div>
          )}
        </Panel>
      ) : null}

      <p className="note">盒子地址填 SN（USB）或 IP:Port（网络），自动识别。被测设备从空闲列表点选；DCTS 前会自动完成盒子连通预检与 dcct 配对（超时 5 分钟跳过 DCTS）。</p>
    </>
  )
}
