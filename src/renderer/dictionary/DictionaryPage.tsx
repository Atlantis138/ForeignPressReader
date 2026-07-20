import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DictionaryCollection,
  DictionarySearchItem,
  DictionarySearchPage,
  DictionarySearchQuery,
  DictionaryStatus,
  LexemeDetail,
  SavedContextPage,
  VocabularyListItem,
  VocabularyListPage,
} from '../../shared/types'
import { buildMobileLexemePresentation } from '../../shared/mobile-lexeme-presentation'
import { getAppClient } from '../app-client'
import { PronounceButton } from '../speech/PronounceButton'
import { CloseIcon, DictionaryIcon, SearchIcon, SlidersIcon } from '../ui/icons'
import { ChoiceChip, IconButton, ModuleTabs } from '../ui/primitives'
import { LexemeBadges, LexemeExamples, LexemeSenses } from './LexemeContent'

const appClient = getAppClient()
const EMPTY_PAGE: DictionarySearchPage = { items: [], total: 0, offset: 0, limit: 30 }
const EMPTY_FAVORITES: VocabularyListPage = { items: [], total: 0, offset: 0, limit: 30 }
const DEFAULT_QUERY: DictionarySearchQuery = {
  text: '', tags: [], tagMatch: 'any', oxfordOnly: false, collinsMin: null,
  bncMax: null, contemporaryMax: null, sort: 'relevance', offset: 0, limit: 30,
}

type PageMode = 'search' | 'favorites'
type SelectedWord = { item: DictionarySearchItem | VocabularyListItem; detail: LexemeDetail | null }

export interface DictionaryPageSnapshot {
  mode: PageMode
  query: DictionarySearchQuery
  favoriteText: string
  selectedItem: DictionarySearchItem | VocabularyListItem | null
}

