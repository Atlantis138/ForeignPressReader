import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LibraryApi, LibraryState, PublicationSummary, ImportProgress } from '../../shared/types'
import type { OnlineCatalog, OnlineIssue } from '../../shared/online-catalog'
import { localEconomistIssue } from '../../core/online-catalog'
import { useDialogFocus } from '../ui/use-dialog-focus'
import { CloseIcon, DownloadIcon } from '../ui/icons'
import './online-issues.css'

const messageOf = (reason: unknown) => reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : '操作失败，请重试'
const sizeOf = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function OnlineIssuesDialog({ library, publications, onState, onOpen, onClose }: {
  library: LibraryApi
  publications: PublicationSummary[]
  onState(state: LibraryState): void
  onOpen(publicationId: string): void
  onClose(): void
}) {
  const [catalog, setCatalog] = useState<OnlineCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [recentCount, setRecentCount] = useState(8)
  const [history, setHistory] = useState(false)
  const [year, setYear] = useState('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(24)
  const [active, setActive] = useState<{id: string; index: number; total: number} | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  const [imported, setImported] = useState<PublicationSummary[]>([])
  const [stopping, setStopping] = useState(false)
  const mounted = useRef(true)
  const running = useRef(false)
  const cancelled = useRef(false)
  const sequence = useRef(0)
  const dialog = useDialogFocus<HTMLDivElement>(() => { if (!running.current) onClose() })

  const load = useCallback(async (refresh = false) => {
    const id = ++sequence.current
    setLoading(true); setLoadError('')
    try {
      const result = await library.getOnlineCatalog(refresh)
      if (mounted.current && id === sequence.current) setCatalog(result)
    } catch (reason) { if (mounted.current && id === sequence.current) setLoadError(messageOf(reason)) }
    finally { if (mounted.current && id === sequence.current) setLoading(false) }
  }, [library])

  useEffect(() => {
    mounted.current = true
    void load()
    const unsubscribe = library.onImportProgress(value => {
      if (!running.current) return
      if (value.stage === 'cancelled') cancelled.current = true
      setProgress(value)
    })
    return () => {
      mounted.current = false
      unsubscribe()
      if (running.current) { cancelled.current = true; void library.cancelImport().catch(() => undefined) }
    }
  }, [library, load])

  const local = (issue: OnlineIssue) => localEconomistIssue([...publications, ...imported], issue.date)
  const recent = catalog?.issues.slice(0, recentCount) ?? []
  const missing = recent.filter(issue => !local(issue))
  const historyIssues = catalog?.issues.filter(issue => (year === 'all' || issue.date.startsWith(year)) && issue.date.includes(query.trim().replaceAll('.', '-'))) ?? []
  const displayed = history ? historyIssues.slice(0, limit) : recent
  const years = [...new Set(catalog?.issues.map(issue => issue.date.slice(0, 4)) ?? [])]

  const cancel = async () => {
    cancelled.current = true; setStopping(true)
    try { await library.cancelImport() }
    catch (reason) { if (mounted.current) setNotice(messageOf(reason)) }
  }

  const download = async (queue: OnlineIssue[], openAfter: boolean) => {
    if (running.current || queue.length === 0) return
    running.current = true; cancelled.current = false
    setStopping(false); setNotice('')
    let completed = 0, failed = 0
    try {
      for (let index = 0; index < queue.length; index++) {
        if (cancelled.current || !mounted.current) break
        const issue = queue[index]
        setActive({ id: issue.id, index: index + 1, total: queue.length })
        setProgress(null)
        setErrors(current => { const next = { ...current }; delete next[issue.id]; return next })
        try {
          const result = await library.importOnlineIssue(issue.id)
          if (!result) { cancelled.current = true; break }
          completed++
          if (!mounted.current) break
          setImported(current => [...current, result.publication])
          try { const next = await library.getState(); if (mounted.current) onState(next) }
          catch { setNotice('期刊已导入，书库列表暂未刷新；重新进入书库即可查看。') }
          if (openAfter && !cancelled.current && mounted.current) { onOpen(result.publication.id); return }
        } catch (reason) {
          if (cancelled.current || !mounted.current) break
          failed++
          setErrors(current => ({ ...current, [issue.id]: messageOf(reason) }))
        }
      }
      if (mounted.current) setNotice(`${cancelled.current ? '已停止。' : ''}本次已导入 ${completed} 期${failed ? `，${failed} 期失败，可单独重试` : ''}。已导入的刊物保留在书库。`)
    } finally {
      running.current = false
      if (mounted.current) { setActive(null); setProgress(null); setStopping(false) }
    }
  }

  return createPortal(<div className="online-issues-backdrop">
    <div className="online-issues-dialog" role="dialog" aria-modal="true" aria-labelledby="online-issues-title" ref={dialog} tabIndex={-1}>
      <header className="online-issues-header">
        <div><p className="online-issues-eyebrow">THE ECONOMIST</p><h2 id="online-issues-title">在线刊物</h2><p>补齐最近缺刊，下载后离线阅读。</p></div>
        <button className="online-issues-icon" aria-label="关闭在线刊物" disabled={Boolean(active)} onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="online-issues-content">
        <div className="online-issues-toolbar"><span>来源：hehonghui/awesome-english-ebooks</span><button disabled={loading || Boolean(active)} onClick={() => void load(true)}>{loading ? '正在检查…' : '检查更新'}</button></div>
        {loadError && <p className="online-issues-error" role="alert">{loadError}<button disabled={loading} onClick={() => void load(true)}>重试</button></p>}
        {catalog?.stale && <p className="online-issues-notice" role="status">{catalog.notice}</p>}
        {loading && !catalog && <p role="status">正在获取期刊列表…</p>}
        {catalog && <>
          <section className="online-issues-recent">
            <div><h3>最近缺刊</h3><label>检查范围<select aria-label="最近期数" value={recentCount} disabled={Boolean(active)} onChange={event => setRecentCount(Number(event.target.value))}>{[4,8,12].map(count => <option key={count} value={count}>最近 {count} 期</option>)}</select></label></div>
            <p>{missing.length ? `最近 ${recent.length} 期中，${missing.length} 期尚未在本地，约 ${sizeOf(missing.reduce((sum, issue) => sum + issue.bytes, 0))}。` : `最近 ${recent.length} 期已全部在书库中。`}</p>
            <button className="online-issues-primary" disabled={!missing.length || loading || Boolean(active)} onClick={() => void download(missing, false)}><DownloadIcon />{missing.length ? `一键补齐 ${missing.length} 期` : '已全部下载'}</button>
          </section>
          {active && <div className="online-issues-progress" role="status"><b>{stopping ? '正在停止…' : `正在处理 ${active.index} / ${active.total} 期`}</b><span>{progress?.message ?? '正在准备下载'}</span><progress max={progress?.total || undefined} value={progress?.total ? progress.completed : undefined} /><button disabled={stopping} onClick={() => void cancel()}>停止下载</button></div>}
          {notice && <p className="online-issues-notice" role="status">{notice}</p>}
          <div className="online-issues-list-heading"><h3>{history ? '历史期刊' : '最近期刊'}</h3><button disabled={Boolean(active)} onClick={() => { setHistory(value => !value); setLimit(24) }}>{history ? '返回最近几期' : '查看历史期刊'}</button></div>
          {history && <div className="online-issues-filters"><label>年份<select value={year} onChange={event => { setYear(event.target.value); setLimit(24) }}><option value="all">全部年份</option>{years.map(value => <option key={value}>{value}</option>)}</select></label><label>日期<input type="search" placeholder="例如 2025-12" value={query} onChange={event => { setQuery(event.target.value); setLimit(24) }} /></label></div>}
          <ul className="online-issues-list">{displayed.map(issue => {
            const existing = local(issue)
            return <li key={issue.id} className={existing ? 'downloaded' : ''}><div><strong>{issue.date.replaceAll('-', '.')}<small>{issue.id === catalog.issues[0]?.id ? '最新一期' : ''}</small></strong><span>{existing ? '本地已有' : `尚未下载 · ${sizeOf(issue.bytes)}`}</span>{errors[issue.id] && <p role="alert" className="online-issues-error">{errors[issue.id]}</p>}</div><button disabled={Boolean(active)} onClick={() => existing ? onOpen(existing.id) : void download([issue], true)}>{existing ? '阅读' : errors[issue.id] ? '重试下载' : '下载并阅读'}</button></li>
          })}</ul>
          {displayed.length === 0 && <p>没有符合条件的期刊。</p>}
          {history && historyIssues.length > limit && <button className="online-issues-more" onClick={() => setLimit(value => value + 24)}>显示更多历史期刊</button>}
          <p className="online-issues-footnote">列表更新于 {new Date(catalog.fetchedAt).toLocaleString('zh-CN')}。仅在你点击下载时获取 EPUB，导入完成后清除临时文件。</p>
        </>}
      </div>
    </div>
  </div>, document.body)
}
