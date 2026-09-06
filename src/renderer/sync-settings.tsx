import { SyncChangeDetails } from './sync-change-details'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SyncApi, SyncCompletedResult, SyncDeviceSummary, SyncPageState } from '../shared/types'

const EMPTY_STATE: SyncPageState = {
  active: false,
  localDevice: null,
  nearbyDevices: [],
  trustedDevices: [],
  pairing: null,
  incoming: null,
  operation: null,
  resumableTransfers: [],
  lastCompleted: null,
  diagnostic: null,
}

export interface SyncDiscoveryNotice {
  severity: 'degraded' | 'unavailable'
  title: string
  message: string
}

export function getSyncDiscoveryNotice(state: Pick<SyncPageState,
  'diagnostic' | 'nearbyDevices' | 'trustedDevices'>): SyncDiscoveryNotice | null {
  const diagnostic = state.diagnostic?.trim()
  if (!diagnostic) return null
  const alternatePathActive = /partially limited|alternate path is active/i.test(diagnostic)
  const verifiedDeviceAvailable = [...state.nearbyDevices, ...state.trustedDevices]
    .some((peer) => peer.online && peer.reachability === 'online')
  const detail = localizeDiscoveryDiagnostic(diagnostic)
  if (alternatePathActive || verifiedDeviceAvailable) {
    return {
      severity: 'degraded',
      title: '部分发现方式受限',
      message: alternatePathActive
        ? '部分自动发现方式暂时受限，但替代发现路径已经启用，可以继续同步。'
        : `${detail} 已验证设备仍然可用，可以继续同步。`,
    }
  }
  return {
    severity: 'unavailable',
    title: '局域网设备发现不可用',
    message: `${detail} 暂未找到可用的替代路径，请检查 Wi-Fi、以太网及防火墙设置。`,
  }
}

function localizeDiscoveryDiagnostic(diagnostic: string): string {
  if (!/^Local sync\b/i.test(diagnostic)) return diagnostic
  if (/no active Wi-Fi or Ethernet/i.test(diagnostic)) {
    return '未找到可用于局域网发现的 Wi-Fi 或以太网连接。'
  }
  if (/multicast receive|UDP receive/i.test(diagnostic)) {
    return '多播发现暂时无法接收设备消息。'
  }
  if (/multicast send/i.test(diagnostic)) {
    return '多播发现暂时无法发送设备消息。'
  }
  if (/directed broadcast/i.test(diagnostic)) {
    return '局域网广播发现暂时不可用。'
  }
  if (/DNS-SD|registration failed/i.test(diagnostic)) {
    return '系统设备发现服务暂时不可用。'
  }
  if (/subnet scan/i.test(diagnostic)) {
    return '局域网扫描暂时不可用。'
  }
  return '局域网设备发现暂时不可用。'
}

