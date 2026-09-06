import { ArticleReadingTools } from '../reader/ReadingTools'
import { ErrorState } from './mobile-ui'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type {
  ArticleDetail,
  ContentBlock,
  DictionaryLookupRequest,
  DictionaryLookupResult,
  LexemeDetail,
  PublicationDetail,
  ReaderPreferences,
  ReaderVocabularyState,
  ReadingPositionSnapshot,
  SpeechPlaybackState,
  TranslationProgress,
} from '../../shared/types'
import { escapeInlineText, tokenizedInlineHtml } from '../reader/content-html'
import {
  applyReaderSearchHighlights,
  clearReaderSearchHighlights,
  findArticleMatches,
  queryIncludesChinese,
} from '../reader/search'
import { useReadingAnchor } from '../reader/use-reading-anchor'
import {
  AppearanceIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  SearchIcon,
  SpeakerIcon,
  TranslateIcon,
} from '../ui/icons'
import type { MobileAppClient } from './mobile-app-client'
import { AppearanceControls } from './mobile-settings-pages'
import {
  BottomSheet,
  BookCover,
  ContextCard,
  IconButton,
  MobileButton,
  SenseList,
  StatusPill,
  TopAppBar,
} from './mobile-ui'

export function MobilePublication({
  publication,
  onBack,
  onOpen,
}: {
  publication: PublicationDetail
  onBack(): void
  onOpen(articleId: string): void
}) {
  const sections = publication.sections
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(),
  )
  useEffect(() => setCollapsedSections(new Set()), [publication.id])
  const toggleSection = (sectionId: string) =>
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  return (
    <div className="mobile-page publication-page">
      <MobileToolbar title="目录" onBack={onBack} />
      <header className="publication-heading">
        <BookCover title={publication.title} imageUrl={publication.coverUrl} />
        <div>
          <p>
            {publication.creator ?? 'EPUB'}
            {publication.language
              ? ` · ${publication.language.toUpperCase()}`
              : ''}
          </p>
          <h1>{publication.title}</h1>
          <span>
            {publication.articleCount} 篇文章 · {publication.sectionCount}{' '}
            个栏目
          </span>
          {publication.title !== publication.originalTitle && (
            <small>原书名：{publication.originalTitle}</small>
          )}
        </div>
      </header>
      {publication.lastArticleId && (
        <button
          className="continue-button"
          onClick={() => onOpen(publication.lastArticleId!)}
        >
          继续上次阅读 <ChevronRightIcon />
        </button>
      )}
      <div className="publication-result-count">完整目录</div>
      {publication.unsectionedArticles.length > 0 && (
        <ArticleList
          articles={publication.unsectionedArticles}
          onOpen={onOpen}
        />
      )}
      {sections.map((section) => {
        const collapsed = collapsedSections.has(section.id)
        return (
          <section className="toc-section" key={section.id}>
            <h2>
              <button
                aria-expanded={!collapsed}
                onClick={() => toggleSection(section.id)}
              >
                <span>
                  {section.title}
                  <small>{section.articles.length}</small>
                </span>
                {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
              </button>
            </h2>
            {!collapsed && (
              <ArticleList articles={section.articles} onOpen={onOpen} />
            )}
          </section>
        )
      })}
    </div>
  )
}

function ArticleList({
  articles,
  onOpen,
}: {
  articles: PublicationDetail['unsectionedArticles']
  onOpen(id: string): void
}) {
  return (
    <div className="article-list">
      {articles.map((article) => (
        <button key={article.id} onClick={() => onOpen(article.id)}>
          <span>{article.title}</span>
          <small>{article.rubric ?? `${article.blockCount} 个内容块`}</small>
          <ChevronRightIcon />
        </button>
      ))}
    </div>
  )
}

