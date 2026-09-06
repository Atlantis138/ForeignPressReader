import { ArticleReadingTools } from './ReadingTools'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import type {
  ArticleDetail,
  ContentBlock,
  DictionaryLookupRequest,
  DictionaryLookupResult,
  DictionaryPreferences,
  ReadingPositionSnapshot,
  ReaderPreferences,
  TranslationProgress,
} from '../../shared/types'
import { getAppClient } from '../app-client'
import { DictionaryDrawer, type DrawerPhase } from './DictionaryDrawer'
import {
  applyReaderSearchHighlights,
  clearReaderSearchHighlights,
  findArticleMatches,
  queryIncludesChinese,
} from './search'
import {
  scrollOnlyReadingPosition,
  useReadingAnchor,
} from './use-reading-anchor'
import { escapeInlineText, tokenizedInlineHtml } from './content-html'
import { useVocabularyActions } from './use-vocabulary-actions'
import { useSpeech } from '../speech/SpeechProvider'
import { SpeakerIcon } from '../speech/PronounceButton'
import {
  AppearanceIcon,
  ArrowLeftIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  SearchIcon,
  SettingsIcon,
  StopIcon,
} from '../ui/icons'

const appClient = getAppClient()
const DRAWER_DESKTOP_WIDTH = 390
const DRAWER_COMPACT_WIDTH = 340
const READER_SIDE_GUTTER = 96

