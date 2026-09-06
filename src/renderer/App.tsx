import { ArticleSearch } from './reader/ReadingTools'
import { usePreferenceWriter } from './use-preference-writer'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  DictionaryInstallProgress,
  DictionaryCredentialStatus,
  DictionaryPreferences,
  DictionaryLocalProfile,
  DictionaryStatus,
  DataTransferProgress,
  PortableImportPreview,
  TranslationPreferences,
  TranslationSettings,
  PublicationDetail,
  PublicationSummary,
  ReaderPreferences,
  ImportProgress,
  LibraryPreferences,
  LibraryState,
  StudyPreferences,
  SpeechPreferences,
  SpeechSettings,
  RemoteSpeechProviderId,
  StorageReport,
  DeveloperState,
} from '../shared/types'
import { getAppClient } from './app-client'
import { SyncSettingsPanel } from './sync-settings'
import { ReaderView as ReaderExperience } from './reader/ReaderView'
import { DictionaryPage, type DictionaryPageSnapshot } from './dictionary/DictionaryPage'
import { StudyPage, type StudyPageSnapshot } from './study/StudyPage'
import { SpeechProvider, useSpeech } from './speech/SpeechProvider'
import { SpeakerIcon } from './speech/PronounceButton'
import { AppearanceIcon, ArrowLeftIcon, CheckIcon, DatabaseIcon, DictionaryIcon, LibraryIcon, PlusIcon, SettingsIcon, StudyIcon, TranslateIcon } from './ui/icons'
import { AppLogo } from './ui/app-logo'
import { ToggleSwitch } from './ui/primitives'

const appClient = getAppClient()

type LibraryRoute =
  | { name: 'library' }
  | { name: 'publication'; id: string }
  | { name: 'article'; id: string; publicationId: string }

type PrimaryArea = 'library' | 'dictionary' | 'study' | 'settings'

type SettingsSection = 'appearance' | 'translation' | 'dictionary' | 'speech' | 'study' | 'data' | 'sync' | 'developer'

interface LibraryPageSnapshot {
  selectionMode: boolean
  selectedIds: string[]
  newCategoryName: string
}

interface SettingsSnapshot {
  section: SettingsSection
  translationDraft: TranslationPreferences | null
  speechDraft: SpeechPreferences | null
  studyPreferences: StudyPreferences | null
  developerVisible: boolean
}

const DEFAULT_PREFERENCES: ReaderPreferences = {
  theme: 'light',
  fontSize: 20,
  lineHeight: 1.8,
  columnWidth: 760,
  paperTint: 58,
}

const DEFAULT_LIBRARY_STATE: LibraryState = {
  publications: [],
  categories: [],
  preferences: { viewMode: 'grid', sortBy: 'importedAt', sortDirection: 'desc', activeCategoryId: 'all' },
}

const DEFAULT_LIBRARY_SNAPSHOT: LibraryPageSnapshot = {
  selectionMode: false,
  selectedIds: [],
  newCategoryName: '',
}

const DEFAULT_DICTIONARY_SNAPSHOT: DictionaryPageSnapshot = {
  mode: 'search',
  query: {
    text: '', tags: [], tagMatch: 'any', oxfordOnly: false, collinsMin: null,
    bncMax: null, contemporaryMax: null, sort: 'relevance', offset: 0, limit: 30,
  },
  favoriteText: '',
  selectedItem: null,
}

const DEFAULT_STUDY_SNAPSHOT: StudyPageSnapshot = {
  detailPlanId: null,
  editing: null,
  editingId: null,
  sessionOpen: false,
  planWordPlanId: null,
  planWordDraft: '',
  planWordQuery: { text: '', filter: 'all', offset: 0, limit: 50 },
}

const DEFAULT_SETTINGS_SNAPSHOT: SettingsSnapshot = {
  section: 'appearance',
  translationDraft: null,
  speechDraft: null,
  studyPreferences: null,
  developerVisible: false,
}

function applyLightPaperTone(value: number | null): void {
  const root = document.documentElement
  if (value == null) {
    for (const key of ['--paper', '--canvas', '--translation', '--line']) root.style.removeProperty(key)
    return
  }
  const amount = Math.min(1, Math.max(0, value / 100))
  root.style.setProperty('--paper', mixHex('#fffefa', '#f5eadb', amount))
  root.style.setProperty('--canvas', mixHex('#f8f5ee', '#eee4d6', amount))
  root.style.setProperty('--translation', mixHex('#f3f0e9', '#e8dece', amount))
  root.style.setProperty('--line', mixHex('#e2ddd3', '#d5c9ba', amount))
}