export function MobileReader({
  clients,
  articleId,
  publicationId,
  preferences,
  onBack,
  onAppearance,
  onError,
  onInvalid,
  onDictionaryOpenChange,
  dictionaryCloseSignal,
  onOpenVocabulary,
}: {
  clients: MobileAppClient
  articleId: string
  publicationId: string
  preferences: ReaderPreferences
  onBack(): void
  onAppearance(): void
  onError(message: string): void
  onInvalid(): void
  onDictionaryOpenChange(open: boolean): void
  dictionaryCloseSignal: number
  onOpenVocabulary(): void
}) {
  const client = clients
  const dictionaryClient = clients.dictionary
  const translationClient = clients.translation
  const speechClient = clients.speech
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [article, setArticle] = useState<ArticleDetail | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)
  const pendingRestore = useRef<ReadingPositionSnapshot | null>(null)
  const restoreUntil = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const lookupSequence = useRef(0)
  const [lookupRequest, setLookupRequest] =
    useState<DictionaryLookupRequest | null>(null)
  const [lookupResult, setLookupResult] =
    useState<DictionaryLookupResult | null>(null)
  const [selectedLookupLexemeKey, setSelectedLookupLexemeKey] = useState<
    string | null
  >(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchIndex, setActiveSearchIndex] = useState(0)
  const [expandedTranslations, setExpandedTranslations] = useState<Set<string>>(
    new Set(),
  )
  const [translationMenuOpen, setTranslationMenuOpen] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [translationProgress, setTranslationProgress] =
    useState<TranslationProgress | null>(null)
  const [speechPlayback, setSpeechPlayback] = useState<SpeechPlaybackState>({
    status: 'idle',
    sourceId: null,
    itemId: null,
    index: 0,
    total: 0,
    error: null,
  })
  const speechRun = useRef(0)
  const nativeQueue = useRef(false)
  const speechQueue = useRef<{
    items: Array<{ id: string; blockId: string; text: string }>
    usage: 'word' | 'article'
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
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
  const translatedIds = useMemo(
    () =>
      article?.blocks
        .filter((block) => block.translation)
        .map((block) => block.id) ?? [],
    [article],
  )
  const allTranslationsExpanded =
    translatedIds.length > 0 &&
    translatedIds.every((id) => expandedTranslations.has(id))
  const {
    captureAnchor,
    getReadingPosition,
    restoreReadingPosition,
    refreshAnchor,
  } = useReadingAnchor(articleRef, [
    article?.id,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.columnWidth,
    searchOpen,
    [...translationSearchBlocks].join('|'),
  ])

  useEffect(() => {
    let active = true
    setLoadError(null)
    setArticle(null)
    setSearchOpen(false)
    setSearchQuery('')
    setExpandedTranslations(new Set())
    setTranslationMenuOpen(false)
    clearReaderSearchHighlights()
    client.reader
      .getArticle(articleId)
      .then((loaded) => {
        if (!active) return
        pendingRestore.current = loaded.savedPosition
        restoreUntil.current = Date.now() + 4_000
        setArticle(loaded)
      })
      .catch((reason) => {
        if (active) {
          setLoadError(messageOf(reason))
          onError(messageOf(reason))
        }
      })
    return () => {
      active = false
    }
  }, [articleId, client.reader, onError, retry])

  useEffect(
    () =>
      translationClient.onProgress((progress) => {
        if (progress.articleId === articleId) setTranslationProgress(progress)
      }),
    [articleId, translationClient],
  )

  useEffect(
    () => () => {
      speechRun.current++
      void speechClient.stop().catch(() => undefined)
    },
    [speechClient],
  )

  const closeDictionary = useCallback(() => {
    lookupSequence.current++
    setLookupRequest(null)
    setLookupResult(null)
    setLookupError(null)
    setLookupBusy(false)
    setSelectedLookupLexemeKey(null)
    articleRef.current
      ?.querySelectorAll('.lookup-word.active')
      .forEach((word) => word.classList.remove('active'))
  }, [])

  useEffect(() => {
    if (dictionaryCloseSignal > 0) {
      closeDictionary()
      setSearchOpen(false)
      setSearchQuery('')
      clearReaderSearchHighlights()
    }
  }, [closeDictionary, dictionaryCloseSignal])

  useEffect(() => {
    onDictionaryOpenChange(lookupRequest !== null || searchOpen)
    return () => onDictionaryOpenChange(false)
  }, [lookupRequest, onDictionaryOpenChange, searchOpen])

  useLayoutEffect(() => {
    if (
      !searchOpen ||
      !searchQuery.trim() ||
      !searchMatches.length ||
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
  }, [activeSearchIndex, searchMatches, searchOpen, searchQuery])

  useEffect(() => () => clearReaderSearchHighlights(), [])

  useLayoutEffect(() => {
    if (!article || !pendingRestore.current) return
    const position = pendingRestore.current
    const frame = requestAnimationFrame(() => {
      restoreReadingPosition(position)
      requestAnimationFrame(() => restoreReadingPosition(position))
    })
    return () => cancelAnimationFrame(frame)
  }, [article, restoreReadingPosition])

  useEffect(() => {
    const container = articleRef.current?.closest<HTMLElement>('.main-content')
    if (!container || !article) return
    const persist = () =>
      client.reader
        .savePosition(publicationId, articleId, getReadingPosition())
        .catch(() => undefined)
    const schedule = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(persist, 400)
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') void persist()
    }
    container.addEventListener('scroll', schedule, { passive: true })
    document.addEventListener('visibilitychange', visibility)
    return () => {
      container.removeEventListener('scroll', schedule)
      document.removeEventListener('visibilitychange', visibility)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      void persist()
    }
  }, [article, articleId, client.reader, getReadingPosition, publicationId])

  const imageLoaded = () => {
    if (pendingRestore.current && Date.now() < restoreUntil.current)
      restoreReadingPosition(pendingRestore.current)
    refreshAnchor()
  }

  const runLookup = useCallback(
    async (request: DictionaryLookupRequest, preferredLexemeKey?: string) => {
      const sequence = ++lookupSequence.current
      setLookupBusy(true)
      setLookupError(null)
      try {
        const result = await dictionaryClient.lookupInContext(
          request,
          preferredLexemeKey,
        )
        if (lookupSequence.current === sequence) setLookupResult(result)
      } catch (reason) {
        if (lookupSequence.current === sequence)
          setLookupError(messageOf(reason))
      } finally {
        if (lookupSequence.current === sequence) setLookupBusy(false)
      }
    },
    [dictionaryClient],
  )

  const wordClicked = (event: MouseEvent<HTMLElement>) => {
    const word = (event.target as HTMLElement).closest<HTMLElement>(
      '.lookup-word',
    )
    const block = word?.closest<HTMLElement>('[data-reader-block-id]')
    if (!word || !block) return
    const tokenIndex = Number(word.dataset.tokenIndex)
    if (!Number.isSafeInteger(tokenIndex) || tokenIndex < 0) return
    articleRef.current
      ?.querySelectorAll('.lookup-word.active')
      .forEach((item) => item.classList.remove('active'))
    word.classList.add('active')
    const request: DictionaryLookupRequest = {
      articleId,
      blockId: block.dataset.readerBlockId ?? '',
      surface: word.dataset.surface ?? word.textContent ?? '',
      tokenIndex,
    }
    setLookupRequest(request)
    setLookupResult(null)
    setSelectedLookupLexemeKey(null)
    void runLookup(request)
  }

  const installAndRetry = async (online: boolean) => {
    if (!lookupRequest) return
    setLookupBusy(true)
    setLookupError(
      online
        ? '正在下载并建立 ECDICT，首次预载可能需要几分钟…'
        : '请选择预构建词典包。',
    )
    try {
      const installed = online
        ? await dictionaryClient.installBasePackOnline()
        : await dictionaryClient.selectAndInstallBasePack()
      if (installed) await runLookup(lookupRequest)
      else setLookupError('已取消安装。')
    } catch (reason) {
      setLookupError(messageOf(reason))
    } finally {
      setLookupBusy(false)
    }
  }

  const openSearch = () => {
    captureAnchor()
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }

  const closeSearch = () => {
    captureAnchor()
    setSearchOpen(false)
    setSearchQuery('')
    setActiveSearchIndex(0)
    clearReaderSearchHighlights()
  }

  const navigateSearch = (direction: 1 | -1) => {
    if (!searchMatches.length) return
    setActiveSearchIndex(
      (current) =>
        (current + direction + searchMatches.length) % searchMatches.length,
    )
  }

  const toggleTranslation = (blockId: string) =>
    setExpandedTranslations((current) => {
      const next = new Set(current)
      if (next.has(blockId)) next.delete(blockId)
      else next.add(blockId)
      return next
    })

  const translateArticle = async (force = false) => {
    setTranslating(true)
    setTranslationProgress({
      articleId,
      completed: 0,
      total: 0,
      status: 'started',
    })
    try {
      await translationClient.translateArticle(articleId, force)
      const loaded = await client.reader.getArticle(articleId)
      setArticle(loaded)
      setExpandedTranslations(
        new Set(
          loaded.blocks
            .filter((block) => block.translation)
            .map((block) => block.id),
        ),
      )
    } catch (reason) {
      onError(messageOf(reason))
      client.reader
        .getArticle(articleId)
        .then(setArticle)
        .catch(() => undefined)
    } finally {
      setTranslating(false)
    }
  }

  useEffect(() => {
    if (!nativeQueue.current || !['playing','paused'].includes(speechPlayback.status)) return
    let current = true
    let timer: number | undefined
    let inFlight = false
    const poll = async () => {
      if (inFlight || !current) return
      inFlight = true
      try {
        const next = await speechClient.getQueueState()
        if (!current) return
        if (next.sourceId === articleId || next.status === 'idle') {
          setSpeechPlayback(next)
          if (next.status === 'idle' || next.status === 'error') nativeQueue.current = false
          if (next.error) onError(next.error)
        }
      } catch (reason) { if (current) { nativeQueue.current=false; onError(messageOf(reason)); setSpeechPlayback(value=>({...value,status:'error',error:messageOf(reason)})) } }
      inFlight = false
      if (current && nativeQueue.current) timer=window.setTimeout(()=>void poll(),750)
    }
    timer=window.setTimeout(()=>void poll(),500)
    const visible=()=> { if(document.visibilityState==='visible') { window.clearTimeout(timer); void poll() } }
    document.addEventListener('visibilitychange',visible)
    return()=>{current=false;window.clearTimeout(timer);document.removeEventListener('visibilitychange',visible)}
  },[articleId,onError,speechClient,speechPlayback.status])

  const stopSpeech = useCallback(async () => {
    nativeQueue.current = false
    speechRun.current++
    try {
      await speechClient.stop()
    } catch {
      /* playback may already be complete */
    }
    speechQueue.current = null
    setSpeechPlayback({
      status: 'idle',
      sourceId: null,
      itemId: null,
      index: 0,
      total: 0,
      error: null,
    })
  }, [speechClient])

  const playPreparedSpeech = useCallback(
    async (
      playable: Array<{ id: string; blockId: string; text: string }>,
      usage: 'word' | 'article',
      startIndex = 0,
    ) => {
      if (!playable.length || startIndex < 0 || startIndex >= playable.length)
        return
      const run = ++speechRun.current
      try {
        await speechClient.stop()
      } catch {
        /* no active playback */
      }
      try {
        const settings = await speechClient.getSettings()
        const providerId =
          usage === 'word'
            ? settings.preferences.wordProviderId
            : settings.preferences.articleProviderId
        const providerSetting =
          settings.preferences.providerSettings[providerId]
        if (usage === 'article') {
          nativeQueue.current = true
          setSpeechPlayback({status:'playing',sourceId:articleId,itemId:playable[startIndex].id,index:startIndex,total:playable.length,error:null})
          await speechClient.playQueue({ providerId,modelId:providerSetting?.modelId??'system',voiceId:providerSetting?.voiceId??settings.preferences.voiceId??'',locale:settings.preferences.locale,rate:settings.preferences.rate,
            sourceId:articleId,title:article?.title.slice(0,200)??'文章朗读',items:playable,startIndex })
          return
        }
        nativeQueue.current = false
        for (
          let index = startIndex;
          index < playable.length && speechRun.current === run;
          index++
        ) {
          const item = playable[index]
          setSpeechPlayback({
            status: 'playing',
            sourceId: articleId,
            itemId: item.id,
            index,
            total: playable.length,
            error: null,
          })
          await speechClient.play({
            providerId,
            modelId: providerSetting?.modelId ?? 'system',
            voiceId:
              providerSetting?.voiceId ?? settings.preferences.voiceId ?? '',
            locale: settings.preferences.locale,
            rate: settings.preferences.rate,
            text: item.text,
            sourceId: articleId,
            itemId: item.id,
            usage,
          })
        }
        if (speechRun.current === run) {
          setSpeechPlayback({
            status: 'idle',
            sourceId: null,
            itemId: null,
            index: 0,
            total: 0,
            error: null,
          })
        }
      } catch (reason) {
        if (speechRun.current !== run) return
        const message = messageOf(reason)
        setSpeechPlayback((current) => ({
          ...current,
          status: 'error',
          error: message,
        }))
        onError(message)
      }
    },
    [articleId, article?.title, onError, speechClient],
  )

  const playSpeechItems = useCallback(
    async (
      items: Array<{ id: string; text: string }>,
      usage: 'word' | 'article',
      startIndex = 0,
    ) => {
      const playable = items.flatMap((item) =>
        splitSpeechText(item.text).map((text, index) => ({
          id: `${item.id}:${index}`,
          blockId: item.id,
          text,
        })),
      )
      if (!playable.length) return
      speechQueue.current = { items: playable, usage }
      await playPreparedSpeech(
        playable,
        usage,
        Math.min(startIndex, playable.length - 1),
      )
    },
    [playPreparedSpeech],
  )

  const playArticleFromVisible = () => {
    if (!article) return
    const items = article.blocks
      .filter((block) => block.text?.trim())
      .map((block) => ({ id: block.id, text: block.text! }))
    const itemIds = new Set(items.map((item) => item.id))
    const visible = [
      ...(articleRef.current?.querySelectorAll<HTMLElement>(
        '[data-reader-block-id]',
      ) ?? []),
    ].find(
      (element) =>
        itemIds.has(element.dataset.readerBlockId ?? '') &&
        element.getBoundingClientRect().bottom > 72,
    )?.dataset.readerBlockId
    const visibleIndex = Math.max(
      0,
      items.findIndex((item) => item.id === visible),
    )
    const startIndex = items
      .slice(0, visibleIndex)
      .reduce((total, item) => total + splitSpeechText(item.text).length, 0)
    void playSpeechItems(items, 'article', startIndex)
  }

  const skipSpeech = (direction: -1 | 1) => {
    const queue = speechQueue.current
    if (!queue) return
    const next = speechBlockNeighborIndex(
      queue.items,
      speechPlayback.index,
      direction,
    )
    if (next >= 0) {
      if (nativeQueue.current) void speechClient.seekQueue(next).catch(reason=>onError(messageOf(reason)))
      else void playPreparedSpeech(queue.items, queue.usage, next)
    }
  }

  const toggleSpeechPause = async () => {
    try {
      if (speechPlayback.status === 'paused') {
        await speechClient.resume()
        setSpeechPlayback((current) => ({ ...current, status: 'playing' }))
      } else {
        await speechClient.pause()
        setSpeechPlayback((current) => ({ ...current, status: 'paused' }))
      }
    } catch (reason) {
      onError(messageOf(reason))
    }
  }

  if (!article)
    return loadError ? (
      <div className="mobile-page">
        <ErrorState
          description={loadError}
          onRetry={() => setRetry((v) => v + 1)}
        />
        <button onClick={onInvalid}>返回书库</button>
      </div>
    ) : (
      <div className="mobile-reader-loading">正在打开文章…</div>
    )
  return (
    <div
      className="mobile-page mobile-reader"
      style={
        {
          '--reader-font': `${preferences.fontSize / 16}rem`,
          '--reader-line': preferences.lineHeight,
          '--reader-width': `${preferences.columnWidth}px`,
        } as CSSProperties
      }
    >
      <MobileToolbar
        title={article.publicationTitle}
        onBack={onBack}
        action={
          <div className="reader-toolbar-actions">
            <IconButton label="搜索当前文章" onClick={openSearch}>
              <SearchIcon />
            </IconButton>
            <IconButton
              label="文章翻译"
              className={translationMenuOpen || translating ? 'active' : ''}
              onClick={() => setTranslationMenuOpen(true)}
            >
              <TranslateIcon />
            </IconButton>
            <IconButton
              label={
                speechPlayback.status === 'idle'
                  ? '从可见段落开始朗读'
                  : '停止朗读'
              }
              className={speechPlayback.status !== 'idle' ? 'active' : ''}
              onClick={() =>
                speechPlayback.status === 'idle'
                  ? playArticleFromVisible()
                  : void stopSpeech()
              }
            >
              <SpeakerIcon />
            </IconButton>
            <IconButton label="阅读外观" onClick={onAppearance}>
              <AppearanceIcon />
            </IconButton>
          </div>
        }
      />
      {translating && translationProgress && (
        <div className="mobile-translation-progress">
          <span
            style={{
              width: `${Math.round((100 * translationProgress.completed) / Math.max(1, translationProgress.total))}%`,
            }}
          />
          <small>
            正在翻译 {translationProgress.completed}/
            {translationProgress.total || '…'}
          </small>
        </div>
      )}
      {searchOpen && (
        <section className="mobile-reader-search" role="search">
          <SearchIcon />
          <input
            ref={searchInputRef}
            value={searchQuery}
            aria-label="搜索当前文章"
            placeholder="搜索当前文章"
            onChange={(event) => {
              setSearchQuery(event.target.value)
              setActiveSearchIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                navigateSearch(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') closeSearch()
            }}
          />
          <span
            className={
              searchQuery.trim() && !searchMatches.length ? 'empty' : ''
            }
          >
            {!searchQuery.trim()
              ? '输入关键词'
              : searchMatches.length
                ? `${activeSearchIndex + 1}/${searchMatches.length}`
                : '无结果'}
          </span>
          <IconButton
            label="上一项"
            disabled={!searchMatches.length}
            onClick={() => navigateSearch(-1)}
          >
            <ChevronUpIcon />
          </IconButton>
          <IconButton
            label="下一项"
            disabled={!searchMatches.length}
            onClick={() => navigateSearch(1)}
          >
            <ChevronDownIcon />
          </IconButton>
          <MobileButton variant="text" onClick={closeSearch}>
            关闭
          </MobileButton>
          {queryIncludesChinese(searchQuery) && (
            <small>同时搜索本机已有译文</small>
          )}
        </section>
      )}
      <ArticleReadingTools article={article} reader={clients.reader} onArticle={setArticle} />
      <article
        ref={articleRef}
        className="mobile-reader-article"
        onClick={wordClicked}
      >
        {article.sectionTitle && (
          <p className="reader-section-label">{article.sectionTitle}</p>
        )}
        {article.publishedAt && (
          <p className="reader-date">{article.publishedAt}</p>
        )}
        {article.blocks.map((block) => (
          <MobileBlock
            key={block.id}
            block={block}
            expanded={
              expandedTranslations.has(block.id) ||
              (searchOpen && translationSearchBlocks.has(block.id))
            }
            onToggle={toggleTranslation}
            onImageLoad={imageLoaded}
          />
        ))}
        <footer className="mobile-article-end">
          <span>◆</span>
          <p>End of article</p>
        </footer>
      </article>
      {translationMenuOpen && (
        <BottomSheet
          title="文章翻译"
          onClose={() => setTranslationMenuOpen(false)}
        >
          <div className="reader-translation-menu">
            <div>
              <b>
                {translatedIds.length
                  ? `已有 ${translatedIds.length} 段缓存译文`
                  : '尚无缓存译文'}
              </b>
              <small>
                {translatedIds.length
                  ? '译文可离线查看，并参与当前文章搜索。'
                  : '使用设置中当前选择的模型翻译全文。'}
              </small>
            </div>
            {translatedIds.length > 0 && (
              <MobileButton
                onClick={() => {
                  setExpandedTranslations(
                    allTranslationsExpanded
                      ? new Set()
                      : new Set(translatedIds),
                  )
                  setTranslationMenuOpen(false)
                }}
              >
                {allTranslationsExpanded ? '隐藏全部译文' : '显示全部译文'}
              </MobileButton>
            )}
            <MobileButton
              variant="primary"
              onClick={() => {
                setTranslationMenuOpen(false)
                translating
                  ? void translationClient.cancel(articleId)
                  : void translateArticle(translatedIds.length > 0)
              }}
            >
              {translating
                ? '停止翻译'
                : translatedIds.length
                  ? '重新翻译全文'
                  : '翻译全文'}
            </MobileButton>
          </div>
        </BottomSheet>
      )}
      {lookupRequest && (
        <ReaderDictionarySheet
          client={dictionaryClient}
          request={lookupRequest}
          result={lookupResult}
          busy={lookupBusy}
          error={lookupError}
          onClose={closeDictionary}
          selectedLexemeKey={selectedLookupLexemeKey}
          onSelect={(lexemeKey) => {
            setSelectedLookupLexemeKey(lexemeKey)
            void runLookup(lookupRequest, lexemeKey)
          }}
          onContext={(contextDefinition) =>
            setLookupResult((current) =>
              current ? { ...current, contextDefinition } : current,
            )
          }
          onInstall={(online) => void installAndRetry(online)}
          onCancelInstall={() =>
            void dictionaryClient.cancelDictionaryPackInstall()
          }
          onOpenVocabulary={() => {
            closeDictionary()
            onOpenVocabulary()
          }}
          onSpeak={(text) =>
            void playSpeechItems(
              [
                {
                  id: `word:${lookupRequest.blockId}:${lookupRequest.tokenIndex}`,
                  text,
                },
              ],
              'word',
            )
          }
        />
      )}
      {speechPlayback.status !== 'idle' && (
        <div className="mobile-speech-player" role="status">
          <SpeakerIcon />
          <span>
            <b>
              {speechPlayback.status === 'error'
                ? '朗读失败'
                : speechPlayback.status === 'paused'
                  ? '已暂停'
                  : speechQueue.current?.usage === 'word'
                    ? '单词朗读'
                    : '文章朗读'}
            </b>
            <small>
              {speechPlayback.error ??
                `${speechPlayback.index + 1} / ${speechPlayback.total}`}
            </small>
          </span>
          <MobileButton
            variant="text"
            disabled={
              !speechQueue.current ||
              speechBlockNeighborIndex(
                speechQueue.current.items,
                speechPlayback.index,
                -1,
              ) < 0
            }
            onClick={() => skipSpeech(-1)}
          >
            上一段
          </MobileButton>
          {speechPlayback.status !== 'error' && (
              <MobileButton
                variant="text"
                onClick={() => void toggleSpeechPause()}
              >
                {speechPlayback.status === 'paused' ? '继续' : '暂停'}
              </MobileButton>
            )}
          <MobileButton
            variant="text"
            disabled={
              !speechQueue.current ||
              speechBlockNeighborIndex(
                speechQueue.current.items,
                speechPlayback.index,
                1,
              ) < 0
            }
            onClick={() => skipSpeech(1)}
          >
            下一段
          </MobileButton>
          <MobileButton variant="text" onClick={() => void stopSpeech()}>
            停止
          </MobileButton>
        </div>
      )}
    </div>
  )
}

function ReaderDictionarySheet({
  client,
  request,
  result,
  busy,
  error,
  selectedLexemeKey,
  onClose,
  onSelect,
  onContext,
  onInstall,
  onCancelInstall,
  onOpenVocabulary,
  onSpeak,
}: {
  client: MobileAppClient['dictionary']
  request: DictionaryLookupRequest
  result: DictionaryLookupResult | null
  busy: boolean
  error: string | null
  selectedLexemeKey: string | null
  onClose(): void
  onSelect(lexemeKey: string): void
  onContext(
    value: NonNullable<DictionaryLookupResult['contextDefinition']>,
  ): void
  onInstall(online: boolean): void
  onCancelInstall(): void
  onOpenVocabulary(): void
  onSpeak(text: string): void
}) {
  const missing = error?.includes('尚未安装')
  const [state, setState] = useState<ReaderVocabularyState | null>(null)
  const [saving, setSaving] = useState(false)
  const [contextEnabled, setContextEnabled] = useState(false)
  const [contextBusy, setContextBusy] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  useEffect(() => {
    void client
      .getPreferences()
      .then((value) => setContextEnabled(value.contextExplanationEnabled))
      .catch(() => undefined)
  }, [client])
  useEffect(() => {
    if (!result?.found || !result.lexemeKey || result.requiresSelection) {
      setState(null)
      return
    }
    let active = true
    void client
      .getReaderState(request, result.lexemeKey)
      .then((value) => {
        if (active) setState(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [
    client,
    request,
    result?.found,
    result?.lexemeKey,
    result?.requiresSelection,
  ])
  const change = async (kind: 'favorite' | 'context') => {
    if (!result?.lexemeKey || saving) return
    setSaving(true)
    try {
      setState(
        kind === 'favorite'
          ? await client.setFavorite(
              request,
              result.lexemeKey,
              !state?.favorite,
            )
          : await client.setContextSaved(
              request,
              result.lexemeKey,
              !state?.contextSaved,
            ),
      )
    } finally {
      setSaving(false)
    }
  }
  const explain = async () => {
    setContextBusy(true)
    setContextError(null)
    try {
      onContext(
        await client.explainContext(request, selectedLexemeKey ?? undefined),
      )
    } catch (reason) {
      setContextError(messageOf(reason))
    } finally {
      setContextBusy(false)
    }
  }
  return (
    <div className="sheet-backdrop dictionary-sheet-backdrop" onClick={onClose}>
      <section
        className="reader-dictionary-sheet"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="mobile-eyebrow">ECDICT</p>
            <h2>{result?.lemma ?? request.surface}</h2>
            {result?.entries[0]?.phonetic && (
              <span>/{result.entries[0].phonetic}/</span>
            )}
          </div>
          <button onClick={onClose}>完成</button>
        </header>
        {busy && <p className="dictionary-loading">正在查询本地词典…</p>}
        {error && (
          <div className="dictionary-sheet-error">
            <p>{error}</p>
            {missing && (
              <div className="dictionary-actions">
                <button onClick={() => onInstall(true)}>联网预载</button>
                <button onClick={() => onInstall(false)}>选择本地包</button>
              </div>
            )}
            {busy && (
              <button className="text-action" onClick={onCancelInstall}>
                取消
              </button>
            )}
          </div>
        )}
        {result && (
          <>
            {result.candidates.length > 1 && (
              <div className="dictionary-candidates">
                <span>当前词形可能对应：</span>
                {result.candidates.map((candidate) => (
                  <button
                    className={
                      candidate.lexemeKey === result.lexemeKey ? 'active' : ''
                    }
                    key={candidate.lexemeKey}
                    onClick={() => onSelect(candidate.lexemeKey)}
                  >
                    {candidate.lemma}
                    <small>
                      {candidate.relation === 'exact'
                        ? '原词'
                        : candidate.relation === 'inflection'
                          ? '词形'
                          : '推断'}
                    </small>
                  </button>
                ))}
              </div>
            )}
            {result.contextDefinition && (
              <section className="mobile-context-definition">
                <div>
                  <small>
                    文中义 ·{' '}
                    {result.contextDefinition.basis === 'context-only'
                      ? '语境判断'
                      : result.contextDefinition.basis === 'selected-lexeme'
                        ? '已选词条'
                        : '候选辅助'}
                  </small>
                  <StatusPill
                    tone={
                      result.contextDefinition.cached ? 'neutral' : 'success'
                    }
                  >
                    {result.contextDefinition.cached
                      ? '已缓存'
                      : result.contextDefinition.confidence}
                  </StatusPill>
                </div>
                <h3>{result.contextDefinition.meaningZh}</h3>
                <b>{result.contextDefinition.partOfSpeech}</b>
                <p>{result.contextDefinition.explanationZh}</p>
                {result.contextDefinition.phrase && (
                  <em>{result.contextDefinition.phrase}</em>
                )}
              </section>
            )}
            {contextEnabled && !result.contextDefinition && (
              <MobileButton
                variant="primary"
                disabled={contextBusy}
                onClick={() => void explain()}
              >
                {contextBusy ? '正在分析文中义…' : '分析文中义'}
              </MobileButton>
            )}
            {contextError && (
              <p className="dictionary-missing-copy">{contextError}</p>
            )}
            <MobileButton
              variant="text"
              onClick={() => onSpeak(result.lemma ?? request.surface)}
            >
              <SpeakerIcon /> 朗读单词
            </MobileButton>
            {result.found ? (
              <DictionaryEntries entries={result.entries} />
            ) : (
              <p className="dictionary-missing-copy">
                standard-v1 中未找到“{request.surface}”。
              </p>
            )}
            {result.examples.length > 0 && (
              <section className="lexeme-examples">
                <h2>例句</h2>
                {result.examples.map((example) => (
                  <ContextCard
                    key={example.exampleId}
                    title={example.partOfSpeech ?? undefined}
                    sentence={example.text}
                    translation={example.translationZh}
                  />
                ))}
              </section>
            )}
            {result.found && result.lexemeKey && !result.requiresSelection && (
              <div className="vocabulary-actions">
                <button
                  disabled={saving}
                  className={state?.favorite ? 'active' : ''}
                  onClick={() => void change('favorite')}
                >
                  {state?.favorite ? '已收藏生词' : '收藏生词'}
                </button>
                <button
                  disabled={saving}
                  className={state?.contextSaved ? 'active' : ''}
                  onClick={() => void change('context')}
                >
                  {state?.contextSaved ? '已收藏语境' : '收藏语境'}
                </button>
                <button onClick={onOpenVocabulary}>我的生词</button>
              </div>
            )}
            <footer>
              <span>{result.sentence}</span>
              <small>
                {result.dictionaryVersion
                  ? `ECDICT ${result.dictionaryVersion}`
                  : 'ECDICT standard-v1'}
              </small>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}

function DictionaryEntries({ entries }: { entries: LexemeDetail['entries'] }) {
  if (!entries.length)
    return (
      <p className="dictionary-missing-copy">
        当前 standard-v1 没有可显示的简释。
      </p>
    )
  return (
    <SenseList
      groups={entries.flatMap((entry) =>
        entry.senses.map((sense) => ({
          partOfSpeech: sense.partOfSpeech,
          meanings: sense.translations,
        })),
      )}
    />
  )
}

function MobileBlock({
  block,
  expanded,
  onToggle,
  onImageLoad,
}: {
  block: ContentBlock
  expanded: boolean
  onToggle(blockId: string): void
  onImageLoad(): void
}) {
  const rendered = useMemo(
    () => tokenizedInlineHtml(block.html || escapeInlineText(block.text ?? '')),
    [block.html, block.text],
  )
  if (block.type === 'image')
    return block.assetUrl ? (
      <figure data-reader-block-id={block.id}>
        <img
          src={block.assetUrl}
          alt={block.alt ?? ''}
          loading="lazy"
          decoding="async"
          onLoad={onImageLoad}
        />
      </figure>
    ) : null
  const Tag =
    block.type === 'title'
      ? 'h1'
      : block.type === 'heading'
        ? 'h2'
        : block.type === 'rubric'
          ? 'h3'
          : block.type === 'quote'
            ? 'blockquote'
            : 'p'
  return (
    <div
      className={`mobile-block block-${block.type} ${block.translation ? 'has-translation' : ''}`}
      data-reader-block-id={block.id}
    >
      <Tag
        data-source-block-id={block.id}
        dangerouslySetInnerHTML={{ __html: rendered }}
      />
      {block.translation && (
        <div className="mobile-block-actions">
          <button
            className="mobile-translation-toggle"
            onClick={(event) => {
              event.stopPropagation()
              onToggle(block.id)
            }}
          >
            {expanded ? '隐藏译文' : '查看译文'}
          </button>
        </div>
      )}
      {block.translation && expanded && (
        <div
          className="mobile-translation-text"
          data-translation-block-id={block.id}
        >
          {block.translation}
        </div>
      )}
    </div>
  )
}

function MobileToolbar({
  title,
  onBack,
  action,
}: {
  title: string
  onBack(): void
  action?: ReactNode
}) {
  return <TopAppBar title={title} onBack={onBack} action={action} />
}

export function AppearanceSheet({
  preferences,
  onChange,
  onClose,
}: {
  preferences: ReaderPreferences
  onChange(value: ReaderPreferences): void
  onClose(): void
}) {
  return (
    <BottomSheet title="阅读外观" onClose={onClose}>
      <AppearanceControls preferences={preferences} onChange={onChange} />
    </BottomSheet>
  )
}

function splitSpeechText(value: string, limit = 3500): string[] {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return []
  if (text.length <= limit) return [text]
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const next = `${current} ${sentence}`.trim()
    if (next.length <= limit) {
      current = next
      continue
    }
    if (current) chunks.push(current)
    if (sentence.length <= limit) {
      current = sentence.trim()
      continue
    }
    for (let offset = 0; offset < sentence.length; offset += limit)
      chunks.push(sentence.slice(offset, offset + limit).trim())
    current = ''
  }
  if (current) chunks.push(current)
  return chunks.filter(Boolean)
}

function speechBlockNeighborIndex(
  items: Array<{ blockId: string }>,
  index: number,
  direction: -1 | 1,
): number {
  const current = items[index]
  if (!current) return -1
  if (direction === 1)
    return items.findIndex(
      (item, candidate) =>
        candidate > index && item.blockId !== current.blockId,
    )
  let candidate = index - 1
  while (candidate >= 0 && items[candidate].blockId === current.blockId)
    candidate--
  if (candidate < 0) return -1
  const previousBlock = items[candidate].blockId
  while (candidate > 0 && items[candidate - 1].blockId === previousBlock)
    candidate--
  return candidate
}

function messageOf(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'message' in reason)
    return String(reason.message)
  return '操作失败，请重试。'
}