export function DictionaryPage({
  snapshot,
  onSnapshot,
  onOpenArticle,
  onError,
}: {
  snapshot: DictionaryPageSnapshot
  onSnapshot(value: DictionaryPageSnapshot): void
  onOpenArticle(articleId: string, publicationId: string): void
  onError(message: string): void
}) {
  const [status, setStatus] = useState<DictionaryStatus | null>(null)
  const [collections, setCollections] = useState<DictionaryCollection[]>([])
  const [mode, setMode] = useState<PageMode>(snapshot.mode)
  const [query, setQuery] = useState(snapshot.query)
  const [page, setPage] = useState(EMPTY_PAGE)
  const [favorites, setFavorites] = useState(EMPTY_FAVORITES)
  const [favoriteText, setFavoriteText] = useState(snapshot.favoriteText)
  const [selected, setSelected] = useState<SelectedWord | null>(() => snapshot.selectedItem ? { item: snapshot.selectedItem, detail: null } : null)
  const [contexts, setContexts] = useState<SavedContextPage | null>(null)
  const [busy, setBusy] = useState(false)
  const initialSelectedItemRef = useRef(snapshot.selectedItem)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const next = await appClient.dictionary.getStatus()
      const nextCollections = next.installed ? await appClient.dictionary.listCollections() : []
      setStatus(next)
      setCollections(nextCollections)
    } finally { setBusy(false) }
  }, [])

  const loadFavorites = useCallback(async (offset: number) => {
    setBusy(true)
    try {
      setFavorites(await appClient.vocabulary.listFavorites({ text: favoriteText, offset, limit: 30 }))
    } finally { setBusy(false) }
  }, [favoriteText])

  useEffect(() => { refresh().catch((error) => onError(messageOf(error))) }, [onError, refresh])

  useEffect(() => {
    const item = initialSelectedItemRef.current
    if (!item) return
    let active = true
    Promise.all([
      status?.installed ? appClient.dictionary.getLexeme(item.lexemeKey).catch(() => null) : Promise.resolve(null),
      appClient.vocabulary.listContexts(item.lexemeKey),
    ]).then(([detail, saved]) => {
      if (!active) return
      setSelected({ item, detail })
      setContexts(saved)
    }).catch((error) => { if (active) onError(messageOf(error)) })
    return () => { active = false }
  }, [onError, status?.installed])

  const active = Boolean(query.text.trim() || query.tags.length || query.oxfordOnly
    || query.collinsMin || query.bncMax || query.contemporaryMax)
  const activeFilterCount = query.tags.length + Number(query.oxfordOnly) + Number(query.collinsMin !== null)
    + Number(query.bncMax !== null) + Number(query.contemporaryMax !== null) + Number(query.sort !== 'relevance')
  const clearFilters = () => setQuery({ ...DEFAULT_QUERY, text: query.text })
  useEffect(() => {
    onSnapshot({ mode, query, favoriteText, selectedItem: selected?.item ?? null })
  }, [favoriteText, mode, onSnapshot, query, selected?.item])
  useEffect(() => {
    if (mode !== 'search' || !status?.installed || !active) { setPage(EMPTY_PAGE); return }
    const timer = window.setTimeout(() => {
      setBusy(true)
      appClient.dictionary.search(query).then(setPage).catch((error) => onError(messageOf(error))).finally(() => setBusy(false))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [active, mode, onError, query, status?.installed])

  useEffect(() => {
    if (mode !== 'favorites') return
    const timer = window.setTimeout(() => {
      loadFavorites(0).catch((error) => onError(messageOf(error)))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [loadFavorites, mode, onError])

  const openLexeme = async (item: DictionarySearchItem | VocabularyListItem) => {
    try {
      const [detail, saved] = await Promise.all([
        status?.installed ? appClient.dictionary.getLexeme(item.lexemeKey).catch(() => null) : Promise.resolve(null),
        appClient.vocabulary.listContexts(item.lexemeKey),
      ])
      setSelected({ item, detail })
      setContexts(saved)
    } catch (error) { onError(messageOf(error)) }
  }

  const install = async (local: boolean) => {
    setBusy(true)
    try {
      if (local) await appClient.dictionary.installFromLocal()
      else await appClient.dictionary.install()
      await refresh()
    } catch (error) { onError(messageOf(error)) } finally { setBusy(false) }
  }

  const removeFavorite = async (lexemeKey: string) => {
    try {
      await appClient.vocabulary.removeFavorite(lexemeKey)
      setSelected(null)
      setContexts(null)
      await loadFavorites(favorites.offset)
    } catch (error) { onError(messageOf(error)) }
  }

  const displayedItems = mode === 'favorites' ? favorites.items : page.items
  const displayedTotal = mode === 'favorites' ? favorites.total : page.total
  const offset = mode === 'favorites' ? favorites.offset : query.offset
  const limit = mode === 'favorites' ? favorites.limit : query.limit
  const changePage = (next: number) => {
    if (mode === 'favorites') loadFavorites(next).catch((error) => onError(messageOf(error)))
    else setQuery({ ...query, offset: next })
  }

  return <section className={`page dictionary-page ${selected ? 'detail-visible' : ''}`}>
    <header className="page-header"><div><p className="eyebrow">LEXICON</p><h1>词典</h1><p>ECDICT 词条、考试标签、词频与收藏语境。</p></div></header>
    <ModuleTabs value={mode} label="词典模式" items={[{ value: 'search', label: '词典检索' }, { value: 'favorites', label: '我的生词', count: favorites.total }]} onChange={(value) => { setMode(value); setSelected(null) }} />
    {mode === 'search' ? <>
      {!status?.installed ? <div className="empty-state"><div className="empty-book">Aa</div><h2>安装本地 ECDICT</h2><p>词典安装后可离线完成英中双向搜索和词形还原；已有生词仍可在“我的生词”查看。</p><div className="button-row"><button className="primary-button" disabled={busy} onClick={() => install(false)}>下载并安装</button><button className="secondary-button" disabled={busy} onClick={() => install(true)}>从本地 CSV 安装</button></div></div> : <>
        <div className="dictionary-searchbar"><SearchIcon/><input autoFocus value={query.text} placeholder="输入英文单词或中文释义" aria-label="搜索词典" onChange={(event) => setQuery({ ...query, text: event.target.value, offset: 0 })} />{query.text && <IconButton label="清除搜索" onClick={() => setQuery({ ...query, text: '', offset: 0 })}><CloseIcon/></IconButton>}{busy && <span>查询中…</span>}</div>
        <div className="dictionary-collections">{collections.map((collection) => <button key={collection.id} className={query.tags.includes(collection.tag) ? 'active' : ''} onClick={() => setQuery({ ...query, tags: query.tags.includes(collection.tag) ? query.tags.filter((tag) => tag !== collection.tag) : [...query.tags, collection.tag], offset: 0 })}><b>{collection.name}</b><small>{collection.count.toLocaleString('zh-CN')} 词</small></button>)}</div>
        <details className="dictionary-filters"><summary><span><SlidersIcon/>高级筛选{activeFilterCount > 0 && <small>{activeFilterCount}</small>}</span>{activeFilterCount > 0 && <button type="button" onClick={(event) => { event.preventDefault(); clearFilters() }}>清除条件</button>}</summary><div>
          <ChoiceChip selected={query.oxfordOnly} onClick={() => setQuery({ ...query, oxfordOnly: !query.oxfordOnly, offset: 0 })}>Oxford 核心词</ChoiceChip>
          <label>Collins ≥ <select value={query.collinsMin ?? ''} onChange={(event) => setQuery({ ...query, collinsMin: event.target.value ? Number(event.target.value) : null, offset: 0 })}><option value="">不限</option>{[1,2,3,4,5].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>BNC 前 <input type="number" value={query.bncMax ?? ''} placeholder="不限" onChange={(event) => setQuery({ ...query, bncMax: event.target.value ? Number(event.target.value) : null, offset: 0 })} /></label>
          <label>当代词频前 <input type="number" value={query.contemporaryMax ?? ''} placeholder="不限" onChange={(event) => setQuery({ ...query, contemporaryMax: event.target.value ? Number(event.target.value) : null, offset: 0 })} /></label>
          <label>排序 <select value={query.sort} onChange={(event) => setQuery({ ...query, sort: event.target.value as DictionarySearchQuery['sort'], offset: 0 })}><option value="relevance">相关度</option><option value="frequency">词频</option><option value="alphabetical">字母序</option></select></label>
        </div></details>
      </>}
    </> : <div className="dictionary-searchbar"><SearchIcon/><input autoFocus value={favoriteText} placeholder="搜索我的生词" aria-label="搜索我的生词" onChange={(event) => setFavoriteText(event.target.value)} />{favoriteText && <IconButton label="清除搜索" onClick={() => setFavoriteText('')}><CloseIcon/></IconButton>}{busy && <span>查询中…</span>}</div>}
    {(mode === 'favorites' || (status?.installed && active)) ? <div className="dictionary-workspace">
      <div className="dictionary-results"><p>共 {displayedTotal.toLocaleString('zh-CN')} 个结果</p>{displayedItems.map((item) => <button key={item.lexemeKey} className={selected?.item.lexemeKey === item.lexemeKey ? 'active' : ''} onClick={() => openLexeme(item)}><span><b>{item.lemma}</b>{item.phonetic && <small>/{item.phonetic}/</small>}</span><p>{item.briefMeanings.join('；') || '暂无简明释义'}</p>{'tags' in item && <small>{item.tags.join(' · ')}</small>}</button>)}<div className="pager"><button disabled={offset === 0} onClick={() => changePage(Math.max(0, offset - limit))}>上一页</button><button disabled={offset + limit >= displayedTotal} onClick={() => changePage(offset + limit)}>下一页</button></div></div>
      <div className="dictionary-detail">{selected ? <LexemePanel selected={selected} contexts={contexts} favoriteMode={mode === 'favorites'} onBack={() => setSelected(null)} onRemoveFavorite={removeFavorite} onOpenArticle={onOpenArticle} /> : <div className="dictionary-detail-empty"><DictionaryIcon/><h3>选择一个词条</h3><p>释义、词形与收藏语境会显示在这里。</p></div>}</div>
    </div> : status?.installed && <div className="dictionary-welcome"><h2>从搜索或词集开始</h2><p>中文反查支持两个及以上汉字；筛选结果可作为未来长期学习计划的词源。</p></div>}
  </section>
}

function LexemePanel({ selected, contexts, favoriteMode, onBack, onRemoveFavorite, onOpenArticle }: {
  selected: SelectedWord
  contexts: SavedContextPage | null
  favoriteMode: boolean
  onBack(): void
  onRemoveFavorite(lexemeKey: string): void
  onOpenArticle(articleId: string, publicationId: string): void
}) {
  const { item, detail } = selected
  const presentation = useMemo(() => detail ? buildMobileLexemePresentation({
    source: 'resource', detail, snapshot: null, localProfile: 'standard', favorite: favoriteMode, manualState: 'unrated',
  }) : null, [detail, favoriteMode])
  return <><button className="dictionary-detail-back" onClick={onBack}>← 返回结果</button><header><div><div className="lexeme-spoken-heading"><h2>{item.lemma}</h2><PronounceButton sourceId="dictionary-detail" itemId={item.lexemeKey} text={item.lemma}/></div>{item.phonetic && <p>/{item.phonetic}/</p>}</div>{favoriteMode && <button className="secondary-button" onClick={() => onRemoveFavorite(item.lexemeKey)}>取消收藏</button>}</header>
    {detail && presentation && <><LexemeBadges tags={detail.tags} collections={detail.collections} oxford={detail.oxford} collins={detail.collins} frequency={detail.frequency}/>
      <LexemeSenses senses={presentation.senses.map(({ partOfSpeech, translations, definitions }) => ({ partOfSpeech, translations, definitions }))}/>
      {presentation.forms.length > 0 && <div className="lexeme-forms"><h3>词形</h3><p>{presentation.forms.join(' · ')}</p></div>}
      <LexemeExamples examples={presentation.examples}/></>}
    {!detail && <div className="lexeme-sense"><p>{item.briefMeanings.join('；') || '暂无简明释义快照'}</p><small>本地词典未安装，当前展示收藏时保存的词条快照。</small></div>}
    <div className="lexeme-contexts"><h3>收藏语境</h3>{!contexts?.items.length ? <p>尚未收藏外刊语境。</p> : contexts.items.map((context) => <button key={context.contextId} disabled={!context.articleId || !context.publicationId} onClick={() => context.articleId && context.publicationId && onOpenArticle(context.articleId, context.publicationId)}><b>{context.articleTitle}</b><p>{context.sentence}</p><small>{context.publicationTitle} · {new Date(context.savedAt).toLocaleDateString('zh-CN')}</small></button>)}</div>
  </>
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  return String(reason)
}