function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from), b = parseHex(to)
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * amount)} ${Math.round(a[1] + (b[1] - a[1]) * amount)} ${Math.round(a[2] + (b[2] - a[2]) * amount)})`
}

function parseHex(value: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)) as [number, number, number]
}

export function App() {
  const [activeArea, setActiveArea] = useState<PrimaryArea>('library')
  const [libraryRoute, setLibraryRoute] = useState<LibraryRoute>({ name: 'library' })
  const [libraryState, setLibraryState] = useState<LibraryState>(DEFAULT_LIBRARY_STATE)
  const [librarySnapshot, setLibrarySnapshot] = useState<LibraryPageSnapshot>(DEFAULT_LIBRARY_SNAPSHOT)
  const [dictionarySnapshot, setDictionarySnapshot] = useState<DictionaryPageSnapshot>(DEFAULT_DICTIONARY_SNAPSHOT)
  const [studySnapshot, setStudySnapshot] = useState<StudyPageSnapshot>(DEFAULT_STUDY_SNAPSHOT)
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot>(DEFAULT_SETTINGS_SNAPSHOT)
  const [pendingLibraryScrollRestore, setPendingLibraryScrollRestore] = useState<number | null>(null)
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_PREFERENCES)
  const [busy, setBusy] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const areaScrollPositions = useRef<Record<PrimaryArea, number>>({ library: 0, dictionary: 0, study: 0, settings: 0 })

  const reloadLibrary = useCallback(async () => {
    setLibraryState(await appClient.library.getState())
  }, [])

  const reloadExternallyChangedData = useCallback(async () => {
    const [nextLibrary, nextPreferences] = await Promise.all([
      appClient.library.getState(),
      appClient.reader.getPreferences(),
    ])
    const publicationIds = new Set(nextLibrary.publications.map((publication) => publication.id))
    setLibraryState(nextLibrary)
    setPreferences(nextPreferences)
    setLibraryRoute((current) => current.name === 'library' || publicationIds.has(
      current.name === 'publication' ? current.id : current.publicationId,
    ) ? current : { name: 'library' })
    setDictionarySnapshot((current) => ({ ...current, selectedItem: null }))
    setStudySnapshot(DEFAULT_STUDY_SNAPSHOT)
    setSettingsSnapshot((current) => ({
      ...current,
      translationDraft: null,
      speechDraft: null,
      studyPreferences: null,
    }))
  }, [])

  const switchArea = useCallback((next: PrimaryArea) => {
    if (next === activeArea) return
    const container = document.querySelector<HTMLElement>('.main-content')
    if (container) {
      areaScrollPositions.current[activeArea] = container.scrollTop
      if (activeArea === 'library') setPendingLibraryScrollRestore(container.scrollTop)
    }
    setActiveArea(next)
  }, [activeArea])

  useLayoutEffect(() => {
    document.querySelector<HTMLElement>('.main-content')?.scrollTo({ top: areaScrollPositions.current[activeArea] })
  }, [activeArea])

  const navigateLibrary = useCallback((next: LibraryRoute) => {
    setPendingLibraryScrollRestore(null)
    setLibraryRoute(next)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.main-content')?.scrollTo({ top: 0 }))
  }, [])

  useEffect(() => {
    Promise.all([reloadLibrary(), appClient.reader.getPreferences()])
      .then(([, saved]) => setPreferences(saved))
      .catch((reason) => setError(messageOf(reason)))
      .finally(() => setBusy(false))
  }, [reloadLibrary])

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    applyLightPaperTone(preferences.theme === 'light' ? preferences.paperTint ?? DEFAULT_PREFERENCES.paperTint : null)
  }, [preferences.paperTint, preferences.theme])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => appClient.library.onImportProgress((progress) => {
    setImportProgress(progress)
    if (['completed', 'cancelled', 'error'].includes(progress.stage)) {
      window.setTimeout(() => setImportProgress(null), 1200)
    }
  }), [])

  useEffect(() => {
    appClient.speech.stop()
  }, [activeArea, libraryRoute])

  const importEpub = async () => {
    setError(null)
    setBusy(true)
    try {
      const result = await appClient.library.importPublication()
      if (!result) return
      setNotice(result.repaired ? '已重新解析并补全原刊物，阅读记录已保留' : result.duplicate ? '这本刊物已经在书库中' : `已导入 ${result.publication.articleCount} 篇文章`)
      setLibraryState(await appClient.library.getState())
      navigateLibrary({ name: 'publication', id: result.publication.id })
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const savePreferences = usePreferenceWriter(preferences, setPreferences,
    next => appClient.reader.savePreferences(next), reason => setError(messageOf(reason)))

  return (
    <SpeechProvider onError={setError}>
    <div className="app-shell">
      <aside className="app-sidebar">
        <button className="brand" onClick={() => switchArea('library')}>
          <span className="brand-mark"><AppLogo /></span>
          <span><b>外刊阅读器</b><small>PRIVATE READING DESK</small></span>
        </button>
        <nav aria-label="主要导航">
          <button className={activeArea === 'library' ? 'active' : ''} onClick={() => switchArea('library')}>
            <LibraryIcon /> <span>我的书库</span>
          </button>
          <button className={activeArea === 'dictionary' ? 'active' : ''} onClick={() => switchArea('dictionary')}>
            <DictionaryIcon /> <span>词典</span>
          </button>
          <button className={activeArea === 'study' ? 'active' : ''} onClick={() => switchArea('study')}>
            <StudyIcon /> <span>背单词</span>
          </button>
          <button className={activeArea === 'settings' ? 'active' : ''} onClick={() => switchArea('settings')}>
            <SettingsIcon /> <span>设置</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" /> 本地书库
        </div>
      </aside>

      <main className="main-content">
        {error && (
          <div className="error-banner">
            <span>{error}</span><button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {notice && <div className="toast">{notice}</div>}
        {busy && <div className="top-progress" />}
        {importProgress && !['completed', 'cancelled', 'error'].includes(importProgress.stage) && (
          <div className="import-progress-toast"><span>{importProgress.message ?? '正在导入'}</span><button onClick={() => appClient.library.cancelImport()}>取消</button></div>
        )}

        {activeArea === 'library' && <div className="primary-workspace" data-area="library">
        {libraryRoute.name === 'library' && <ArticleSearch reader={appClient.reader} onOpen={(publicationId,id)=>navigateLibrary({name:'article',publicationId,id})} />}
        {libraryRoute.name === 'library' && (
          <LibraryView state={libraryState} snapshot={librarySnapshot} onSnapshot={setLibrarySnapshot} onState={setLibraryState} onImport={importEpub} onOpen={(id) => navigateLibrary({ name: 'publication', id })} onNotice={setNotice} onError={setError} />
        )}
        {libraryRoute.name === 'publication' && (
          <PublicationView
            id={libraryRoute.id}
            onBack={() => navigateLibrary({ name: 'library' })}
            onOpenArticle={(articleId) => navigateLibrary({ name: 'article', id: articleId, publicationId: libraryRoute.id })}
            onError={setError}
          />
        )}
        {libraryRoute.name === 'article' && (
          <ReaderExperience
            id={libraryRoute.id}
            publicationId={libraryRoute.publicationId}
            active={activeArea === 'library'}
            restoreScrollTop={pendingLibraryScrollRestore}
            preferences={preferences}
            onPreferences={savePreferences}
            onBack={() => navigateLibrary({ name: 'publication', id: libraryRoute.publicationId })}
            onSettings={() => switchArea('settings')}
            onError={setError}
          />
        )}
        </div>}
        {activeArea === 'dictionary' && <div className="primary-workspace" data-area="dictionary">
          <DictionaryPage
            snapshot={dictionarySnapshot}
            onSnapshot={setDictionarySnapshot}
            onOpenArticle={(id, publicationId) => { navigateLibrary({ name: 'article', id, publicationId }); switchArea('library') }}
            onError={setError}
          />
        </div>}
        {activeArea === 'study' && <div className="primary-workspace" data-area="study"><StudyPage snapshot={studySnapshot} onSnapshot={setStudySnapshot} onError={setError} onNotice={setNotice} /></div>}
        {activeArea === 'settings' && <div className="primary-workspace" data-area="settings">
          <SettingsView preferences={preferences} snapshot={settingsSnapshot} onSnapshot={setSettingsSnapshot} onPreferences={savePreferences} onDataChanged={reloadExternallyChangedData} onNotice={setNotice} onError={setError} />
        </div>}
      </main>
    </div>
    </SpeechProvider>
  )
}

function LibraryView({
  state,
  snapshot,
  onSnapshot,
  onState,
  onImport,
  onOpen,
  onNotice,
  onError,
}: {
  state: LibraryState
  snapshot: LibraryPageSnapshot
  onSnapshot(value: LibraryPageSnapshot): void
  onState(value: LibraryState): void
  onImport(): void
  onOpen(id: string): void
  onNotice(message: string): void
  onError(message: string): void
}) {
  const { publications, categories, preferences } = state
  const [selectionMode, setSelectionMode] = useState(snapshot.selectionMode)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(snapshot.selectedIds))
  const [newCategoryName, setNewCategoryName] = useState(snapshot.newCategoryName)
  const [working, setWorking] = useState(false)
  const [renameTarget, setRenameTarget] = useState<PublicationSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [categoryRenameTarget, setCategoryRenameTarget] = useState<LibraryState['categories'][number] | null>(null)
  const [categoryRenameDraft, setCategoryRenameDraft] = useState('')
  const operationSequence = useRef(0)

  useEffect(() => {
    const valid = new Set(publications.map((publication) => publication.id))
    setSelectedIds((current) => new Set([...current].filter((id) => valid.has(id))))
  }, [publications])

  useEffect(() => {
    onSnapshot({ selectionMode, selectedIds: [...selectedIds], newCategoryName })
  }, [newCategoryName, onSnapshot, selectedIds, selectionMode])

  const visiblePublications = useMemo(() => {
    const filtered = publications.filter((publication) => {
      if (preferences.activeCategoryId === 'all') return true
      if (preferences.activeCategoryId === 'uncategorized') return publication.categoryId === null
      return publication.categoryId === preferences.activeCategoryId
    })
    const direction = preferences.sortDirection === 'asc' ? 1 : -1
    return filtered.sort((left, right) => {
      const compared = preferences.sortBy === 'name'
        ? left.title.localeCompare(right.title, 'zh-CN', { numeric: true, sensitivity: 'base' })
        : left.importedAt.localeCompare(right.importedAt)
      return compared * direction
    })
  }, [preferences, publications])

  const run = async (operation: () => Promise<LibraryState>, notice?: string): Promise<boolean> => {
    const sequence = ++operationSequence.current
    setWorking(true)
    try {
      const next = await operation()
      if (sequence === operationSequence.current) {
        onState(next)
        if (notice) onNotice(notice)
      }
      return true
    } catch (reason) { onError(messageOf(reason)); return false }
    finally { if (sequence === operationSequence.current) setWorking(false) }
  }

  const savePreferences = (next: Partial<LibraryPreferences>) => run(
    () => appClient.library.savePreferences({ ...preferences, ...next }),
  )
  const setCategory = (activeCategoryId: string) => {
    setSelectedIds(new Set())
    void savePreferences({ activeCategoryId })
  }
  const toggleSelectionMode = () => {
    setSelectionMode((current) => !current)
    setSelectedIds(new Set())
  }
  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const selectAll = () => {
    const visibleIds = visiblePublications.map((publication) => publication.id)
    setSelectedIds(selectedIds.size === visibleIds.length ? new Set() : new Set(visibleIds))
  }
  const createCategory = () => {
    if (!newCategoryName.trim()) return
    void (async () => {
      if (await run(() => appClient.library.createCategory(newCategoryName), '分类已创建')) setNewCategoryName('')
    })()
  }
  const renameCategory = (categoryId: string, currentName: string) => {
    setCategoryRenameTarget({ id: categoryId, name: currentName, createdAt: '' })
    setCategoryRenameDraft(currentName)
  }
  const confirmCategoryRename = async () => {
    if (!categoryRenameTarget || !categoryRenameDraft.trim() || categoryRenameDraft.trim() === categoryRenameTarget.name) return
    if (await run(() => appClient.library.renameCategory(categoryRenameTarget.id, categoryRenameDraft), '分类已重命名')) {
      setCategoryRenameTarget(null)
      setCategoryRenameDraft('')
    }
  }
  const deleteCategory = (categoryId: string, name: string) => {
    if (!window.confirm(`删除分类“${name}”？其中的书籍会移到“未分类”，书籍本身不会删除。`)) return
    void run(() => appClient.library.deleteCategory(categoryId), '分类已删除')
  }
  const renamePublication = (publication: PublicationSummary) => {
    setRenameTarget(publication)
    setRenameDraft(publication.title)
  }
  const confirmPublicationRename = async () => {
    if (!renameTarget || !renameDraft.trim() || renameDraft.trim() === renameTarget.title) return
    if (await run(() => appClient.library.renamePublication(renameTarget.id, renameDraft), '书名已更新')) {
      setRenameTarget(null)
      setRenameDraft('')
    }
  }
  const deleteSelected = (ids: string[]) => {
    if (ids.length === 0 || !window.confirm(`确定删除选中的 ${ids.length} 本书？原始文件、文章和相关翻译缓存都会从本机移除。`)) return
    void (async () => {
      if (await run(() => appClient.library.deletePublications(ids), `已删除 ${ids.length} 本书`)) {
        setSelectedIds(new Set())
        setSelectionMode(false)
      }
    })()
  }
  const assignSelected = (value: string) => {
    if (selectedIds.size === 0) return
    void (async () => {
      if (await run(
        () => appClient.library.assignPublications([...selectedIds], value === '__uncategorized__' ? null : value),
        `已整理 ${selectedIds.size} 本书`,
      )) setSelectedIds(new Set())
    })()
  }
  const categoryName = (categoryId: string | null) =>
    categoryId ? categories.find((category) => category.id === categoryId)?.name ?? '未分类' : '未分类'

  return (
    <section className="page library-page">
      <header className="page-header">
        <div><p className="eyebrow">LIBRARY</p><h1>我的书库</h1><p>分类、整理并阅读你的英文刊物。</p></div>
        <button className="primary-button button-with-icon" onClick={onImport}><PlusIcon />导入刊物</button>
      </header>
      {publications.length === 0 ? (
        <div className="empty-state">
          <div className="empty-book">E</div>
          <h2>从一本刊物开始</h2>
          <p>导入无 DRM 的 EPUB 文件，应用会自动识别目录、栏目与文章。</p>
          <button className="primary-button button-with-icon" onClick={onImport}><PlusIcon />选择 EPUB 文件</button>
        </div>
      ) : (
        <div className="library-manager">
          <aside className="library-categories">
            <div className="library-category-heading"><h2>分类</h2><small>{publications.length} 本</small></div>
            <button className={preferences.activeCategoryId === 'all' ? 'active' : ''} onClick={() => setCategory('all')}><span>全部书籍</span><small>{publications.length}</small></button>
            <button className={preferences.activeCategoryId === 'uncategorized' ? 'active' : ''} onClick={() => setCategory('uncategorized')}><span>未分类</span><small>{publications.filter((item) => !item.categoryId).length}</small></button>
            {categories.map((category) => <div className={`library-category-row ${preferences.activeCategoryId === category.id ? 'active' : ''}`} key={category.id}>
              <button onClick={() => setCategory(category.id)}><span>{category.name}</span><small>{publications.filter((item) => item.categoryId === category.id).length}</small></button>
              <div><button aria-label={`重命名分类 ${category.name}`} onClick={() => renameCategory(category.id, category.name)}>改</button><button aria-label={`删除分类 ${category.name}`} onClick={() => deleteCategory(category.id, category.name)}>删</button></div>
            </div>)}
            <div className="library-category-create"><input value={newCategoryName} maxLength={100} placeholder="新分类名称" aria-label="新分类名称" onChange={(event) => setNewCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createCategory() }} /><button disabled={!newCategoryName.trim() || working} onClick={createCategory}><PlusIcon />建立分类</button></div>
          </aside>
          <div className="library-browser">
            <div className="library-toolbar">
              <div className="library-toolbar-group">
                <button className={selectionMode ? 'active' : ''} onClick={toggleSelectionMode}>{selectionMode ? '退出选择' : '选择'}</button>
                {selectionMode && <button onClick={selectAll}>{selectedIds.size === visiblePublications.length ? '取消全选' : '全选'}</button>}
              </div>
              <div className="library-toolbar-group library-sort-controls">
                <label>排序<select value={preferences.sortBy} onChange={(event) => savePreferences({ sortBy: event.target.value as LibraryPreferences['sortBy'] })}><option value="name">名称</option><option value="importedAt">导入时间</option></select></label>
                <select aria-label="排序方向" value={preferences.sortDirection} onChange={(event) => savePreferences({ sortDirection: event.target.value as LibraryPreferences['sortDirection'] })}><option value="asc">正序</option><option value="desc">倒序</option></select>
                <div className="library-view-switch" aria-label="查看方式"><button className={preferences.viewMode === 'grid' ? 'active' : ''} onClick={() => savePreferences({ viewMode: 'grid' })}>图标</button><button className={preferences.viewMode === 'list' ? 'active' : ''} onClick={() => savePreferences({ viewMode: 'list' })}>列表</button></div>
              </div>
            </div>
            {selectionMode && <div className="library-bulk-bar"><b>已选择 {selectedIds.size} 本</b><label>移动到<select aria-label="批量移动到分类" value="" disabled={selectedIds.size === 0 || working} onChange={(event) => assignSelected(event.target.value)}><option value="" disabled>选择分类</option><option value="__uncategorized__">未分类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><button className="danger-button" disabled={selectedIds.size === 0 || working} onClick={() => deleteSelected([...selectedIds])}>批量删除</button></div>}
            {visiblePublications.length === 0 ? <div className="library-folder-empty"><h2>这个分类还是空的</h2><p>选择书籍后可以批量移动到这里。</p></div> : preferences.viewMode === 'grid' ? (
              <div className="book-grid managed-book-grid">
                {visiblePublications.map((publication) => (
                  <article className={`book-card managed-book-card ${selectionMode ? 'selection-mode' : ''} ${selectedIds.has(publication.id) ? 'selected' : ''}`} key={publication.id}>
                    <button
                      className="book-open"
                      aria-label={selectionMode ? `${selectedIds.has(publication.id) ? '取消选择' : '选择'} ${publication.title}` : undefined}
                      aria-pressed={selectionMode ? selectedIds.has(publication.id) : undefined}
                      onClick={() => selectionMode ? toggleSelected(publication.id) : onOpen(publication.id)}
                    >
                      <div className="cover-wrap">
                        {publication.coverUrl
                      ? <img src={publication.coverUrl} alt={`${publication.title} 封面`} loading="lazy" decoding="async" />
                          : <div className="cover-placeholder"><b>E</b><span>{publication.title}</span></div>}
                      </div>
                      <div className="book-meta"><h2>{publication.title}</h2><p>{publication.articleCount} 篇文章 · {publication.sectionCount} 个栏目</p><small>{categoryName(publication.categoryId)} · {new Date(publication.importedAt).toLocaleDateString('zh-CN')} 导入</small></div>
                    </button>
                    {!selectionMode && <div className="book-actions"><button onClick={() => renamePublication(publication)}>重命名</button><button onClick={() => deleteSelected([publication.id])}>删除</button></div>}
                  </article>
                ))}
                <button className="book-card add-card" onClick={onImport}><span><PlusIcon /></span><b>导入新刊物</b><small>支持无 DRM 的 EPUB 文件</small></button>
              </div>
            ) : <div className="book-list"><div className="book-list-header"><span>{selectionMode ? '选择' : ''}</span><span>书名</span><span>分类</span><span>导入时间</span><span>内容</span><span>操作</span></div>{visiblePublications.map((publication) => <div className={`book-list-row ${selectedIds.has(publication.id) ? 'selected' : ''}`} key={publication.id}>
              <span>{selectionMode && <button className="row-selection-toggle" aria-label={`${selectedIds.has(publication.id) ? '取消选择' : '选择'} ${publication.title}`} aria-pressed={selectedIds.has(publication.id)} onClick={() => toggleSelected(publication.id)}>{selectedIds.has(publication.id) && <CheckIcon/>}</button>}</span>
              <button className="book-list-title" onClick={() => selectionMode ? toggleSelected(publication.id) : onOpen(publication.id)}>{publication.coverUrl ? <img src={publication.coverUrl} alt="" loading="lazy" decoding="async" /> : <span>E</span>}<b>{publication.title}</b></button>
              <span>{categoryName(publication.categoryId)}</span><span>{new Date(publication.importedAt).toLocaleDateString('zh-CN')}</span><span>{publication.articleCount} 篇</span>
              <span className="book-list-actions"><button onClick={() => renamePublication(publication)}>重命名</button><button onClick={() => deleteSelected([publication.id])}>删除</button></span>
            </div>)}</div>}
          </div>
        </div>
      )}
      {renameTarget && <div className="modal-backdrop"><form className="library-rename-dialog" onSubmit={(event) => { event.preventDefault(); void confirmPublicationRename() }}><h2>重命名书籍</h2><p>原始刊物标题会保留，新的名称仅用于你的书库。</p><label>书名<input autoFocus maxLength={200} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} /></label><div className="button-row"><button type="button" onClick={() => setRenameTarget(null)}>取消</button><button type="submit" className="primary-button" disabled={working || !renameDraft.trim() || renameDraft.trim() === renameTarget.title}>{working ? '保存中…' : '保存名称'}</button></div></form></div>}
      {categoryRenameTarget && <div className="modal-backdrop"><form className="library-rename-dialog" onSubmit={(event) => { event.preventDefault(); void confirmCategoryRename() }}><h2>重命名分类</h2><label>分类名称<input autoFocus maxLength={100} value={categoryRenameDraft} onChange={(event) => setCategoryRenameDraft(event.target.value)} /></label><div className="button-row"><button type="button" onClick={() => setCategoryRenameTarget(null)}>取消</button><button type="submit" className="primary-button" disabled={working || !categoryRenameDraft.trim() || categoryRenameDraft.trim() === categoryRenameTarget.name}>{working ? '保存中…' : '保存名称'}</button></div></form></div>}
    </section>
  )
}

function PublicationView({
  id,
  onBack,
  onOpenArticle,
  onError,
}: {
  id: string
  onBack(): void
  onOpenArticle(id: string): void
  onError(message: string): void
}) {
  const [publication, setPublication] = useState<PublicationDetail | null>(null)
  useEffect(() => {
    appClient.library.getPublication(id).then(setPublication).catch((reason) => onError(messageOf(reason)))
  }, [id, onError])
  if (!publication) return <Loading label="正在整理目录…" />

  return (
    <section className="page contents-page">
      <button className="back-button button-with-icon" onClick={onBack}><ArrowLeftIcon />返回书库</button>
      <div className="publication-hero">
        {publication.coverUrl && <img src={publication.coverUrl} alt="刊物封面" loading="lazy" decoding="async" />}
        <div>
          <p className="eyebrow">ISSUE CONTENTS</p>
          <h1>{publication.title}</h1>
          <p>{publication.articleCount} 篇文章，按原刊栏目与阅读顺序整理。</p>
          {publication.lastArticleId && (
            <button className="primary-button" onClick={() => onOpenArticle(publication.lastArticleId!)}>继续阅读 →</button>
          )}
        </div>
      </div>

      {publication.unsectionedArticles.length > 0 && (
        <ArticleList title="开篇" articles={publication.unsectionedArticles} onOpen={onOpenArticle} />
      )}
      {publication.sections.map((section) => (
        <ArticleList key={section.id} title={section.title} articles={section.articles} onOpen={onOpenArticle} />
      ))}
    </section>
  )
}

function ArticleList({ title, articles, onOpen }: { title: string; articles: PublicationDetail['unsectionedArticles']; onOpen(id: string): void }) {
  return (
    <section className="toc-section">
      <h2><span>{title}</span><small>{articles.length}</small></h2>
      <div>
        {articles.map((article, index) => (
          <button key={article.id} onClick={() => onOpen(article.id)}>
            <span className="toc-number">{String(index + 1).padStart(2, '0')}</span>
            <span><b>{article.title}</b>{article.rubric && <small>{article.rubric}</small>}</span>
            <span className="toc-arrow">→</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function SettingsView({
  preferences,
  snapshot,
  onSnapshot,
  onPreferences,
  onDataChanged,
  onNotice,
  onError,
}: {
  preferences: ReaderPreferences
  snapshot: SettingsSnapshot
  onSnapshot(value: SettingsSnapshot): void
  onPreferences(value: ReaderPreferences): void
  onDataChanged(): void | Promise<void>
  onNotice(message: string): void
  onError(message: string): void
}) {
  const initialSnapshotRef = useRef(snapshot)
  const [translationSettings, setTranslationSettings] = useState<TranslationSettings | null>(null)
  const [translationDraft, setTranslationDraft] = useState<TranslationPreferences>(snapshot.translationDraft ?? {
    providerId: 'deepseek', modelId: 'deepseek-v4-flash',
  })
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [dictionaryStatus, setDictionaryStatus] = useState<DictionaryStatus | null>(null)
  const [dictionaryCredentialStatus, setDictionaryCredentialStatus] = useState<DictionaryCredentialStatus | null>(null)
  const [dictionaryPreferences, setDictionaryPreferences] = useState<DictionaryPreferences>({ enabled:true,lookupProviderId:'ecdict',fallbackToLocal:true,contextExplanationEnabled:true,translateExamples:false })
  const [baiduApiKey,setBaiduApiKey]=useState('')
  const [baiduSecretKey,setBaiduSecretKey]=useState('')
  const [installProgress, setInstallProgress] = useState<DictionaryInstallProgress | null>(null)
  const [dataProgress, setDataProgress] = useState<DataTransferProgress | null>(null)
  const [importPreview, setImportPreview] = useState<PortableImportPreview | null>(null)
  const [studyPreferences, setStudyPreferences] = useState<StudyPreferences | null>(null)
  const [savedStudyPreferences, setSavedStudyPreferences] = useState<StudyPreferences | null>(null)
  const [developerState, setDeveloperState] = useState<DeveloperState | null>(null)
  const [storageReport, setStorageReport] = useState<StorageReport | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [developerVisible, setDeveloperVisible] = useState(snapshot.developerVisible)
  const unlockClicks = useRef<number[]>([])
  const [section, setSection] = useState<SettingsSection>(snapshot.section)
  const speech = useSpeech()
  const [speechDraft, setSpeechDraft] = useState<SpeechPreferences>(snapshot.speechDraft ?? speech.preferences)
  const [speechSettings, setSpeechSettings] = useState<SpeechSettings | null>(null)
  const [speechKeys, setSpeechKeys] = useState<Record<string, string>>({})
  const [speechTesting, setSpeechTesting] = useState<string | null>(null)
  useEffect(() => {
    if (!snapshot.speechDraft) setSpeechDraft(speech.preferences)
  }, [snapshot.speechDraft, speech.preferences])
  const refreshDictionary = useCallback(async () => {
    const [nextStatus, nextPreferences, nextCredentialStatus] = await Promise.all([
      appClient.dictionary.getStatus(),
      appClient.dictionary.getPreferences(),
      appClient.dictionary.getCredentialStatus(),
    ])
    setDictionaryStatus(nextStatus)
    setDictionaryPreferences(nextPreferences)
    setDictionaryCredentialStatus(nextCredentialStatus)
  }, [])
  const refreshExternallyChangedData = useCallback(async () => {
    await onDataChanged()
    const [nextTranslation, nextSpeech, nextStudyPreferences] = await Promise.all([
      appClient.settings.getTranslationSettings(),
      appClient.speech.getSettings(),
      appClient.study.getPreferences(),
      refreshDictionary(),
      speech.refreshPreferences(),
    ])
    setTranslationSettings(nextTranslation)
    setTranslationDraft(nextTranslation.preferences)
    setSpeechSettings(nextSpeech)
    setSpeechDraft(nextSpeech.preferences)
    setStudyPreferences(nextStudyPreferences)
    setSavedStudyPreferences(nextStudyPreferences)
  }, [onDataChanged, refreshDictionary, speech])
  useEffect(() => {
    const initialSnapshot = initialSnapshotRef.current
    appClient.settings.getTranslationSettings().then((settings) => {
      setTranslationSettings(settings)
      if (!initialSnapshot.translationDraft) setTranslationDraft(settings.preferences)
    }).catch((reason) => onError(messageOf(reason)))
    appClient.speech.getSettings().then((settings) => {
      setSpeechSettings(settings)
      if (!initialSnapshot.speechDraft) setSpeechDraft(settings.preferences)
    }).catch((reason) => onError(messageOf(reason)))
    refreshDictionary().catch((reason) => onError(messageOf(reason)))
    Promise.all([appClient.study.getPreferences(), appClient.developer.getState()])
      .then(([study, developer]) => { setStudyPreferences(initialSnapshot.studyPreferences ?? study); setSavedStudyPreferences(study); setDeveloperState(developer) })
      .catch((reason) => onError(messageOf(reason)))
    return appClient.dictionary.onInstallProgress((progress) => {
      setInstallProgress(progress)
      if (['completed', 'cancelled', 'error'].includes(progress.stage)) {
        refreshDictionary().catch((reason) => onError(messageOf(reason)))
      }
    })
  }, [onError, refreshDictionary])
  useEffect(() => appClient.data.onProgress(setDataProgress), [])
  const scanStorage = useCallback(async () => {
    setStorageLoading(true)
    try { setStorageReport(await appClient.storage.scan()) }
    catch (reason) { onError(messageOf(reason)) }
    finally { setStorageLoading(false) }
  }, [onError])
  useEffect(() => { if (section === 'data') void scanStorage() }, [scanStorage, section])
  useEffect(() => {
    onSnapshot({ section, translationDraft, speechDraft, studyPreferences, developerVisible })
  }, [developerVisible, onSnapshot, section, speechDraft, studyPreferences, translationDraft])
  useEffect(() => { if (!developerVisible && section === 'developer') setSection('data') }, [developerVisible, section])

  const saveProviderKey = async () => {
    try {
      setTranslationSettings(await appClient.settings.saveProviderKey(translationDraft.providerId, key))
      setKey('')
      onNotice('API Key 已加密保存')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const saveTranslationSelection = async () => {
    try {
      const settings = await appClient.settings.saveTranslationPreferences(translationDraft)
      setTranslationSettings(settings)
      setTranslationDraft(settings.preferences)
      onNotice('翻译模型已保存')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const saveSpeechProviderKey = async (providerId: RemoteSpeechProviderId) => {
    try {
      setSpeechSettings(await appClient.speech.saveProviderKey(providerId, speechKeys[providerId] ?? ''))
      setSpeechKeys(current => ({ ...current, [providerId]: '' }))
      onNotice('语音服务 API Key 已加密保存')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const removeSpeechProviderKey = async (providerId: RemoteSpeechProviderId) => {
    try {
      setSpeechSettings(await appClient.speech.deleteProviderKey(providerId))
      onNotice('语音服务 API Key 已删除')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const testSpeechConnection = async (providerId: RemoteSpeechProviderId) => {
    setSpeechTesting(providerId)
    try {
      const result = await appClient.speech.testConnection(providerId)
      result.ok ? onNotice(result.message) : onError(result.message)
    } catch (reason) { onError(messageOf(reason)) }
    finally { setSpeechTesting(null) }
  }
  const testTranslationConnection = async () => {
    setTesting(true)
    try {
      const result = await appClient.settings.testTranslationConnection(translationDraft)
      result.ok ? onNotice(result.message) : onError(result.message)
    } catch (reason) { onError(messageOf(reason)) }
    finally { setTesting(false) }
  }
  const removeProviderKey = async () => {
    try {
      setTranslationSettings(await appClient.settings.deleteProviderKey(translationDraft.providerId))
      onNotice('API Key 已删除')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const saveDictionaryPreferences = async (next: DictionaryPreferences) => {
    try {
      setDictionaryPreferences(await appClient.dictionary.savePreferences(next))
    } catch (reason) { onError(messageOf(reason)) }
  }
  const installDictionary = async (local: boolean, profile: Exclude<DictionaryLocalProfile,'none'> = 'standard') => {
    setDictionaryStatus((current) => current ? { ...current, installing: true } : current)
    setInstallProgress({ stage: local ? 'indexing-entries' : 'downloading-dictionary', downloadedBytes: 0, totalBytes: 0, indexedEntries: 0 })
    try {
      if (local) {
        const selected = await appClient.dictionary.installFromLocal(profile)
        if (!selected) {
          setInstallProgress(null)
          await refreshDictionary()
          return
        }
      } else await appClient.dictionary.install(profile)
      await refreshDictionary()
      onNotice(profile==='full'?'ECDICT 完整扩展已安装':'ECDICT 标准学习包已安装')
    } catch (reason) {
      const message = messageOf(reason)
      if (!/取消/.test(message)) onError(message)
    }
  }
  const studyDirty = Boolean(studyPreferences && savedStudyPreferences && !sameStudyPreferences(studyPreferences, savedStudyPreferences))
  const saveStudyPreferences = async () => {
    if (!studyPreferences) return
    try {
      const saved = await appClient.study.savePreferences(studyPreferences)
      setStudyPreferences(saved)
      setSavedStudyPreferences(saved)
      onNotice('学习设置已保存')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const resetStudyDraft = () => {
    if (savedStudyPreferences) setStudyPreferences(savedStudyPreferences)
  }
  const removeDictionary = async () => {
    if (!window.confirm('删除本地 ECDICT 词典？书库、生词和收藏语境不会被删除。')) return
    try {
      await appClient.dictionary.remove()
      setInstallProgress(null)
      await refreshDictionary()
      onNotice('本地词典已删除')
    } catch (reason) { onError(messageOf(reason)) }
  }
  const exportPortable = async () => {
    try {
      const result = await appClient.data.exportPortable()
      if (result) onNotice(`便携备份已导出：${result.fileName}（${formatBytes(result.bytes)}）`)
    } catch (reason) { onError(messageOf(reason)) }
  }
  const selectPortableImport = async () => {
    try {
      setImportPreview(await appClient.data.selectPortableImport())
    } catch (reason) { onError(messageOf(reason)) }
  }
  const confirmPortableImport = async () => {
    if (!importPreview) return
    try {
      const result = await appClient.data.confirmPortableImport(importPreview.token)
      setImportPreview(null)
      await refreshExternallyChangedData()
      onNotice(`导入完成：新增 ${result.importedPublications ?? 0} 本，重复 ${result.duplicatePublications ?? 0} 本`)
    } catch (reason) { onError(messageOf(reason)) }
  }
  const handleSettingsTitleClick = () => {
    const now = Date.now()
    const recent = [...unlockClicks.current.filter((time) => now - time <= 5_000), now]
    unlockClicks.current = recent
    if (recent.length < 10) return
    unlockClicks.current = []
    setDeveloperVisible(current => {
      const next = !current
      onNotice(next ? '开发与调试入口已显示' : '开发与调试入口已隐藏')
      return next
    })
  }
  const clearSafeCache = async () => {
    try {
      const result = await appClient.storage.clearSafeCache()
      setStorageReport(result.report)
      onNotice(`已清理安全缓存 ${formatBytes(result.clearedBytes)}`)
    } catch (reason) { onError(messageOf(reason)) }
  }
  const clearAiTextCache = async () => {
    if (!confirm('清理后，已生成的文章译文和 AI 文中义会消失；再次生成可能产生 API 费用。确定继续？')) return
    if (!confirm('再次确认：收藏语境、生词和学习数据会保留，但 AI 文本缓存将永久删除。')) return
    try {
      const result = await appClient.storage.clearAiTextCache('CLEAR_AI_TEXT_CACHE')
      setStorageReport(result.report)
      onNotice(`已清理 AI 文本缓存 ${formatBytes(result.clearedBytes)}`)
    } catch (reason) { onError(messageOf(reason)) }
  }
  const setDeveloperEnabled = async (enabled: boolean) => {
    if (enabled && !confirm('启用开发与调试功能？其中包含不可撤销操作。')) return
    try { setDeveloperState(await appClient.developer.setEnabled(enabled)) }
    catch (reason) { onError(messageOf(reason)) }
  }
  const factoryReset = async () => {
    if (!confirm('恢复出厂会删除书库、学习数据、词典、设置、API 密钥、缓存和日志。已导出到其他目录的备份不受影响。继续？')) return
    const phrase = prompt('再次确认：请输入“恢复出厂设置”')
    if (phrase !== '恢复出厂设置') { if (phrase != null) onError('确认短语不正确'); return }
    try { await appClient.developer.factoryReset(phrase) }
    catch (reason) { onError(messageOf(reason)) }
  }
  const changeSpeechLocale = (locale: SpeechPreferences['locale']) => {
    const providerSettings = { ...speechDraft.providerSettings }
    for (const provider of speechSettings?.providers.filter(item => item.id !== 'system') ?? []) {
                  const id = provider.id as RemoteSpeechProviderId
      const current = providerSettings[id]
      if (!provider.voices.some(voice => voice.id === current.voiceId && voice.locales.includes(locale))) {
        const fallback = provider.voices.find(voice => voice.locales.includes(locale))
        if (fallback) providerSettings[id] = { ...current, voiceId: fallback.id }
      }
    }
    setSpeechDraft({ ...speechDraft, locale, voiceId: null, providerSettings })
  }

  const selectedTranslationProvider = translationSettings?.providers.find(
    (provider) => provider.id === translationDraft.providerId,
  ) ?? null
  const selectedTranslationModel = selectedTranslationProvider?.models.find(
    (model) => model.id === translationDraft.modelId,
  ) ?? null
  const translationSelectionDirty = Boolean(translationSettings && (
    translationSettings.preferences.providerId !== translationDraft.providerId
    || translationSettings.preferences.modelId !== translationDraft.modelId
  ))

  const selectTranslationProvider = (providerId: string) => {
    const provider = translationSettings?.providers.find((item) => item.id === providerId)
    if (!provider?.models[0]) return
    setTranslationDraft({ providerId, modelId: provider.models[0].id })
    setKey('')
  }

  return (
    <section className="page settings-page">
      <header className="page-header"><div><p className="eyebrow">PREFERENCES</p><h1 className="settings-unlock-title" onClick={handleSettingsTitleClick}>设置</h1><p>集中管理阅读、学习与本机服务。</p></div></header>
      <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {([
          ['appearance', '阅读外观', <AppearanceIcon />],
          ['translation', '翻译服务', <TranslateIcon />],
          ['dictionary', '词典服务', <DictionaryIcon />],
          ['speech', '语音服务', <SpeakerIcon />],
          ['study', '每日学习', <StudyIcon />],
          ['data', '数据与存储', <DatabaseIcon />],
          ...(developerVisible ? [['developer', '开发与调试', <SettingsIcon />] as [SettingsSection, string, ReactNode]] : []),
        ] as Array<[SettingsSection, string, ReactNode]>).map(([value, label, icon]) => <button key={value} className={section === value ? 'active' : ''} onClick={() => setSection(value)}>{icon}<span>{label}</span></button>)}
      </nav>
      <div className="settings-content">
      {section === 'sync' && <>
      <button className="settings-back-button" onClick={() => setSection('data')}>← 返回数据与存储</button>
      <div className="settings-card sync-settings-card">
        <div className="setting-heading"><div><h2>跨设备同步</h2><p>在同一局域网内发现另一台外刊阅读器，配对后由当前设备定向发送增量变化。两端都必须保持此页面在前台。</p></div><span className="pill success">wire v2</span></div>
        <SyncSettingsPanel api={appClient.sync} onDataChanged={refreshExternallyChangedData} onError={onError} />
      </div>
      </>}
      {section === 'data' && <>
      <div className="settings-card data-management">
        <div className="setting-heading">
          <div><h2>备份管理</h2><p>便携备份包含刊物的规范化正文与图片、设置、阅读位置、生词、收藏语境和长期学习数据；不会包含原始 EPUB、活动学习队列、开发模式、密钥、词典或 AI 缓存。</p></div>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={exportPortable}>导出便携备份</button>
          <button className="secondary-button" onClick={selectPortableImport}>导入便携备份</button>
        </div>
        {importPreview && (
          <div className="import-preview">
            <b>{importPreview.fileName}</b>
            <p>{formatBytes(importPreview.totalBytes)} · {importPreview.publicationCount} 本书籍（新增 {importPreview.newPublicationCount}，重复 {importPreview.duplicatePublicationCount}）</p>
            <p>{importPreview.readerRecordCount ?? 0} 条文章记录（位置、标记和保留译文） · {importPreview.settingCount} 项设置 · {importPreview.readingPositionCount} 条阅读位置 · {importPreview.vocabularyCount} 个生词 · {importPreview.studyPlanCount} 个计划 · {importPreview.reviewCardCount} 张卡片 · {importPreview.reviewEventCount} 次复习</p>
            <div className="button-row"><button className="primary-button" onClick={confirmPortableImport}>确认合并</button><button onClick={() => { appClient.data.cancelTransfer(); setImportPreview(null) }}>取消</button></div>
          </div>
        )}
        {dataProgress && !['completed', 'cancelled', 'error'].includes(dataProgress.stage) && (
          <div className="install-progress-box">
            <div><b>{dataProgress.message ?? '处理中'}</b><span>{dataProgress.totalBytes > 0 ? `${Math.round(dataProgress.completedBytes / dataProgress.totalBytes * 100)}%` : ''}</span></div>
            <progress value={dataProgress.totalBytes > 0 ? dataProgress.completedBytes : undefined} max={dataProgress.totalBytes || undefined} />
            <button onClick={() => appClient.data.cancelTransfer()}>取消</button>
          </div>
        )}
      </div>
      <div className="settings-card storage-card">
        <div className="setting-heading"><div><h2>存储空间</h2><p>应用程序、资源、个人数据与缓存的本机占用；统计值可能随运行状态轻微变化。</p></div><button className="secondary-button" disabled={storageLoading} onClick={scanStorage}>{storageLoading ? '扫描中…' : '重新扫描'}</button></div>
        {storageReport ? <>
          <div className="storage-total"><span>总占用</span><b>{formatBytes(storageReport.totalBytes)}</b><small>{storageReport.packaged ? `扫描于 ${formatDateTime(storageReport.scannedAt)}` : '开发环境不计项目源码与依赖'}</small></div>
          <div className="storage-category-grid">{storageReport.categories.map(category => <div className={`storage-category ${category.id}`} key={category.id}><header><b>{category.label}</b><strong>{formatBytes(category.bytes)}</strong></header>{category.entries.map(entry=><div key={entry.id}><span>{entry.label}</span><small>{formatBytes(entry.bytes)}</small></div>)}</div>)}</div>
          <div className="cache-actions"><button className="secondary-button" onClick={clearSafeCache}>清理安全缓存</button><button className="danger-button" onClick={clearAiTextCache}>清理 AI 文本缓存</button><small>安全缓存包含 Google/MiniMax 音频及浏览器缓存；AI 文本需单独确认。</small></div>
        </> : <p>{storageLoading ? '正在扫描存储空间…' : '尚未扫描'}</p>}
      </div>
      <div className="settings-card sync-entry-card"><div className="setting-heading"><div><h2>跨设备同步</h2><p>通过局域网发现 Windows 或 Android 设备，配对后按发送端优先规则增量同步解析后的刊物内容、阅读位置、生词与学习数据。</p></div><span className="pill success">可用</span></div><button className="primary-button" onClick={() => setSection('sync')}>打开跨设备同步</button></div>
      <div className="settings-card compact"><div><h2>本地数据目录</h2><p>书库、译文缓存和设置均保存在 Windows 用户数据目录。</p></div><button className="secondary-button" onClick={() => appClient.settings.openDataDirectory().catch((reason) => onError(messageOf(reason)))}>打开数据目录</button></div>
      </>}
      {section === 'translation' &&
      <div className="settings-card">
        <div className="setting-heading"><div><h2>模型翻译</h2><p>可手动选择供应商与模型；每家供应商的密钥独立保存，并使用 Windows DPAPI 保护。</p></div><span className={selectedTranslationProvider?.keyStatus.configured ? 'pill success' : 'pill'}>{selectedTranslationProvider?.keyStatus.configured ? '已配置' : '未配置'}</span></div>
        {translationSettings ? <>
          <label>模型供应商
            <select value={translationDraft.providerId} onChange={(event) => selectTranslationProvider(event.target.value)}>
              {translationSettings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label>翻译模型
            <select value={translationDraft.modelId} onChange={(event) => setTranslationDraft((current) => ({ ...current, modelId: event.target.value }))}>
              {selectedTranslationProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            {selectedTranslationModel && <small>{selectedTranslationModel.description}</small>}
          </label>
          <div className="button-row translation-selection-actions"><button className="primary-button" disabled={!translationSelectionDirty} onClick={saveTranslationSelection}>保存模型选择</button></div>
          {selectedTranslationProvider?.keyStatus.configured && <div className="saved-key"><code>{selectedTranslationProvider.keyStatus.masked}</code><button onClick={removeProviderKey}>删除</button></div>}
          <label>{selectedTranslationProvider?.name ?? '供应商'} API Key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={selectedTranslationProvider?.keyStatus.configured ? '输入新密钥以替换' : 'sk-…'} /></label>
          <div className="button-row"><button className="primary-button" disabled={!key.trim()} onClick={saveProviderKey}>保存密钥</button><button className="secondary-button" disabled={!selectedTranslationProvider?.keyStatus.configured || testing} onClick={testTranslationConnection}>{testing ? '连接中…' : '测试所选模型'}</button></div>
        </> : <p>正在读取翻译服务设置…</p>}
      </div>}
      {section === 'dictionary' &&
      <div className="settings-card dictionary-settings">
        <div className="setting-heading dictionary-service-heading">
          <div><h2>词典服务</h2><p>本地数据来自 skywind3000/ECDICT · MIT；百度可按需补充中文详释和例句。</p></div>
          <div className="settings-inline-controls">
            <ToggleSwitch checked={dictionaryPreferences.enabled} onChange={enabled=>saveDictionaryPreferences({...dictionaryPreferences,enabled})} label="点击查词"/>
            <ToggleSwitch checked={dictionaryPreferences.contextExplanationEnabled} onChange={contextExplanationEnabled=>saveDictionaryPreferences({...dictionaryPreferences,contextExplanationEnabled})} label="文中义分析"/>
          </div>
        </div>
        <section className="dictionary-settings-section dictionary-local-section">
          <div className="dictionary-section-heading"><div><h3>本地词典</h3><p>标准学习包是查词、收藏和学习计划的本地基座；完整扩展提供更多长尾定义。</p></div><span className={dictionaryStatus?.installed ? 'pill success' : 'pill'}>{dictionaryStatus?.installed ? '已安装' : '未安装'}</span></div>
        {dictionaryStatus?.installed ? (
          <div className="dictionary-pack-status">
            <div><b>{dictionaryStatus.effectiveProfile==='full'?'ECDICT 完整词典':'ECDICT 标准学习包'}</b><p>版本 {dictionaryStatus.version} · {formatNumber(dictionaryStatus.entryCount)} 词条 · 基础 {formatBytes(dictionaryStatus.base.sizeBytes)}{dictionaryStatus.fullExtensionInstalled?` · 扩展 ${formatBytes(dictionaryStatus.full.sizeBytes)}`:''}</p><small>skywind3000/ECDICT · MIT · 分层 schema v4</small></div>
            <div className="button-row">{dictionaryStatus.effectiveProfile==='standard'?<button className="primary-button" onClick={() => installDictionary(false,'full')}>升级为完整包</button>:<button className="secondary-button" onClick={async()=>{await appClient.dictionary.removeFullExtension();await refreshDictionary();onNotice('已降级为标准学习包')}}>降级为标准包</button>}<button className="secondary-button" onClick={() => installDictionary(false,dictionaryStatus.effectiveProfile==='full'?'full':'standard')}>修复</button><button className="danger-button" onClick={removeDictionary}>删除词典</button></div>
          </div>
        ) : (
          <div className="dictionary-pack-status">
            <div><b>ECDICT 分层词典</b><p>标准包保留词形、简明释义、词集和词频；完整包在此基础上安装详细定义扩展。</p><small>词典数据固定版本；旧单库索引需重新安装。</small></div>
            <div className="button-row"><button className="primary-button" disabled={dictionaryStatus?.installing} onClick={() => installDictionary(false,'standard')}>安装标准包</button><button className="secondary-button" disabled={dictionaryStatus?.installing} onClick={() => installDictionary(false,'full')}>安装完整包</button><button className="secondary-button" disabled={dictionaryStatus?.installing} onClick={() => installDictionary(true,'standard')}>从本地CSV安装</button></div>
          </div>
        )}
        {installProgress && !['completed', 'cancelled', 'error'].includes(installProgress.stage) && (
          <div className="install-progress-box">
            <div><b>{installStageLabel(installProgress)}</b><span>{installProgress.totalBytes > 0 ? `${Math.round(installProgress.downloadedBytes / installProgress.totalBytes * 100)}%` : formatNumber(installProgress.indexedEntries)}</span></div>
            <progress value={installProgress.totalBytes > 0 ? installProgress.downloadedBytes : undefined} max={installProgress.totalBytes || undefined} />
            <button onClick={() => appClient.dictionary.cancelInstall()}>取消</button>
          </div>
        )}
        </section>
        {dictionaryStatus?.baseInstalled && <section className="dictionary-settings-section dictionary-online-section">
        <div className="dictionary-section-heading"><div><h3>在线词典</h3><p>启用后以百度中文义项和例句增强本地词条，同时保留 ECDICT 考试标签与词频。</p></div><span className={dictionaryCredentialStatus?.configured?'pill success':'pill'}>{dictionaryCredentialStatus?.configured?'已配置':'未配置'}</span></div>
        <div className="dictionary-source-switch" role="group" aria-label="详细释义来源"><button className={dictionaryPreferences.lookupProviderId==='ecdict'?'active':''} aria-pressed={dictionaryPreferences.lookupProviderId==='ecdict'} onClick={()=>saveDictionaryPreferences({...dictionaryPreferences,lookupProviderId:'ecdict'})}>仅使用本地</button><button className={dictionaryPreferences.lookupProviderId==='baidu'?'active':''} aria-pressed={dictionaryPreferences.lookupProviderId==='baidu'} onClick={()=>saveDictionaryPreferences({...dictionaryPreferences,lookupProviderId:'baidu'})}>百度增强</button></div>
        {dictionaryPreferences.lookupProviderId==='baidu' && <div className="online-dictionary-options">
          <ToggleSwitch checked={dictionaryPreferences.fallbackToLocal} onChange={fallbackToLocal=>saveDictionaryPreferences({...dictionaryPreferences,fallbackToLocal})} label="百度不可用时自动回退本地"/>
          <ToggleSwitch checked={dictionaryPreferences.translateExamples} onChange={translateExamples=>saveDictionaryPreferences({...dictionaryPreferences,translateExamples})} label="自动翻译学习例句" description="使用当前翻译服务生成中文例句译文。"/>
          {dictionaryCredentialStatus?.configured && <div className="credential-status-grid"><div><span>API Key</span><code>{dictionaryCredentialStatus.apiKey.masked}</code></div><div><span>Secret Key</span><code>{dictionaryCredentialStatus.secretKey.masked}</code></div></div>}
          <div className="credential-input-grid"><label>百度 API Key<input type="password" value={baiduApiKey} onChange={event=>setBaiduApiKey(event.target.value)} placeholder={dictionaryCredentialStatus?.apiKey.configured?'输入新密钥以替换':'输入 API Key'}/></label><label>百度 Secret Key<input type="password" value={baiduSecretKey} onChange={event=>setBaiduSecretKey(event.target.value)} placeholder={dictionaryCredentialStatus?.secretKey.configured?'输入新密钥以替换':'输入 Secret Key'}/></label></div>
          <div className="button-row dictionary-credential-actions"><button className="primary-button" disabled={!baiduApiKey.trim()||!baiduSecretKey.trim()} onClick={async()=>{const result=await appClient.dictionary.saveBaiduCredentials(baiduApiKey,baiduSecretKey);result.ok?onNotice(result.message):onError(result.message);if(result.ok){setBaiduApiKey('');setBaiduSecretKey('');await refreshDictionary()}}}>保存并测试</button><button className="secondary-button" disabled={!dictionaryCredentialStatus?.configured} onClick={async()=>{const result=await appClient.dictionary.testBaiduConnection();result.ok?onNotice(result.message):onError(result.message)}}>测试连接</button><button className="danger-button" disabled={!dictionaryCredentialStatus?.configured} onClick={async()=>{await appClient.dictionary.deleteBaiduCredentials();await refreshDictionary();onNotice('百度词典凭据已删除')}}>删除凭据</button></div>
        </div>}
        </section>}
      </div>}
      {section === 'speech' &&
      <div className="settings-card speech-settings-card">
        <div className="setting-heading">
          <div><h2>语音服务</h2><p>为单词与文章分别选择系统、Google 或 MiniMax；每个远程供应商拥有独立模型、音色和密钥。</p></div>
        </div>
        <div className="speech-provider-grid">
          <label>单词与词条发音
            <select value={speechDraft.wordProviderId} onChange={event => setSpeechDraft({ ...speechDraft, wordProviderId: event.target.value as SpeechPreferences['wordProviderId'] })}>
              {speechSettings?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
            <small>用于右侧词典、词典中心和每日学习；默认使用系统语音。</small>
          </label>
          <label>文章与段落朗读
            <select value={speechDraft.articleProviderId} onChange={event => setSpeechDraft({ ...speechDraft, articleProviderId: event.target.value as SpeechPreferences['articleProviderId'] })}>
              {speechSettings?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
            <small>用于阅读器段落和连续朗读；默认使用 Google 服务。</small>
          </label>
        </div>
        <div className={`speech-setting-grid ${speechDraft.wordProviderId!=='system'&&speechDraft.articleProviderId!=='system'?'single-setting':''}`}>
          <label>英语地区
            <select value={speechDraft.locale} onChange={event => changeSpeechLocale(event.target.value as SpeechPreferences['locale'])}>
              <option value="en-US">美式英语（en-US）</option>
              <option value="en-GB">英式英语（en-GB）</option>
            </select>
          </label>
          {(speechDraft.wordProviderId==='system'||speechDraft.articleProviderId==='system') && <label>系统声音
            <select value={speech.voices.some(voice => voice.id === speechDraft.voiceId) ? speechDraft.voiceId ?? '' : ''} onChange={event => setSpeechDraft({ ...speechDraft, voiceId: event.target.value || null })}>
              <option value="">系统默认英文</option>
              {speech.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.lang}{voice.local ? ' · 本地' : ''}</option>)}
            </select>
          </label>}
        </div>
        {speech.voicesLoaded && speech.voices.length === 0 && speech.systemSupported && <p className="speech-fallback-note">当前运行环境未返回可选声音列表，系统朗读仍会使用默认英文声音。</p>}
        <label className="speech-rate">朗读速度 <b>{speechDraft.rate.toFixed(1)}×</b><input type="range" min="0.5" max="2" step="0.1" value={speechDraft.rate} onChange={event => setSpeechDraft({ ...speechDraft, rate: Number(event.target.value) })}/></label>
        <ToggleSwitch checked={speechDraft.autoPlayStudy} onChange={autoPlayStudy=>setSpeechDraft({...speechDraft,autoPlayStudy})} label="每日学习卡出现时自动朗读一次"/>
        <div className="remote-speech-providers">{speechSettings?.providers.filter(provider=>provider.id!=='system'&&(provider.id===speechDraft.wordProviderId||provider.id===speechDraft.articleProviderId)).map(provider=>{const id=provider.id as RemoteSpeechProviderId,setting=speechDraft.providerSettings[id];const usage=[provider.id===speechDraft.wordProviderId?'单词发音':null,provider.id===speechDraft.articleProviderId?'文章朗读':null].filter(Boolean).join(' · ');return <div className="speech-cloud-credentials" key={id}>
          <div className="setting-heading"><div><h3>{provider.name}</h3><p>{provider.description}</p><small className="provider-usage">用于 {usage}</small></div><span className={provider.keyStatus.configured?'pill success':'pill'}>{provider.keyStatus.configured?'已配置':'未配置'}</span></div>
          <div className="speech-setting-grid"><label>模型<select value={setting.modelId} onChange={event=>setSpeechDraft({...speechDraft,providerSettings:{...speechDraft.providerSettings,[id]:{...setting,modelId:event.target.value}}})}>{provider.models.map(model=><option value={model.id} key={model.id}>{model.name}</option>)}</select><small>{provider.models.find(model=>model.id===setting.modelId)?.description}</small></label><label>英文音色<select value={setting.voiceId} onChange={event=>setSpeechDraft({...speechDraft,providerSettings:{...speechDraft.providerSettings,[id]:{...setting,voiceId:event.target.value}}})}>{provider.voices.filter(voice=>voice.locales.includes(speechDraft.locale)).map(voice=><option value={voice.id} key={voice.id}>{voice.name}</option>)}</select></label></div>
          {provider.keyStatus.configured&&<div className="saved-key"><code>{provider.keyStatus.masked}</code><button onClick={()=>removeSpeechProviderKey(id)}>删除</button></div>}
          <label>{provider.name} API Key<input type="password" value={speechKeys[id]??''} onChange={event=>setSpeechKeys(current=>({...current,[id]:event.target.value}))} placeholder={provider.keyStatus.configured?'输入新密钥以替换':'输入供应商 API Key'}/></label>
          <div className="button-row"><button className="primary-button" disabled={!(speechKeys[id]??'').trim()} onClick={()=>saveSpeechProviderKey(id)}>保存密钥</button><button className="secondary-button" disabled={!provider.keyStatus.configured||speechTesting!==null} onClick={()=>testSpeechConnection(id)}>{speechTesting===id?'连接中…':`测试 ${provider.name}`}</button></div>
        </div>})}</div>
        <div className="button-row speech-setting-actions">
          <button className="secondary-button speech-preview-button" disabled={speechDraft.wordProviderId === 'system' && !speech.systemSupported} onClick={() => speech.preview(speechDraft, 'Vocabulary.', 'word')}><SpeakerIcon/>试听单词</button>
          <button className="secondary-button speech-preview-button" disabled={speechDraft.articleProviderId === 'system' && !speech.systemSupported} onClick={() => speech.preview(speechDraft, 'The quick brown fox jumps over the lazy dog.', 'article')}><SpeakerIcon/>试听文章</button>
          <button className="primary-button" onClick={async()=>{try{const saved=await speech.savePreferences(speechDraft);setSpeechDraft(saved);setSpeechSettings(current=>current?{...current,preferences:saved}:current);onNotice('语音设置已保存')}catch(reason){onError(messageOf(reason))}}}>保存语音设置</button>
        </div>
      </div>}
      {section === 'study' && studyPreferences && <div className="settings-card study-preferences-card">
        <div className="setting-heading"><div><h2>每日学习</h2><p>常用设置只保留队列顺序；学习日和 FSRS 参数放在高级设置中。</p></div></div>
        <fieldset className="queue-order-picker"><legend>今日队列</legend>{([['mixed','混合','新词与复习稳定混排'],['review_first','复习优先','先处理到期卡'],['new_first','新词优先','先完成今日新词']] as const).map(([value,title,description])=><label key={value} className={studyPreferences.queueOrder===value?'selected':''}><input type="radio" name="queue-order" checked={studyPreferences.queueOrder===value} onChange={()=>setStudyPreferences({...studyPreferences,queueOrder:value})}/><b>{title}</b><small>{description}</small></label>)}</fieldset>
        <details className="study-advanced-settings">
          <summary><span>高级设置</span><small>下一批任务生效</small></summary>
          <p>通常不需要调整。修改后从下一批任务开始生效，不会重排当前队列。</p>
          <label className="setting-range">学习日切换时间 <b>{studyPreferences.cutoffHour}:00</b><input type="range" min="0" max="23" step="1" value={studyPreferences.cutoffHour} onChange={event => setStudyPreferences({ ...studyPreferences, cutoffHour: Number(event.target.value) })}/><small>早于该时间的学习会计入前一学习日。</small></label>
          <div className="compact-number-grid"><label>目标记忆率<input type="number" min="0.8" max="0.95" step="0.01" value={studyPreferences.requestRetention} onChange={event=>setStudyPreferences({...studyPreferences,requestRetention:Number(event.target.value)})}/><small>建议 0.85–0.92</small></label><label>最大间隔（天）<input type="number" min="30" max="36500" value={studyPreferences.maximumInterval} onChange={event=>setStudyPreferences({...studyPreferences,maximumInterval:Number(event.target.value)})}/><small>FSRS 复习上限</small></label></div>
        </details>
        <div className="settings-save-bar"><span>{studyDirty ? '有未保存的学习设置改动' : '学习设置已保存'}</span><div><button className="secondary-button" disabled={!studyDirty} onClick={resetStudyDraft}>撤销改动</button><button className="primary-button" disabled={!studyDirty} onClick={saveStudyPreferences}>保存学习设置</button></div></div>
      </div>}
      {section === 'developer' && developerVisible && <>
      <div className="settings-card developer-mode-card"><div className="setting-heading"><div><h2>开发与调试</h2><p>用于验证调度、收集脱敏日志和恢复应用；破坏性操作不会进入便携备份。</p></div><span className={developerState?.enabled?'pill success':'pill'}>{developerState?.enabled?'已启用':'已关闭'}</span></div><ToggleSwitch checked={developerState?.enabled??false} onChange={enabled=>void setDeveloperEnabled(enabled)} label="启用开发模式"/></div>
        {developerState?.enabled&&<>
          <div className="settings-card"><div className="setting-heading"><div><h2>学习调试</h2><p>模拟学习日切换，或保留计划、生词和语境并重置全部记忆曲线。</p></div></div><div className="debug-actions"><button onClick={async()=>{if(!confirm('强制结束当前学习日并结转未完成任务？'))return;try{await appClient.study.forceNextStudyDay('NEXT_STUDY_DAY');onNotice('已推进到下一测试学习日')}catch(reason){onError(messageOf(reason))}}}>模拟下一学习日</button><button className="danger-button" onClick={async()=>{if(!confirm('清空全部卡片、复习事件和每日会话？计划、生词和语境会保留。'))return;if(!confirm('再次确认：学习进度重置不可撤销。'))return;try{await appClient.study.resetAllProgress('RESET_ALL_STUDY_PROGRESS');setDeveloperState(await appClient.developer.getState());onNotice('全部学习进度已重置')}catch(reason){onError(messageOf(reason))}}}>重置全部学习进度</button></div></div>
      <div className="settings-card"><div className="setting-heading"><div><h2>日志模式</h2><p>仅记录脱敏后的运行事件，不记录密钥、文章文本、音频、请求正文或完整路径。</p></div><span className={developerState.loggingEnabled?'pill success':'pill'}>{developerState.loggingEnabled?'记录中':'已关闭'}</span></div><ToggleSwitch checked={developerState.loggingEnabled} onChange={async loggingEnabled=>{try{setDeveloperState(await appClient.developer.setLoggingEnabled(loggingEnabled))}catch(reason){onError(messageOf(reason))}}} label="启用本地诊断日志"/><p>{developerState.logFileCount} 个日志文件 · {formatBytes(developerState.logBytes)} · 最多保留 5 个文件</p><div className="button-row"><button className="secondary-button" onClick={()=>appClient.developer.openLogDirectory().catch(reason=>onError(messageOf(reason)))}>打开日志目录</button><button onClick={async()=>{try{setDeveloperState(await appClient.developer.clearLogs());onNotice('日志已清理')}catch(reason){onError(messageOf(reason))}}}>清理日志</button></div></div>
          <div className="settings-card factory-reset-card"><div className="setting-heading"><div><h2>恢复出厂设置</h2><p>删除用户目录中的书库、数据库、词典、设置、API 密钥、缓存、日志和内部恢复备份；不会卸载程序或删除外部便携备份。</p></div></div><button className="danger-button" onClick={factoryReset}>格式化并自动重启</button></div>
        </>}
      </>}
      {section === 'appearance' && <div className="settings-card appearance-settings-card">
        <div className="setting-heading"><div><h2>阅读版式</h2><p>这些设置会自动应用到所有文章。</p></div></div>
        <div className="reading-preview" style={{ '--preview-size': `${Math.max(15, preferences.fontSize - 2)}px`, '--preview-leading': preferences.lineHeight } as CSSProperties}>
          <p className="eyebrow">READING PREVIEW</p><h3>The shape of a changing world</h3><p>Clear typography keeps attention on the argument, not the interface.</p><small>清晰的排版让注意力停留在内容本身。</small>
        </div>
        <div className="range-grid">
          <label>正文字号 <b>{preferences.fontSize}px</b><input type="range" min="15" max="30" value={preferences.fontSize} onChange={(event) => onPreferences({ ...preferences, fontSize: Number(event.target.value) })} /></label>
          <label>行距 <b>{preferences.lineHeight.toFixed(1)}</b><input type="range" min="1.4" max="2.2" step="0.1" value={preferences.lineHeight} onChange={(event) => onPreferences({ ...preferences, lineHeight: Number(event.target.value) })} /></label>
          <label>栏宽 <b>{preferences.columnWidth}px</b><input type="range" min="560" max="980" step="20" value={preferences.columnWidth} onChange={(event) => onPreferences({ ...preferences, columnWidth: Number(event.target.value) })} /></label>
        </div>
        {preferences.theme === 'light' && <label className="setting-range paper-tone-control">浅色纸张暖度 <b>{preferences.paperTint ?? DEFAULT_PREFERENCES.paperTint}</b><input type="range" min="0" max="100" step="1" value={preferences.paperTint ?? DEFAULT_PREFERENCES.paperTint} onChange={(event) => onPreferences({ ...preferences, paperTint: Number(event.target.value) })}/><small>数值越高，阅读器与界面背景越接近温暖米白。</small></label>}
        <div className="theme-picker"><button className={preferences.theme === 'light' ? 'selected' : ''} onClick={() => onPreferences({ ...preferences, theme: 'light' })}><AppearanceIcon />浅色</button><button className={preferences.theme === 'dark' ? 'selected' : ''} onClick={() => onPreferences({ ...preferences, theme: 'dark' })}><AppearanceIcon />深色</button><button className="secondary-button" onClick={() => onPreferences(DEFAULT_PREFERENCES)}>恢复默认</button></div>
      </div>}
      </div>
      </div>
    </section>
  )
}

function Loading({ label }: { label: string }) {
  return <div className="loading"><span /><p>{label}</p></div>
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  return String(reason)
}

function sameStudyPreferences(a: StudyPreferences, b: StudyPreferences): boolean {
  return a.cutoffHour === b.cutoffHour
    && a.requestRetention === b.requestRetention
    && a.maximumInterval === b.maximumInterval
    && a.queueOrder === b.queueOrder
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatBytes(value: number): string {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleString('zh-CN', { hour12: false })
}

function installStageLabel(progress: DictionaryInstallProgress): string {
  const labels: Record<DictionaryInstallProgress['stage'], string> = {
    'downloading-dictionary': '正在下载词典数据',
    'downloading-lemma': '正在下载词形数据',
    'indexing-entries': '正在建立词条索引',
    'indexing-forms': '正在建立词形索引',
    finalizing: '正在完成本地词典',
    completed: '词典安装完成',
    cancelled: '安装已取消',
    error: progress.message || '安装失败',
  }
  return labels[progress.stage]
}
