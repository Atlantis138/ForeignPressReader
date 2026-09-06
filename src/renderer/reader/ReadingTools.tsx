import { useEffect, useRef, useState } from 'react'
import type { ArticleDetail, ReaderApi } from '../../shared/types'
import type {
  ArticleFilter,
  ArticleReadingChange,
  ArticleReadingData,
  ArticleSearchPage,
} from '../../shared/reader-types'
import './reading-tools.css'

const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : '操作失败，请重试'

export function ArticleSearch({
  reader,
  onOpen,
}: {
  reader: ReaderApi
  onOpen(publicationId: string, articleId: string): void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<ArticleFilter>('all')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ArticleSearchPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open) return
    let current = true
    setPage(null)
    setError(null)
    const timer = window.setTimeout(() => {
      void reader.searchArticles({ text, filter, offset, limit: 30 }).then(
        (result) => {
          if (current) setPage(result)
        },
        (reason) => {
          if (current) setError(messageOf(reason))
        },
      )
    }, 250)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [reader, open, text, filter, offset, retry])
  return (
    <details
      className="reading-search"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        查找文章与阅读记录 <span>正文搜索 · 书签 · 阅读状态</span>
      </summary>
      {open && (
        <div className="reading-search-body">
          <label className="reading-search-input">
            搜索所有刊物的标题和正文
            <input
              type="search"
              value={text}
              placeholder="输入关键词…"
              onChange={(event) => {
                setText(event.target.value)
                setOffset(0)
              }}
            />
          </label>
          <div className="reading-filters" aria-label="文章筛选">
            {(
              [
                ['all', '全部'],
                ['bookmarked', '书签'],
                ['unread', '未读'],
                ['read', '已读'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value)
                  setOffset(0)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {error ? (
            <p role="alert">
              {error}{' '}
              <button onClick={() => setRetry((value) => value + 1)}>
                重试
              </button>
            </p>
          ) : !page ? (
            <p role="status">正在查找…</p>
          ) : (
            <>
              <p className="reading-result-count" role="status">
                {page.total ? `${page.total} 篇文章` : '没有符合条件的文章'}
              </p>
              <div className="reading-results">
                {page.items.map((item) => (
                  <button
                    key={item.articleId}
                    className="reading-result"
                    onClick={() => onOpen(item.publicationId, item.articleId)}
                  >
                    <small>
                      {item.publicationTitle} · {item.read ? '已读' : '未读'}
                      {item.bookmarked ? ' · 已加书签' : ''}
                    </small>
                    <strong>{item.title}</strong>
                    <span>{item.excerpt}</span>
                  </button>
                ))}
              </div>
              {page.total > page.limit && (
                <nav aria-label="文章搜索分页" className="reading-pagination">
                  <button
                    disabled={!offset}
                    onClick={() => setOffset(Math.max(0, offset - 30))}
                  >
                    上一页
                  </button>
                  <span>
                    {Math.floor(offset / 30) + 1} / {Math.ceil(page.total / 30)}
                  </span>
                  <button
                    disabled={offset + 30 >= page.total}
                    onClick={() => setOffset(offset + 30)}
                  >
                    下一页
                  </button>
                </nav>
              )}
            </>
          )}
        </div>
      )}
    </details>
  )
}

export function ArticleReadingTools({
  article,
  reader,
  onArticle,
}: {
  article: ArticleDetail
  reader: ReaderApi
  onArticle(article: ArticleDetail): void
}) {
  const [data, setData] = useState<ArticleReadingData | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const writing = useRef(false)
  useEffect(() => {
    const run = ++generation.current
    setData(null)
    setError(null)
    setNotice(null)
    void reader.getReadingData(article.id).then(
      (value) => {
        if (generation.current === run) setData(value)
      },
      (reason) => {
        if (generation.current === run) setError(messageOf(reason))
      },
    )
    return () => {
      generation.current = run + 1
    }
  }, [reader, article.id, article.blocks, retry])
  const change = async (update: ArticleReadingChange) => {
    if (writing.current) return
    const run = generation.current
    writing.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await reader.changeReadingData(article.id, update)
      if (generation.current !== run) return
      setData(result)
      if (update.kind === 'translation-selection') {
        const loaded = await reader.getArticle(article.id)
        if (generation.current === run) onArticle(loaded)
      }
      if (update.kind === 'preserve-translation')
        setNotice(
          result.versions.length
            ? '译文已保留，将随便携备份和同步带走。'
            : '当前文章还没有可保留的译文。',
        )
    } catch (reason) {
      if (generation.current === run) setError(messageOf(reason))
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  return (
    <div className="article-reading-tools" aria-label="文章阅读记录">
      {
        <div className="article-reading-actions">
          <button
            disabled={busy || !data}
            aria-pressed={data?.bookmarked}
            onClick={() =>
              void change({ kind: 'bookmark', value: !data?.bookmarked })
            }
          >
            {data?.bookmarked ? '★ 已加书签' : '☆ 加书签'}
          </button>
          <button
            disabled={busy || !data}
            aria-pressed={data?.read}
            onClick={() => void change({ kind: 'read', value: !data?.read })}
          >
            {data?.read ? '✓ 已读' : '标为已读'}
          </button>
          <details>
            <summary>
              译文版本
              {(data?.versions ?? []).length
                ? ` · ${(data?.versions ?? []).length}`
                : ''}
            </summary>
            <div className="translation-versions">
              <label>
                查看版本
                <select
                  disabled={busy || !data}
                  value={data?.selectedVersionId ?? ''}
                  onChange={(event) =>
                    void change({
                      kind: 'translation-selection',
                      value: event.target.value || null,
                    })
                  }
                >
                  <option value="">当前缓存译文</option>
                  {(data?.versions ?? []).map((version) => (
                    <option key={version.id} value={version.id}>
                      {new Date(version.createdAt).toLocaleString()} ·{' '}
                      {version.models.join(' / ')} · {version.segmentCount} 段
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy || !data}
                onClick={() => void change({ kind: 'preserve-translation' })}
              >
                保留当前缓存译文
              </button>
              <p>
                重新翻译会自动保留前后版本。选择保留版本后，只展示与原文内容匹配的段落；清理翻译缓存不会删除保留版本。
              </p>
            </div>
          </details>
        </div>
      }
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => setRetry((value) => value + 1)}>重试</button>
        </p>
      )}
    </div>
  )
}