export function SyncSettingsPanel({ api, onError, onDataChanged, compact = false }: {
  api: SyncApi
  onError(message: string): void
  onDataChanged?(): void | Promise<void>
  compact?: boolean
}) {
  const [state, setState] = useState<SyncPageState>(EMPTY_STATE)
  const [busy, setBusy] = useState<string | null>('open')
  const pageOpened = useRef(false)
  const observedCompletion = useRef<string | null>(null)
  const refresh = useCallback(async () => setState(await api.refreshDiscovery()), [api])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setInterval> | null = null
    let lifecycle: Promise<void> = Promise.resolve()
    const clearTimer = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    const open = () => {
      clearTimer()
      lifecycle = lifecycle.then(async () => {
        if (disposed || document.visibilityState !== 'visible') return
        setBusy('open')
        const next = await api.openPage()
        if (disposed || document.visibilityState !== 'visible') {
          await api.closePage()
          return
        }
        observedCompletion.current = syncCompletionIdentity(next.lastCompleted)
        pageOpened.current = true
        setState(next)
        setBusy(null)
        timer = setInterval(() => {
          api.getState().then((latest) => { if (!disposed) setState(latest) }).catch((reason) => {
            if (!disposed) onError(messageOf(reason))
          })
        }, 1_200)
      }).catch((reason) => {
        if (!disposed) {
          setBusy(null)
          onError(messageOf(reason))
        }
      })
    }
    const close = () => {
      clearTimer()
      lifecycle = lifecycle.then(async () => {
        await api.closePage()
        if (!disposed) setState((current) => ({
          ...current,
          active: false,
          nearbyDevices: [],
          trustedDevices: current.trustedDevices.map((peer) => ({
            ...peer,
            online: false,
            reachability: 'offline',
          })),
        }))
      }).catch((reason) => { if (!disposed) onError(messageOf(reason)) })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') open()
      else close()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    open()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', handleVisibility)
      clearTimer()
      lifecycle = lifecycle.then(() => api.closePage()).catch(() => undefined)
    }
  }, [api, onError])

  useEffect(() => {
    if (!pageOpened.current) return
    const identity = syncCompletionIdentity(state.lastCompleted)
    if (!identity || identity === observedCompletion.current) return
    observedCompletion.current = identity
    if (state.lastCompleted?.direction !== 'receiving' || !onDataChanged) return
    void Promise.resolve(onDataChanged()).catch((reason) => onError(messageOf(reason)))
  }, [onDataChanged, onError, state.lastCompleted])

  const run = async (id: string, action: () => Promise<SyncPageState>) => {
    setBusy(id)
    try { setState(await action()) }
    catch (reason) { onError(messageOf(reason)) }
    finally { setBusy(null) }
  }
  const trustedById = useMemo(() => new Map(state.trustedDevices.map((peer) => [peer.deviceId, peer])), [state.trustedDevices])
  const resumableTransfers = state.resumableTransfers ?? []
  const operationActive = Boolean(state.operation
    && !['completed', 'cancelled', 'error', 'resumable'].includes(state.operation.stage))
  const discoveryNotice = getSyncDiscoveryNotice(state)

  return <div className={`sync-settings-panel${compact ? ' compact-sync-panel' : ''}`}>
    <section className="sync-local-card">
      <div><span className={`sync-presence ${state.active ? 'online' : ''}`} /><div><b>{state.localDevice?.name ?? '正在启动局域网同步…'}</b><small>{state.localDevice ? `本机标识 ${shortFingerprint(state.localDevice.certificateSha256)}` : '正在生成或读取本机设备身份'}</small></div></div>
      <em>{state.active ? '仅本页前台可见' : '未广播'}</em>
    </section>

    {discoveryNotice && <div className={`sync-diagnostic ${discoveryNotice.severity}`} role={discoveryNotice.severity === 'unavailable' ? 'alert' : 'status'}><b>{discoveryNotice.title}</b><p>{discoveryNotice.message}</p></div>}

    {state.pairing && <section className={`sync-pairing-card ${state.pairing.status}`}>
      <p>{state.pairing.direction === 'incoming' ? `${state.pairing.peer.name} 请求配对` : `正在与 ${state.pairing.peer.name} 配对`}</p>
      <strong aria-label={`配对验证码 ${state.pairing.code}`}>{state.pairing.code.slice(0, 3)} {state.pairing.code.slice(3)}</strong>
      <small>{state.pairing.message ?? '确认两台设备显示相同数字。'}</small>
      {state.pairing.status === 'waiting' && <div className="sync-actions">
        <button className="primary-button" disabled={busy !== null || state.pairing.localConfirmed} onClick={() => void run('pair-confirm', () => api.confirmPairing(state.pairing!.sessionId))}>{state.pairing.localConfirmed ? '已确认，等待对方' : '数字一致，确认配对'}</button>
        <button className="secondary-button" disabled={busy !== null} onClick={() => void run('pair-reject', () => api.rejectPairing(state.pairing!.sessionId))}>取消</button>
      </div>}
    </section>}

    {state.incoming && <section className="sync-incoming-card">
      <header><div><p>收到定向同步请求</p><h3>{state.incoming.sender.name} → 本机</h3></div><span>{formatBytes(state.incoming.totalBytes)}</span></header>
      <dl>
        <div><dt>新增刊物</dt><dd>{state.incoming.newPublications}</dd></div>
        <div><dt>更新记录</dt><dd>{state.incoming.updatedRecords}</dd></div>
        <div><dt>删除刊物</dt><dd>{state.incoming.deletedPublications}</dd></div>
        <div><dt>缺失内容包</dt><dd>{state.incoming.missingBlobs}</dd></div>
      </dl>
      <p>接收后，发送端本批次中同 ID 的当前状态会覆盖本机；本机独有记录仍保留，只有显式删除墓碑才会删除刊物。</p>
      <SyncChangeDetails key={state.incoming.transferId} api={api} transferId={state.incoming.transferId} />
      <div className="sync-actions"><button className="primary-button" disabled={busy !== null} onClick={() => void run('incoming-accept', () => api.acceptIncoming(state.incoming!.transferId))}>接受并应用</button><button className="secondary-button" disabled={busy !== null} onClick={() => void run('incoming-reject', () => api.rejectIncoming(state.incoming!.transferId))}>拒绝</button></div>
    </section>}

    {state.operation && <section className={`sync-operation-card ${state.operation.stage}`}>
      <header><div><b>{state.operation.direction === 'sending' ? `发送到 ${state.operation.peer.name}` : `接收自 ${state.operation.peer.name}`}</b><small>{state.operation.message}</small></div><span>{operationLabel(state.operation.stage)}</span></header>
      {state.operation.totalBytes > 0 && <progress max={state.operation.totalBytes} value={Math.min(state.operation.completedBytes, state.operation.totalBytes)} />}
      {!['applying', 'completed', 'cancelled', 'error', 'resumable'].includes(state.operation.stage) && <button className="secondary-button" onClick={() => void run('cancel', () => api.cancelOperation())}>取消同步</button>}
    </section>}

    {resumableTransfers.length > 0 && <section className="sync-device-section">
      <div className="sync-section-heading"><div><h3>可继续的传输</h3><p>30 分钟内会保留已完整接收的批次与刊物包。</p></div></div>
      <div className="sync-device-list">{resumableTransfers.map((transfer) => <div className="sync-device-row" key={`${transfer.direction}-${transfer.transferId}`}><div><b>{transfer.peer.name}</b><small>{transfer.direction === 'sending' ? '待继续发送' : '待继续接收'} · {formatBytes(transfer.completedBytes)} / {formatBytes(transfer.totalBytes)}</small></div><div className="sync-actions">{transfer.direction === 'sending' && <button className="primary-button" disabled={busy !== null || operationActive} onClick={() => void run(`resume-${transfer.transferId}`, () => api.sendTo(transfer.peer.deviceId))}>继续</button>}<button className="text-button" disabled={busy !== null || operationActive} onClick={() => void run(`discard-${transfer.transferId}`, () => api.discardPendingTransfer(transfer.transferId))}>丢弃</button></div></div>)}</div>
    </section>}

    {state.lastCompleted && <p className="sync-last-result">上次完成：{state.lastCompleted.peerName} · 应用 {state.lastCompleted.appliedRecords} 条记录 · 导入 {state.lastCompleted.importedPublications} 本刊物</p>}

    <section className="sync-device-section">
      <div className="sync-section-heading"><div><h3>附近设备</h3><p>另一台设备也需要打开“跨设备同步”页面并保持前台。</p></div><button className="secondary-button" disabled={busy !== null} onClick={() => void refresh().catch((reason) => onError(messageOf(reason)))}>刷新</button></div>
      {busy === 'open' && <p className="sync-empty">正在启动 HTTPS 与局域网发现…</p>}
      {busy !== 'open' && state.nearbyDevices.length === 0 && <p className="sync-empty">尚未发现设备。请确认两端处于同一局域网，且访客 Wi-Fi/AP 隔离与防火墙没有阻断本地通信。</p>}
      <div className="sync-device-list">{state.nearbyDevices.map((peer) => <DeviceRow key={peer.deviceId} peer={peer} trusted={trustedById.has(peer.deviceId)} disabled={busy !== null || operationActive || state.pairing?.status === 'waiting'} onPair={() => void run(`pair-${peer.deviceId}`, () => api.startPairing(peer.deviceId))} onSend={() => void run(`send-${peer.deviceId}`, () => api.sendTo(peer.deviceId))} />)}</div>
    </section>

    {state.trustedDevices.length > 0 && <section className="sync-device-section trusted">
      <div className="sync-section-heading"><div><h3>受信任设备</h3><p>证书变化或撤销信任后，必须重新核对六位码。</p></div></div>
      <div className="sync-device-list">{state.trustedDevices.map((peer) => <div className="sync-device-row" key={peer.deviceId}><DeviceIdentity peer={peer} /><div className="sync-actions">{peer.online && <button className="primary-button" disabled={busy !== null || operationActive} onClick={() => void run(`send-${peer.deviceId}`, () => api.sendTo(peer.deviceId))}>同步到此设备</button>}<button className="text-button" disabled={busy !== null || operationActive} onClick={() => void run(`revoke-${peer.deviceId}`, () => api.revokeTrust(peer.deviceId))}>撤销信任</button></div></div>)}</div>
    </section>}
  </div>
}