export function ReaderView({
  id,
  publicationId,
  active = true,
  restoreScrollTop = null,
  preferences,
  onPreferences,
  onBack,
  onSettings,
  onError,
}: {
  id: string
  publicationId: string
  active?: boolean
  restoreScrollTop?: number | null
  preferences: ReaderPreferences
  onPreferences(value: ReaderPreferences): void
  onBack(): void
  onSettings(): void
  onError(message: string): void
}) {
  const [article, setArticle] = useState<ArticleDetail | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<TranslationProgress | null>(null)
  const [translating, setTranslating] = useState(false)
  const [dictionaryPreferences, setDictionaryPreferences] =
    useState<DictionaryPreferences>({
      enabled: true,
      lookupProviderId: 'ecdict',
      fallbackToLocal: true,
      contextExplanationEnabled: true,
      translateExamples: false,
    })
  const [lookupRequest, setLookupRequest] =
    useState<DictionaryLookupRequest | null>(null)
  const [lookupResult, setLookupResult] =
    useState<DictionaryLookupResult | null>(null)
  const [selectedLookupLexemeKey, setSelectedLookupLexemeKey] = useState<
    string | null
  >(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [contextLoading, setContextLoading] = useState(false)
  const [drawerPhase, setDrawerPhase] = useState<DrawerPhase | 'closed'>(
    'closed',
  )
  const [readerViewportWidth, setReaderViewportWidth] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchIndex, setActiveSearchIndex] = useState(0)
  const readerRef = useRef<HTMLElement | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingScrollRestore = useRef<ReadingPositionSnapshot | null>(null)
  const vocabulary = useVocabularyActions(lookupRequest, lookupResult, onError)
  const speech = useSpeech()
  const playSpeech = speech.play
  const speechSourceId = `reader:${id}`

  const drawerVisible = drawerPhase !== 'closed'
  const drawerWidth =
    window.innerWidth <= 1100 ? DRAWER_COMPACT_WIDTH : DRAWER_DESKTOP_WIDTH
  const effectiveViewportWidth =
    readerRef.current?.clientWidth ?? readerViewportWidth
  const reserveDrawer =
    drawerVisible &&
    effectiveViewportWidth >=
      preferences.columnWidth + drawerWidth + READER_SIDE_GUTTER * 2
  const searchMatches = useMemo(
    () => (article ? findArticleMatches(article.blocks, searchQuery) : []),
    [article, searchQuery],
  )
  const translationSearchBlocks = useMemo(
    () =>
      new Set(
        searchMatches
          .filter((match) => match.kind === 'translation')
          .map((match) => match.blockId),
      ),
    [searchMatches],
  )
  const translationSearchKey = [...translationSearchBlocks].join('|')
  const {
    captureAnchor,
    refreshAnchor,
    getReadingPosition,
    restoreReadingPosition,
  } = useReadingAnchor(articleRef, [
    article?.id,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.columnWidth,
    reserveDrawer,
    searchOpen,
    translationSearchKey,
  ])

  const closeDrawer = useCallback(() => {
    captureAnchor()
    setDrawerPhase((current) =>
      current === 'closed' || current === 'closing' ? current : 'closing',
    )
  }, [captureAnchor])

  const finishClosingDrawer = useCallback(() => {
    setDrawerPhase('closed')
    setLookupRequest(null)
    setLookupResult(null)
    setSelectedLookupLexemeKey(null)
    refreshAnchor()
  }, [refreshAnchor])

  const loadSequence = useRef(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadArticle = useCallback(
    async (restorePosition = false) => {
      const sequence = ++loadSequence.current
      setLoadError(null)
      let loaded: ArticleDetail
      try {
        loaded = await appClient.reader.getArticle(id)
      } catch (reason) {
        if (sequence === loadSequence.current) setLoadError(messageOf(reason))
        throw reason
      }
      if (sequence !== loadSequence.current) return
      if (restorePosition) {
        pendingScrollRestore.current =
          restoreScrollTop == null
            ? loaded.savedPosition
            : scrollOnlyReadingPosition(restoreScrollTop)
      }
      setArticle(loaded)
    },
    [id, restoreScrollTop],
  )

  useLayoutEffect(() => {
    if (!article || pendingScrollRestore.current == null) return
    const position = pendingScrollRestore.current
    pendingScrollRestore.current = null
    const frame = requestAnimationFrame(() => {
      restoreReadingPosition(position)
      requestAnimationFrame(() => restoreReadingPosition(position))
    })
    return () => cancelAnimationFrame(frame)
  }, [article, restoreReadingPosition])

  useEffect(() => {
    setArticle(null)
    setExpanded(new Set())
    setLookupRequest(null)
    setLookupResult(null)
    setDrawerPhase('closed')
    setSearchOpen(false)
    setSearchQuery('')
    clearReaderSearchHighlights()
    loadArticle(true).catch((reason) => onError(messageOf(reason)))
    const requests = loadSequence
    return () => {
      requests.current++
    }
  }, [loadArticle, onError])

  useEffect(() => {
    appClient.dictionary
      .getPreferences()
      .then(setDictionaryPreferences)
      .catch(() => undefined)
  }, [])

  useEffect(
    () =>
      appClient.translation.onProgress((next) => {
        if (next.articleId !== id) return
        setProgress(next)
        setTranslating(
          !['completed', 'cancelled', 'error'].includes(next.status),
        )
        if (['completed', 'cancelled', 'error'].includes(next.status)) {
          loadArticle().catch((reason) => onError(messageOf(reason)))
        }
      }),
    [id, loadArticle, onError],
  )

  useEffect(() => {
    const reader = readerRef.current
    if (!reader) return
    const observer = new ResizeObserver(([entry]) =>
      setReaderViewportWidth(entry.contentRect.width),
    )
    observer.observe(reader)
    setReaderViewportWidth(reader.clientWidth)
    return () => observer.disconnect()
  }, [article])

  useLayoutEffect(() => {
    const container = articleRef.current?.closest<HTMLElement>('.main-content')
    if (!container || !article) return
    const persist = () => {
      appClient.reader
        .savePosition(publicationId, id, getReadingPosition())
        .catch(() => undefined)
    }
    const save = () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null
        persist()
      }, 400)
    }
    container.addEventListener('scroll', save, { passive: true })
    return () => {
      container.removeEventListener('scroll', save)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = null
      persist()
    }
  }, [article, getReadingPosition, id, publicationId])

  useEffect(() => {
    if (drawerPhase !== 'opening') return
    const frame = requestAnimationFrame(() => setDrawerPhase('open'))
    return () => cancelAnimationFrame(frame)
  }, [drawerPhase])

  useEffect(() => {
    if (drawerPhase !== 'closing') return
    const fallback = window.setTimeout(() => finishClosingDrawer(), 280)
    return () => window.clearTimeout(fallback)
  }, [drawerPhase, finishClosingDrawer])

  useLayoutEffect(() => {
    if (
      !searchOpen ||
      !searchQuery.trim() ||
      searchMatches.length === 0 ||
      !articleRef.current
    ) {
      clearReaderSearchHighlights()
      return
    }
    const frame = requestAnimationFrame(() => {
      if (!articleRef.current) return
      const target = applyReaderSearchHighlights(
        articleRef.current,
        searchMatches,
        activeSearchIndex,
      )
      target?.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [
    activeSearchIndex,
    searchMatches,
    searchOpen,
    searchQuery,
    translationSearchKey,
  ])

  useEffect(() => () => clearReaderSearchHighlights(), [])

  const navigateSearch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatches.length === 0) return
      setActiveSearchIndex(
        (current) =>
          (current + direction + searchMatches.length) % searchMatches.length,
      )
    },
    [searchMatches.length],
  )

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  const closeSearch = useCallback(() => {
    captureAnchor()
    setSearchOpen(false)
    setSearchQuery('')
    setActiveSearchIndex(0)
    clearReaderSearchHighlights()
  }, [captureAnchor])

  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearch()
      } else if (event.key === 'F3') {
        event.preventDefault()
        navigateSearch(event.shiftKey ? -1 : 1)
      } else if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        closeSearch()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active, closeSearch, navigateSearch, openSearch, searchOpen])

  const translatedIds = useMemo(
    () =>
      article?.blocks
        .filter((block) => block.translation)
        .map((block) => block.id) ?? [],
    [article],
  )
  const allExpanded =
    translatedIds.length > 0 &&
    translatedIds.every((blockId) => expanded.has(blockId))
  const readableBlocks = useMemo(
    () =>
      article?.blocks.filter(
        (block) => block.type !== 'image' && Boolean(block.text?.trim()),
      ) ?? [],
    [article],
  )
  const readerSpeechActive =
    speech.state.sourceId === speechSourceId &&
    ['playing', 'paused'].includes(speech.state.status)
  const activeSpeechBlockId = readerSpeechActive ? speech.state.itemId : null

  useEffect(
    () => () => {
      if (appClient.speech.getState().sourceId === speechSourceId)
        appClient.speech.stop()
    },
    [speechSourceId],
  )

  useEffect(() => {
    if (!activeSpeechBlockId) return
    const target = articleRef.current?.querySelector<HTMLElement>(
      `[data-reader-block-id="${CSS.escape(activeSpeechBlockId)}"]`,
    )
    if (!target) return
    const rect = target.getBoundingClientRect()
    const toolbarBottom =
      readerRef.current
        ?.querySelector<HTMLElement>('.reader-toolbar')
        ?.getBoundingClientRect().bottom ?? 0
    if (rect.top >= toolbarBottom + 8 && rect.bottom <= window.innerHeight - 24)
      return
    target.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }, [activeSpeechBlockId])

  const readArticle = () => {
    if (!readableBlocks.length) return
    const toolbarBottom =
      readerRef.current
        ?.querySelector<HTMLElement>('.reader-toolbar')
        ?.getBoundingClientRect().bottom ?? 0
    const firstVisible = readableBlocks.findIndex((block) => {
      const element = articleRef.current?.querySelector<HTMLElement>(
        `[data-reader-block-id="${CSS.escape(block.id)}"]`,
      )
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return rect.bottom > toolbarBottom + 8 && rect.top < window.innerHeight
    })
    speech.play(
      speechSourceId,
      readableBlocks.map((block) => ({
        id: block.id,
        text: block.text ?? '',
        label: block.type,
      })),
      Math.max(0, firstVisible),
      'article',
    )
  }

  const readBlock = useCallback(
    (block: ContentBlock) => {
      if (!block.text?.trim()) return
      playSpeech(
        speechSourceId,
        [{ id: block.id, text: block.text, label: block.type }],
        0,
        'article',
      )
    },
    [playSpeech, speechSourceId],
  )

  const translate = async (force = false) => {
    setTranslating(true)
    setProgress(null)
    try {
      await appClient.translation.translateArticle(id, force)
      await loadArticle()
    } catch (reason) {
      onError(messageOf(reason))
      await loadArticle()
    } finally {
      setTranslating(false)
    }
  }

  const changePreferences = (next: ReaderPreferences) => {
    captureAnchor()
    onPreferences(next)
  }

  const lookupWord = useCallback(
    async (block: ContentBlock, surface: string, tokenIndex: number) => {
      captureAnchor()
      const request = { articleId: id, blockId: block.id, surface, tokenIndex }
      setLookupRequest(request)
      setSelectedLookupLexemeKey(null)
      setLookupResult(null)
      setLookupLoading(true)
      setDrawerPhase((current) =>
        current === 'closed' || current === 'closing' ? 'opening' : current,
      )
      try {
        setLookupResult(await appClient.dictionary.lookup(request))
      } catch (reason) {
        onError(messageOf(reason))
        closeDrawer()
      } finally {
        setLookupLoading(false)
      }
    },
    [captureAnchor, closeDrawer, id, onError],
  )

  const explainContext = async () => {
    if (!lookupRequest) return
    setContextLoading(true)
    try {
      const explanation = await appClient.dictionary.explainContext(
        lookupRequest,
        selectedLookupLexemeKey ?? undefined,
      )
      setLookupResult((current) =>
        current ? { ...current, contextDefinition: explanation } : current,
      )
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setContextLoading(false)
    }
  }

  const selectLookupCandidate = async (lexemeKey: string) => {
    if (!lookupRequest) return
    setLookupLoading(true)
    try {
      setLookupResult(
        await appClient.dictionary.lookupInContext(lookupRequest, lexemeKey),
      )
      setSelectedLookupLexemeKey(lexemeKey)
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setLookupLoading(false)
    }
  }

  const toggleTranslation = useCallback((blockId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(blockId)) next.delete(blockId)
      else next.add(blockId)
      return next
    })
  }, [])

  if (!article)
    return loadError ? (
      <div role="alert">
        <p>{loadError}</p>
        <button
          onClick={() =>
            void loadArticle(true).catch((reason) => onError(messageOf(reason)))
          }
        >
          重试
        </button>
      </div>
    ) : (
      <ReaderLoading label="正在打开文章…" />
    )
  return (
    <section
      ref={readerRef}
      className={`reader-view ${drawerVisible ? 'dictionary-visible' : ''} ${reserveDrawer ? 'dictionary-reserved' : 'dictionary-overlay'}`}
      style={
        {
          '--reader-font-size': `${preferences.fontSize}px`,
          '--reader-line-height': preferences.lineHeight,
          '--reader-width': `${preferences.columnWidth}px`,
          '--dictionary-width': `${drawerWidth}px`,
        } as CSSProperties
      }
    >
      <div className="reader-toolbar">
        <button className="back-button button-with-icon" onClick={onBack}>
          <ArrowLeftIcon />
          目录
        </button>
        <div className="reader-tools">
          <button
            className="icon-button"
            aria-label="搜索当前文章"
            title="搜索当前文章"
            onClick={openSearch}
          >
            <SearchIcon />
          </button>
          <button
            className={`reader-read-button ${readerSpeechActive ? 'active' : ''}`}
            disabled={!speech.canPlay('article') || !readableBlocks.length}
            title="从当前可见段落开始朗读"
            onClick={readArticle}
          >
            <SpeakerIcon />
            <span>朗读</span>
          </button>
          <button
            title="减小字号"
            onClick={() =>
              changePreferences({
                ...preferences,
                fontSize: preferences.fontSize - 1,
              })
            }
          >
            A−
          </button>
          <button
            title="增大字号"
            onClick={() =>
              changePreferences({
                ...preferences,
                fontSize: preferences.fontSize + 1,
              })
            }
          >
            A＋
          </button>
          <button
            className="icon-button"
            aria-label="切换主题"
            title="切换主题"
            onClick={() =>
              changePreferences({
                ...preferences,
                theme: preferences.theme === 'light' ? 'dark' : 'light',
              })
            }
          >
            <AppearanceIcon />
          </button>
          {translatedIds.length > 0 && (
            <button
              onClick={() =>
                setExpanded(allExpanded ? new Set() : new Set(translatedIds))
              }
            >
              {allExpanded ? '隐藏全部译文' : '显示全部译文'}
            </button>
          )}
          {translating ? (
            <button
              className="translation-button active"
              onClick={() => appClient.translation.cancel(id)}
            >
              停止翻译
            </button>
          ) : (
            <button
              className="translation-button"
              onClick={() => void translate(translatedIds.length > 0)}
            >
              {translatedIds.length ? '重新翻译全文' : '译为中文'}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="设置"
            title="设置"
            onClick={onSettings}
          >
            <SettingsIcon />
          </button>
        </div>
      </div>
      {translating && progress && (
        <div className="translation-progress">
          <span
            style={{
              width: `${Math.round((progress.completed / Math.max(progress.total, 1)) * 100)}%`,
            }}
          />
          <small>
            正在翻译 {progress.completed}/{progress.total}
          </small>
        </div>
      )}
      {searchOpen && (
        <div
          className="reader-search-panel"
          role="search"
          style={
            {
              '--search-drawer-offset': drawerVisible
                ? `${drawerWidth}px`
                : '0px',
            } as CSSProperties
          }
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value)
              setActiveSearchIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                navigateSearch(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              }
            }}
            placeholder="搜索当前文章"
            aria-label="搜索当前文章"
          />
          <span
            className={
              searchQuery.trim() && searchMatches.length === 0
                ? 'no-results'
                : ''
            }
          >
            {!searchQuery.trim()
              ? '输入关键词'
              : searchMatches.length
                ? `${activeSearchIndex + 1}/${searchMatches.length}`
                : '无结果'}
          </span>
          <button
            title="上一项"
            disabled={!searchMatches.length}
            onClick={() => navigateSearch(-1)}
          >
            ↑
          </button>
          <button
            title="下一项"
            disabled={!searchMatches.length}
            onClick={() => navigateSearch(1)}
          >
            ↓
          </button>
          <button title="关闭搜索" onClick={closeSearch}>
            ×
          </button>
          {queryIncludesChinese(searchQuery) && <small>同时搜索已有译文</small>}
        </div>
      )}
      <div className="reader-content-stage">
        <ArticleReadingTools article={article} reader={appClient.reader} onArticle={setArticle} />
        <article
          ref={articleRef}
          className="reader-article"
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest('.lookup-word'))
              closeDrawer()
          }}
        >
          {article.sectionTitle && (
            <p className="article-section">{article.sectionTitle}</p>
          )}
          {article.publishedAt && (
            <p className="article-date">{article.publishedAt}</p>
          )}
          {article.blocks.map((block) => (
            <ReaderBlock
              key={block.id}
              block={block}
              expanded={
                expanded.has(block.id) ||
                (searchOpen && translationSearchBlocks.has(block.id))
              }
              activeToken={
                lookupRequest?.blockId === block.id
                  ? lookupRequest.tokenIndex
                  : null
              }
              speaking={activeSpeechBlockId === block.id}
              lookupEnabled={dictionaryPreferences.enabled}
              onLookup={lookupWord}
              onSpeak={readBlock}
              onToggle={toggleTranslation}
            />
          ))}
          <footer className="article-end">
            <span>◆</span>
            <p>End of article</p>
          </footer>
        </article>
      </div>
      {drawerVisible && lookupRequest && (
        <DictionaryDrawer
          phase={drawerPhase as DrawerPhase}
          loading={lookupLoading}
          contextLoading={contextLoading}
          result={lookupResult}
          contextEnabled={dictionaryPreferences.contextExplanationEnabled}
          vocabularyState={vocabulary.state}
          vocabularyBusy={vocabulary.busy}
          vocabularyAvailable={vocabulary.available}
          onExplain={explainContext}
          onToggleFavorite={vocabulary.toggleFavorite}
          onToggleContext={vocabulary.toggleContext}
          onClose={closeDrawer}
          onClosed={finishClosingDrawer}
          onSettings={onSettings}
          onSelectCandidate={selectLookupCandidate}
        />
      )}
      {readerSpeechActive && (
        <div
          className="reader-speech-player"
          role="group"
          aria-label="文章朗读控制"
        >
          <div className="speech-player-controls">
            <button
              disabled={speech.state.index <= 0}
              onClick={speech.previous}
              aria-label="上一段"
              title="上一段"
            >
              <PreviousIcon />
            </button>
            <button
              className="speech-play-toggle"
              onClick={
                speech.state.status === 'paused' ? speech.resume : speech.pause
              }
              aria-label={
                speech.state.status === 'paused' ? '继续朗读' : '暂停朗读'
              }
            >
              {speech.state.status === 'paused' ? <PlayIcon /> : <PauseIcon />}
            </button>
            <button
              disabled={speech.state.index >= speech.state.total - 1}
              onClick={speech.next}
              aria-label="下一段"
              title="下一段"
            >
              <NextIcon />
            </button>
          </div>
          <div className="speech-player-status">
            <small>{speech.state.total === 1 ? '单段朗读' : '文章朗读'}</small>
            <span>
              <b>{speech.state.index + 1}</b>
              <i>/</i>
              {speech.state.total}
            </span>
          </div>
          <button
            className="speech-stop"
            onClick={speech.stop}
            aria-label="停止朗读"
            title="停止朗读"
          >
            <StopIcon />
          </button>
        </div>
      )}
    </section>
  )
}

