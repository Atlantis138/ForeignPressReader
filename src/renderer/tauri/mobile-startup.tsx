import { useEffect, useState, type ReactNode } from 'react'
import { TauriMobileAppClient } from './mobile-app-client'

const client = new TauriMobileAppClient()
export function MobileStartup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'recovery' | 'error'
  >('loading')
  const [recovery, setRecovery] = useState<{
    message: string
    snapshots: string[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    let current = true
    void client.platform.startup.getState().then(
      (value) => {
        if (current) {
          setRecovery(value)
          setSelected(value?.snapshots[0] ?? '')
          setStatus(value ? 'recovery' : 'ready')
        }
      },
      () => {
        if (current) {
          setError('无法连接本地数据服务')
          setStatus('error')
        }
      },
    )
    return () => {
      current = false
    }
  }, [])
  if (status === 'ready') return children
  return (
    <main
      className="mobile-page"
      style={{ padding: 24, maxWidth: 640, margin: '40px auto' }}
    >
      <h1>{status === 'loading' ? '正在打开阅读数据' : '恢复阅读数据'}</h1>
      {recovery && (
        <>
          <p>{recovery.message}</p>
          <p>可从本机快照恢复。原数据库及日志会另行保留，刊物文件也会保留。</p>
          {recovery.snapshots.length ? (
            <>
              <label>
                选择快照
                <select
                  style={{ display: 'block', width: '100%', margin: '12px 0' }}
                  value={selected}
                  onChange={(event) => {
                    setSelected(event.target.value)
                    setConfirmed(false)
                  }}
                >
                  {recovery.snapshots.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{' '}
                使用此快照恢复，快照之后的阅读状态可能不在其中
              </label>
              <p>
                <button
                  disabled={busy || !confirmed}
                  onClick={() => {
                    setBusy(true)
                    setError(null)
                    void client.platform.startup.restore(selected).then(
                      () => window.location.reload(),
                      (reason) => {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : '恢复失败，原数据已保留',
                        )
                        setBusy(false)
                      },
                    )
                  }}
                >
                  {busy ? '正在验证和恢复…' : '恢复所选快照'}
                </button>
              </p>
            </>
          ) : (
            <p>没有可用的本机快照。请保留应用数据，勿清除存储或卸载。</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {status !== 'loading' && (
        <button disabled={busy} onClick={() => window.location.reload()}>
          重新检查
        </button>
      )}
    </main>
  )
}