export function syncCompletionIdentity(result: SyncCompletedResult | null): string | null {
  if (!result) return null
  return [
    result.direction,
    result.peerName,
    result.completedAt,
    result.appliedRecords,
    result.unchangedRecords,
    result.importedPublications,
  ].join('\u001f')
}

function DeviceRow({ peer, trusted, disabled, onPair, onSend }: {
  peer: SyncDeviceSummary
  trusted: boolean
  disabled: boolean
  onPair(): void
  onSend(): void
}) {
  return <div className="sync-device-row"><DeviceIdentity peer={peer} /><button className={trusted ? 'primary-button' : 'secondary-button'} disabled={disabled || !peer.online} onClick={trusted ? onSend : onPair}>{trusted ? '同步到此设备' : '配对'}</button></div>
}

function DeviceIdentity({ peer }: { peer: SyncDeviceSummary }) {
  const label = ({ verifying: '验证中', online: '在线', unreachable: '不可达', offline: '离线', 'identity-changed': '身份已变化' })[peer.reachability]
  return <div className="sync-device-identity"><span className={`sync-device-icon ${peer.platform}`}>{peer.platform === 'android' ? 'A' : 'W'}</span><div><b>{peer.name}</b><small><span className={`sync-presence ${peer.online ? 'online' : ''}`} />{label} · {shortFingerprint(peer.certificateSha256)}</small>{peer.diagnostic && <small>{peer.diagnostic.message}</small>}</div></div>
}

function shortFingerprint(value: string): string {
  return value ? value.slice(0, 12).match(/.{1,4}/g)?.join(' ') ?? value.slice(0, 12) : '—'
}

function operationLabel(stage: NonNullable<SyncPageState['operation']>['stage']): string {
  return ({ 'verifying-device': '验证设备', summarizing: '比较', preparing: '准备', 'uploading-batch': '发送批次', 'waiting-confirmation': '等待确认', uploading: '传输内容', resumable: '可继续', applying: '应用', completed: '完成', cancelled: '已取消', error: '失败' })[stage]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
