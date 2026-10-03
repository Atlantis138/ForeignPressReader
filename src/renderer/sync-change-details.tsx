import { useEffect, useState } from 'react'
import type { SyncApi, SyncChangePage } from '../shared/types'
const LABELS: Record<string, string> = {
  'reader-record': '阅读记录',
  'publication-lifecycle': '刊物',
  setting: '偏好设置',
  'reading-position': '书库阅读位置',
  'user-lexeme': '生词',
  'lexeme-example': '例句',
  'vocabulary-source': '词汇来源',
  'saved-context': '保存的语境',
  'study-plan': '学习计划',
  'study-plan-source': '计划来源',
  'study-plan-origin': '计划词汇',
  'study-plan-exclusion': '计划排除项',
  'scheduler-profile': '复习策略',
  'review-card': '复习卡片',
  'review-event': '复习记录',
  'reinforcement-event': '巩固记录',
  'review-suspension': '暂停记录',
  'study-progress-state': '学习进度',
  'study-lexeme-reset': '学习重置',
}
const ACTIONS = {
  new: '新增',
  update: '覆盖本机',
  delete: '删除刊物',
  unchanged: '相同，保留',
}
export function SyncChangeDetails({
  api,
  transferId,
}: {
  api: SyncApi
  transferId: string
}) {
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState<SyncChangePage | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPage(null)
    setError('')
    api
      .getIncomingChanges(transferId, offset, 25)
      .then((value) => {
        if (!cancelled) setPage(value)
      })
      .catch(() => {
        if (!cancelled) setError('无法加载变更明细，请重试。')
      })
    return () => {
      cancelled = true
    }
  }, [api, transferId, open, offset, retry])
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>逐项查看将要接收的变更</summary>
      {open && (
        <div aria-live="polite">
          {error ? (
            <p role="alert">
              {error}{' '}
              <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>
                重试
              </button>
            </p>
          ) : !page ? (
            <p>正在读取变更…</p>
          ) : (
            <>
              <p>
                共 {page.total} 条记录，显示 {page.total ? offset + 1 : 0}–
                {Math.min(offset + page.items.length, page.total)}
                。长内容仅显示摘要。
              </p>
              <ol start={offset + 1}>
                {page.items.map((item) => (
                  <li
                    key={item.type + ':' + item.key}
                    style={{ marginBottom: 16, overflowWrap: 'anywhere' }}
                  >
                    <b>
                      {item.label ? item.label + ' · ' : ''}{LABELS[item.type] ?? '同步记录'} · {ACTIONS[item.action]}
                    </b>
                    <p>本机：{item.before ?? '尚无此记录'}</p>
                    <p>接收后：{item.after}</p>
                  </li>
                ))}
              </ol>
              <div className="sync-actions">
                <button
                  className="secondary-button"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                >
                  上一页
                </button>
                <button
                  className="secondary-button"
                  disabled={offset + page.items.length >= page.total}
                  onClick={() => setOffset(offset + 25)}
                >
                  下一页
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </details>
  )
}