const ReaderBlock = memo(function ReaderBlock({
  block,
  expanded,
  activeToken,
  speaking,
  lookupEnabled,
  onLookup,
  onSpeak,
  onToggle,
}: {
  block: ContentBlock
  expanded: boolean
  activeToken: number | null
  speaking: boolean
  lookupEnabled: boolean
  onLookup(block: ContentBlock, surface: string, tokenIndex: number): void
  onSpeak(block: ContentBlock): void
  onToggle(blockId: string): void
}) {
  const blockRef = useRef<HTMLDivElement | null>(null)
  const renderedHtml = useMemo(() => {
    const source = block.html || escapeInlineText(block.text ?? '')
    return lookupEnabled ? tokenizedInlineHtml(source) : source
  }, [block.html, block.text, lookupEnabled])
  useLayoutEffect(() => {
    const root = blockRef.current
    root?.querySelector('.lookup-word.active')?.classList.remove('active')
    if (activeToken == null) return
    root
      ?.querySelector<HTMLElement>(
        `.lookup-word[data-token-index="${activeToken}"]`,
      )
      ?.classList.add('active')
  }, [activeToken, renderedHtml])
  if (block.type === 'image') {
    return block.assetUrl ? (
      <figure className="article-image" data-reader-block-id={block.id}>
        <img
          src={block.assetUrl}
          alt={block.alt ?? ''}
          loading="lazy"
          decoding="async"
        />
      </figure>
    ) : null
  }
  const Tag =
    block.type === 'title'
      ? 'h1'
      : block.type === 'heading'
        ? 'h2'
        : block.type === 'rubric'
          ? 'h3'
          : 'p'
  return (
    <div
      ref={blockRef}
      className={`text-block block-${block.type} ${block.translation ? 'has-translation' : ''} ${speaking ? 'speech-active' : ''}`}
      data-reader-block-id={block.id}
    >
      <button
        className="block-speech-button"
        onClick={() => onSpeak(block)}
        aria-label="朗读本段"
        title="朗读本段"
      >
        <SpeakerIcon />
      </button>
      <Tag
        data-source-block-id={block.id}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
        onClick={(event) => {
          const target = (event.target as HTMLElement).closest<HTMLElement>(
            '.lookup-word',
          )
          if (!target) return
          event.stopPropagation()
          const tokenIndex = Number(target.dataset.tokenIndex)
          const surface = target.dataset.surface
          if (surface && Number.isInteger(tokenIndex))
            onLookup(block, surface, tokenIndex)
        }}
      />
      {block.translation && (
        <>
          <button
            className="translation-toggle"
            onClick={() => onToggle(block.id)}
          >
            {expanded ? '收起译文' : '显示译文'}
          </button>
          {expanded && (
            <div
              className="translation-text"
              data-translation-block-id={block.id}
            >
              {block.translation}
            </div>
          )}
        </>
      )}
    </div>
  )
})

function ReaderLoading({ label }: { label: string }) {
  return (
    <div className="loading">
      <span />
      <p>{label}</p>
    </div>
  )
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error)
    return reason.message.replace(
      /^Error invoking remote method '[^']+': Error: /,
      '',
    )
  return String(reason)
}
