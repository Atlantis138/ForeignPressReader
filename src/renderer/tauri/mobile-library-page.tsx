import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArticleSearch } from '../reader/ReadingTools'
import type {
  LibraryPreferences,
  LibraryState,
  PublicationSummary,
} from '../../shared/types'
import {
  EditIcon,
  FolderIcon,
  GridIcon,
  ListIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SortIcon,
  TrashIcon,
} from '../ui/icons'
import type { MobileAppClient } from './mobile-app-client'
import {
  EMPTY_LIBRARY_SELECTION,
  enterLibrarySelection,
  exitLibrarySelection,
  libraryCategoryCount,
  pruneLibrarySelection,
  selectAllLibraryPublications,
  toggleLibrarySelection,
  visibleLibraryPublications,
  type LibrarySelectionState,
} from './mobile-library-model'
import {
  BottomSheet,
  BookCover,
  ConfirmDialog,
  EmptyState,
  IconButton,
  MobileButton,
  PageHeader,
  SelectionBar,
  SegmentedControl,
} from './mobile-ui'

const LIBRARY_INITIAL_CARD_COUNT = 6

export { EMPTY_LIBRARY_SELECTION, exitLibrarySelection }
export type { LibrarySelectionState }

export function MobileLibrary({
  client,
  state,
  selection,
  onSelection,
  onState,
  onRefresh,
  onImport,
  onOpen,
  onOpenArticle,
  onError,
  onNotice,
  overlayCloseSignal,
  onOverlayOpenChange,
  deferOffscreenCards,
}: {
  client: Pick<MobileAppClient, 'library' | 'reader'>
  state: LibraryState
  selection: LibrarySelectionState
  onSelection(value: LibrarySelectionState): void
  onState(value: LibraryState): void
  onRefresh(): void
  onImport(): void
  onOpen(publicationId: string): void
  onOpenArticle(publicationId: string, articleId: string): void
  onError(message: string): void
  onNotice(message: string): void
  overlayCloseSignal: number
  onOverlayOpenChange(open: boolean): void
  deferOffscreenCards: boolean
}) {
  const selected = useMemo(() => new Set(selection.selectedIds), [selection.selectedIds])
  const [searchOpen, setSearchOpen] = useState(false)
  const [actionTarget, setActionTarget] = useState<PublicationSummary | null>(null)
  const [renameTarget, setRenameTarget] = useState<PublicationSummary | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [assignIds, setAssignIds] = useState<string[] | null>(null)
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [newCategory, setNewCategory] = useState('')
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({})
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const visible = useMemo(() => visibleLibraryPublications(state), [state])
  const [renderLimit, setRenderLimit] = useState(() => deferOffscreenCards ? LIBRARY_INITIAL_CARD_COUNT : Number.POSITIVE_INFINITY)
  const overlayOpen = Boolean(actionTarget || renameTarget || assignIds || deleteIds || sortOpen || categoriesOpen || deleteCategoryId)

  const closeOverlays = useCallback(() => {
    setActionTarget(null)
    setRenameTarget(null)
    setAssignIds(null)
    setDeleteIds(null)
    setSortOpen(false)
    setCategoriesOpen(false)
    setDeleteCategoryId(null)
  }, [])

  useEffect(() => onOverlayOpenChange(overlayOpen), [onOverlayOpenChange, overlayOpen])
  useEffect(() => { if (overlayCloseSignal > 0) closeOverlays() }, [closeOverlays, overlayCloseSignal])
  useEffect(() => {
    if (!deferOffscreenCards || visible.length <= LIBRARY_INITIAL_CARD_COUNT) {
      setRenderLimit(Number.POSITIVE_INFINITY)
      return
    }
    setRenderLimit(LIBRARY_INITIAL_CARD_COUNT)
    const timer = window.setTimeout(() => setRenderLimit(Number.POSITIVE_INFINITY), 80)
    return () => window.clearTimeout(timer)
  }, [deferOffscreenCards, visible])
  useEffect(() => {
    const next = pruneLibrarySelection(selection, state.publications.map((item) => item.id))
    if (next !== selection) onSelection(next)
  }, [onSelection, selection, state.publications])

  const commit = async (notice: string, operation: () => Promise<LibraryState>) => {
    if (working) return
    setWorking(true)
    try {
      onState(await operation())
      onNotice(notice)
    } catch (reason) {
      onError(messageOf(reason))
      onRefresh()
    } finally {
      setWorking(false)
    }
  }

  const savePreferences = (patch: Partial<LibraryPreferences>) => {
    const next = { ...state.preferences, ...patch }
    onState({ ...state, preferences: next })
    void commit('书库视图已保存。', () => client.library.savePreferences(next))
  }

  const beginRename = (item: PublicationSummary) => {
    setActionTarget(null)
    setRenameTarget(item)
    setRenameValue(item.title)
  }

  const beginAssign = (ids: string[]) => {
    setActionTarget(null)
    setAssignIds(ids)
  }

  const toggleSelected = (id: string) => onSelection(toggleLibrarySelection(selection, id))

  const openCategories = () => {
    setCategoryDrafts(Object.fromEntries(state.categories.map((category) => [category.id, category.name])))
    setCategoriesOpen(true)
  }

  return <div className="mobile-page library-page">
    <PageHeader eyebrow="LIBRARY" title="我的书库" description="分类、整理并阅读你的英文刊物。" action={<MobileButton variant="primary" onClick={onImport}><PlusIcon /> 导入刊物</MobileButton>} />
    {state.publications.length === 0 ? (
      <EmptyState symbol="外" title="从一本外刊开始" description="选择无 DRM EPUB；原文件只用于一次性导入，不会保存在应用内。" action={<MobileButton variant="primary" onClick={onImport}>导入第一本刊物</MobileButton>} />
    ) : <>
      {selection.mode && <SelectionBar count={selected.size} cancelLabel="退出选择" onCancel={() => onSelection(exitLibrarySelection())} actions={<>
        <IconButton label={selected.size === visible.length ? '取消全选' : '全选当前分类'} onClick={() => onSelection(selectAllLibraryPublications(selection, visible.map((item) => item.id)))}><GridIcon /></IconButton>
        <IconButton label="归类所选刊物" disabled={!selected.size} onClick={() => beginAssign([...selected])}><FolderIcon /></IconButton>
        <IconButton label="删除所选刊物" disabled={!selected.size} onClick={() => setDeleteIds([...selected])}><TrashIcon /></IconButton>
      </>} />}
      <section className={`library-command-bar ${selection.mode ? 'selection-active' : ''}`} aria-label="书库管理工具">
        {!selection.mode && <MobileButton onClick={() => onSelection(enterLibrarySelection())}>选择</MobileButton>}
        <div className="library-command-actions">
          <IconButton label="查找文章与阅读记录" aria-expanded={searchOpen} aria-controls="library-article-search" onClick={() => setSearchOpen((current) => !current)}><SearchIcon /></IconButton>
          <MobileButton onClick={openCategories}><FolderIcon /> 分类</MobileButton>
          <IconButton label="排序" onClick={() => setSortOpen(true)}><SortIcon /></IconButton>
          <IconButton label={state.preferences.viewMode === 'grid' ? '切换到列表' : '切换到网格'} onClick={() => savePreferences({ viewMode: state.preferences.viewMode === 'grid' ? 'list' : 'grid' })}>
            {state.preferences.viewMode === 'grid' ? <ListIcon /> : <GridIcon />}
          </IconButton>
        </div>
      </section>
      <ArticleSearch reader={client.reader} open={searchOpen} onClose={() => setSearchOpen(false)} onOpen={onOpenArticle} />
      <nav className="library-category-strip" aria-label="书库分类">
        {[{ id: 'all', name: '全部' }, { id: 'uncategorized', name: '未分类' }, ...state.categories].map((category) => <button
          key={category.id}
          className={state.preferences.activeCategoryId === category.id ? 'active' : ''}
          aria-pressed={state.preferences.activeCategoryId === category.id}
          onClick={() => savePreferences({ activeCategoryId: category.id })}
        ><span>{category.name}</span><small>{libraryCategoryCount(state, category.id)}</small></button>)}
      </nav>
      <div className="library-result-heading"><b>{visible.length} 本刊物</b><span>{state.preferences.sortBy === 'name' ? '按名称' : '按导入时间'} · {state.preferences.sortDirection === 'asc' ? '升序' : '降序'}</span></div>
      {visible.length === 0 ? <EmptyState symbol="册" title="这个分类还是空的" description="可切换到其他分类，或选择刊物后将它移动到这里。" action={<MobileButton onClick={() => savePreferences({ activeCategoryId: 'all' })}>查看全部刊物</MobileButton>} /> : (
        <section className={`mobile-library-grid ${state.preferences.viewMode} ${selection.mode ? 'selection-mode' : ''}`} aria-label="刊物列表">
          {visible.slice(0, renderLimit).map((item) => {
            const categoryName = item.categoryId ? state.categories.find((category) => category.id === item.categoryId)?.name ?? '未分类' : '未分类'
            return <article className={`mobile-book ${selected.has(item.id) ? 'selected' : ''}`} key={item.id}>
              <button className="mobile-book-open" aria-label={selection.mode ? `${selected.has(item.id) ? '取消选择' : '选择'} ${item.title}` : `打开 ${item.title}`} aria-pressed={selection.mode ? selected.has(item.id) : undefined} onClick={() => selection.mode ? toggleSelected(item.id) : onOpen(item.id)} onContextMenu={(event) => { event.preventDefault(); onSelection(selection.mode ? toggleLibrarySelection(selection, item.id) : enterLibrarySelection(item.id)) }}>
                <BookCover title={item.title} imageUrl={item.coverThumbnailUrl ?? item.coverUrl} width={item.coverThumbnailWidth} height={item.coverThumbnailHeight} />
                <span className="mobile-book-copy"><strong>{item.title}</strong>{item.title !== item.originalTitle && <em>{item.originalTitle}</em>}<small>{item.articleCount} 篇文章 · {item.sectionCount} 个栏目</small><small>{categoryName} · {formatLibraryDate(item.importedAt)} 导入</small></span>
              </button>
              {!selection.mode && <IconButton label={`${item.title} 的更多操作`} className="mobile-book-more" onClick={() => setActionTarget(item)}><MoreIcon /></IconButton>}
            </article>
          })}
        </section>
      )}
    </>}

    {actionTarget && <BottomSheet title={actionTarget.title} onClose={() => setActionTarget(null)}><div className="library-action-sheet">
      <MobileButton onClick={() => { onSelection(enterLibrarySelection(actionTarget.id)); setActionTarget(null) }}><GridIcon /> 选择刊物</MobileButton>
      <MobileButton onClick={() => beginRename(actionTarget)}><EditIcon /> 重命名</MobileButton>
      <MobileButton onClick={() => beginAssign([actionTarget.id])}><FolderIcon /> 移动到分类</MobileButton>
      <MobileButton variant="danger" onClick={() => { setDeleteIds([actionTarget.id]); setActionTarget(null) }}><TrashIcon /> 从本机删除</MobileButton>
    </div></BottomSheet>}

    {renameTarget && <BottomSheet title="重命名刊物" onClose={() => setRenameTarget(null)}><form className="library-editor" onSubmit={(event) => {
      event.preventDefault()
      void commit('刊物名称已更新。', () => client.library.renamePublication(renameTarget.id, renameValue)).then(() => setRenameTarget(null))
    }}><label>显示名称<input autoFocus value={renameValue} maxLength={200} onChange={(event) => setRenameValue(event.target.value)} /></label><small>EPUB 内的原始书名不会被改写。</small><MobileButton type="submit" variant="primary" disabled={working || !renameValue.trim()}>保存名称</MobileButton></form></BottomSheet>}

    {assignIds && <BottomSheet title={`归类 ${assignIds.length} 本刊物`} onClose={() => setAssignIds(null)}><div className="library-category-options">
      <button onClick={() => void commit('已移到“未分类”。', () => client.library.assignPublications(assignIds, null)).then(() => { setAssignIds(null); onSelection({ ...selection, selectedIds: [] }) })}><FolderIcon /><span><b>未分类</b><small>移除当前分类</small></span></button>
      {state.categories.map((category) => <button key={category.id} onClick={() => void commit(`已移到“${category.name}”。`, () => client.library.assignPublications(assignIds, category.id)).then(() => { setAssignIds(null); onSelection({ ...selection, selectedIds: [] }) })}><FolderIcon /><span><b>{category.name}</b><small>{libraryCategoryCount(state, category.id)} 本刊物</small></span></button>)}
      {!state.categories.length && <p>还没有分类，可先在书库主页创建。</p>}
    </div></BottomSheet>}

    {sortOpen && <BottomSheet title="排序方式" onClose={() => setSortOpen(false)}><div className="library-sort-options">
      <SegmentedControl value={state.preferences.sortBy} label="排序字段" items={[{ value: 'importedAt', label: '导入时间' }, { value: 'name', label: '名称' }]} onChange={(sortBy) => savePreferences({ sortBy })} />
      <SegmentedControl value={state.preferences.sortDirection} label="排序方向" items={[{ value: 'desc', label: '降序' }, { value: 'asc', label: '升序' }]} onChange={(sortDirection) => savePreferences({ sortDirection })} />
    </div></BottomSheet>}

    {categoriesOpen && <BottomSheet title="管理分类" onClose={() => setCategoriesOpen(false)}><div className="library-category-manager">
      <form onSubmit={(event) => { event.preventDefault(); if (!newCategory.trim()) return; void commit('分类已创建。', () => client.library.createCategory(newCategory)).then(() => setNewCategory('')) }}><input value={newCategory} maxLength={100} placeholder="新分类名称" onChange={(event) => setNewCategory(event.target.value)} /><MobileButton type="submit" variant="primary" disabled={working || !newCategory.trim()}><PlusIcon /> 新建</MobileButton></form>
      {state.categories.map((category) => <div key={category.id}><input aria-label={`${category.name} 分类名称`} value={categoryDrafts[category.id] ?? category.name} maxLength={100} onChange={(event) => setCategoryDrafts((current) => ({ ...current, [category.id]: event.target.value }))} /><IconButton label={`保存 ${category.name}`} disabled={working} onClick={() => void commit('分类名称已更新。', () => client.library.renameCategory(category.id, categoryDrafts[category.id] ?? category.name))}><EditIcon /></IconButton><IconButton label={`删除 ${category.name}`} disabled={working} onClick={() => setDeleteCategoryId(category.id)}><TrashIcon /></IconButton></div>)}
      {!state.categories.length && <p>分类是扁平的，与 Windows 端一致；一本刊物只能属于一个分类。</p>}
    </div></BottomSheet>}

    {deleteCategoryId && <ConfirmDialog title="删除这个分类？" description="分类本身会删除，其中的刊物会回到“未分类”，本地 EPUB 与阅读记录不会受影响。" confirmLabel="删除分类" onCancel={() => setDeleteCategoryId(null)} onConfirm={() => void commit('分类已删除，刊物已回到未分类。', () => client.library.deleteCategory(deleteCategoryId)).then(() => setDeleteCategoryId(null))} />}
    {deleteIds && <ConfirmDialog title={`从本机删除 ${deleteIds.length} 本刊物？`} description="刊物正文、图片和阅读位置会从本机移除；已保存的生词与语境快照仍会保留。此操作不能撤销。" confirmLabel="确认删除" onCancel={() => setDeleteIds(null)} onConfirm={() => void commit('刊物已从本机书库删除。', () => client.library.deletePublications(deleteIds)).then(() => { setDeleteIds(null); onSelection({ ...selection, selectedIds: [] }) })} />}
  </div>
}

function messageOf(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message)
  return '操作失败，请重试。'
}

function formatLibraryDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}
