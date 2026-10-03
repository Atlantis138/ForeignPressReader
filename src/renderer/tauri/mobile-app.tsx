import type { ContentsSnapshot } from '../reader/use-contents-translation'
import { ErrorState } from './mobile-ui'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StudySessionState } from '../../shared/types'
import { TauriMobileAppClient } from './mobile-app-client'
import {
  MobileDictionaryHome as MobileDictionaryCenter,
  MobileLexemePage as MobileLexemeCenter,
} from './mobile-dictionary-pages'
import {
  EMPTY_LIBRARY_SELECTION,
  exitLibrarySelection,
  MobileLibrary,
  type LibrarySelectionState,
} from './mobile-library-page'
import {
  AppearanceSheet,
  MobilePublication,
  MobileReader,
} from './mobile-reader-pages'
import {
  activeRoute,
  isImmersiveRoute,
  mobileBackTarget,
  parseMobileShellState,
  popMobileRoute,
  pushMobileRoute,
  reconcileMobileRoutesAfterDataMerge,
  replaceTabRoot,
  routeKey,
  selectPrimaryTab,
  serializeMobileShellState,
  setMobileDraft,
  setMobileScroll,
  type MobileRoute,
  type MobileShellState,
  type PrimaryTab,
  MOBILE_SHELL_STORAGE_KEY,
} from './mobile-shell-model'
import {
  MobileSettingsHome,
  MobileSettingsSectionPage,
} from './mobile-settings-pages'
import { useMobileGlobalTasks } from './mobile-global-tasks'
import { useMobileReadingController } from './mobile-reading-controller'
import {
  MobileStudyHome as MobileStudyDashboard,
  MobileStudyPlanDetail,
  MobileStudyPlanEditor,
  MobileStudySession as MobileStudySessionPage,
  MobileTodayWords,
} from './mobile-study-pages'
import {
  ConfirmDialog,
  MobileAppShell,
  Skeleton,
  type MobileTask,
} from './mobile-ui'

export { MobileDataSettings } from './mobile-settings-pages'

const mobileAppClient = new TauriMobileAppClient()
const dictionaryClient = mobileAppClient.dictionary
const studyClient = mobileAppClient.study
const speechClient = mobileAppClient.speech

export function MobileReadingApp() {
  const [shell, setShell] = useState(() => parseMobileShellState(window.localStorage.getItem(MOBILE_SHELL_STORAGE_KEY)))
  const route = activeRoute(shell)
  const currentRouteKey = routeKey(route)
  const restoredScrollTop = shell.scrollPositions[currentRouteKey] ?? 0
  const scrollRef = useRef<HTMLElement | null>(null)
  const contentsSnapshots = useRef(new Map<string, ContentsSnapshot>())
  const contentsSnapshot = (id: string) => {
    if (!contentsSnapshots.current.has(id)) contentsSnapshots.current.set(id, { scrollTop: restoredScrollTop, showTranslation: true })
    return contentsSnapshots.current.get(id)!
  }
  const scrollTimer = useRef<number | null>(null)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snackbar, setSnackbar] = useState<string | null>(null)
  const [task, setTask] = useState<MobileTask | null>(null)
  const [readerDictionaryOpen, setReaderDictionaryOpen] = useState(false)
  const [dictionaryCloseSignal, setDictionaryCloseSignal] = useState(0)
  const [studySession, setStudySession] = useState<StudySessionState | null>(null)
  const [exitStudyConfirm, setExitStudyConfirm] = useState(false)
  const [childOverlayOpen, setChildOverlayOpen] = useState(false)
  const [childOverlayCloseSignal, setChildOverlayCloseSignal] = useState(0)
  const [librarySelection, setLibrarySelection] = useState<LibrarySelectionState>(EMPTY_LIBRARY_SELECTION)
  const [developerVisible, setDeveloperVisible] = useState(false)
  const settingsTitleTaps = useRef<number[]>([])
  useMobileGlobalTasks(mobileAppClient, setTask, setError)

  const tapSettingsTitle = useCallback(() => {
    const now = Date.now()
    settingsTitleTaps.current = [...settingsTitleTaps.current.filter((value) => now - value <= 5_000), now]
    if (settingsTitleTaps.current.length >= 10) {
      settingsTitleTaps.current = []
      setDeveloperVisible(true)
      setSnackbar('“开发与调试”已在本次运行中显示。')
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => window.localStorage.setItem(MOBILE_SHELL_STORAGE_KEY, serializeMobileShellState(shell)), 180)
    return () => clearTimeout(timer)
  }, [shell])

  const captureScrollState = useCallback((current: MobileShellState) => {
    if (route.name === 'article') return current
    const top = scrollRef.current?.scrollTop ?? 0
    if (current.scrollPositions[currentRouteKey] === top) return current
    return setMobileScroll(current, currentRouteKey, top)
  }, [currentRouteKey, route.name])

  const captureScroll = useCallback(() => {
    setShell((current) => captureScrollState(current))
  }, [captureScrollState])

  useEffect(() => {
    const container = scrollRef.current
    if (!container || route.name === 'article') return
    const onScroll = () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = window.setTimeout(captureScroll, 160)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      captureScroll()
    }
  }, [captureScroll, route.name])

  useLayoutEffect(() => {
    if (route.name === 'article' || route.name === 'publication') return
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: restoredScrollTop }))
  }, [currentRouteKey, restoredScrollTop, route.name])

  const navigate = useCallback((next: MobileRoute) => {
    setShell((current) => pushMobileRoute(captureScrollState(current), next))
  }, [captureScrollState])

  const returnToLibrary = useCallback(() => {
    setShell((current) => replaceTabRoot(current, 'library', { name: 'library' }))
  }, [])

  const {
    libraryState,
    setLibraryState,
    libraryReady,
    libraryError,
    publication,
    preferences,
    reloadLibrary,
    reloadSynchronizedData,
    importPublication,
    savePreferences,
  } = useMobileReadingController({
    client: mobileAppClient,
    route,
    onNavigate: navigate,
    onReturnToLibrary: returnToLibrary,
    onBusy: setBusy,
    onError: setError,
    onNotice: setSnackbar,
    onTask: setTask,
  })

  const handleExternalDataChange = useCallback(async () => {
    studyClient.invalidateCachedData()
    setStudySession(null)
    setShell((current) => reconcileMobileRoutesAfterDataMerge(current))
    await reloadSynchronizedData()
  }, [reloadSynchronizedData])

  const selectTab = useCallback((tab: PrimaryTab) => {
    if (tab === shell.activeTab && tab === 'library') setLibrarySelection(exitLibrarySelection())
    setShell((current) => selectPrimaryTab(captureScrollState(current), tab))
  }, [captureScrollState, shell.activeTab])

  const handleInvalidArticle = useCallback(() => setShell((current) => popMobileRoute(current)), [])

  const goBack = useCallback(() => {
    if (exitStudyConfirm) {
      setExitStudyConfirm(false)
      return
    }
    if (childOverlayOpen) {
      setChildOverlayCloseSignal((value) => value + 1)
      return
    }
    if (readerDictionaryOpen) {
      setDictionaryCloseSignal((value) => value + 1)
      return
    }
    if (appearanceOpen) {
      setAppearanceOpen(false)
      return
    }
    if (route.name === 'library' && librarySelection.mode) {
      setLibrarySelection(exitLibrarySelection())
      return
    }
    if (route.name === 'study-session') {
      setExitStudyConfirm(true)
      return
    }
    setShell((current) => popMobileRoute(captureScrollState(current)))
  }, [appearanceOpen, captureScrollState, childOverlayOpen, exitStudyConfirm, librarySelection.mode, readerDictionaryOpen, route.name])

  const goBackRef = useRef(goBack)
  useLayoutEffect(() => { goBackRef.current = goBack }, [goBack])
  const overlayOpen = appearanceOpen || readerDictionaryOpen || exitStudyConfirm || childOverlayOpen || (route.name === 'library' && librarySelection.mode)
  const shouldInterceptSystemBack = mobileBackTarget(shell, overlayOpen) !== 'system'

  useEffect(() => {
    if (!shouldInterceptSystemBack) return
    let disposed = false
    let unregister: (() => Promise<void>) | undefined
    void mobileAppClient.platform.lifecycle.onBackButtonPress(() => goBackRef.current()).then((next) => {
      if (disposed) void next()
      else unregister = next
    })
    return () => {
      disposed = true
      if (unregister) void unregister()
    }
  }, [shouldInterceptSystemBack])

  return (
    <MobileAppShell
      activeTab={shell.activeTab}
      immersive={isImmersiveRoute(route)}
      onSelectTab={selectTab}
      scrollRef={scrollRef}
      busy={busy}
      task={task}
      error={error}
      onDismissError={() => setError(null)}
      snackbar={snackbar}
      onDismissSnackbar={() => setSnackbar(null)}
    >
      {route.name === 'library' && !libraryReady && <div className="mobile-page">{libraryError ? <ErrorState description={libraryError} onRetry={() => void reloadLibrary()} /> : <Skeleton lines={8} />}</div>}
      {route.name === 'library' && libraryReady && <MobileLibrary
        client={mobileAppClient}
        state={libraryState}
        selection={librarySelection}
        onSelection={setLibrarySelection}
        onState={setLibraryState}
        onRefresh={() => void reloadLibrary()}
        onImport={() => void importPublication()}
        onOpen={(publicationId) => navigate({ name: 'publication', publicationId })}
        onOpenArticle={(publicationId, articleId) => navigate({ name: 'article', publicationId, articleId })}
        onError={setError}
        onNotice={setSnackbar}
        overlayCloseSignal={childOverlayCloseSignal}
        onOverlayOpenChange={setChildOverlayOpen}
        deferOffscreenCards={restoredScrollTop <= 1}
      />}
      {route.name === 'publication' && publication?.id === route.publicationId && (
        <MobilePublication key={publication.id} publication={publication} client={mobileAppClient.translation} snapshot={contentsSnapshot(publication.id)} onError={setError} onBack={goBack} onOpen={(articleId) => {
          navigate({ name: 'article', publicationId: publication.id, articleId })
        }} />
      )}
      {route.name === 'article' && (
        <MobileReader
          clients={mobileAppClient}
          articleId={route.articleId}
          publicationId={route.publicationId}
          preferences={preferences}
          onBack={goBack}
          onAppearance={() => setAppearanceOpen(true)}
          onError={setError}
          onInvalid={handleInvalidArticle}
          onDictionaryOpenChange={setReaderDictionaryOpen}
          dictionaryCloseSignal={dictionaryCloseSignal}
          onOpenVocabulary={() => setShell((current) => replaceTabRoot(current, 'dictionary', { name: 'dictionary', mode: 'vocabulary' }))}
        />
      )}
      {route.name === 'dictionary' && <MobileDictionaryCenter
        client={dictionaryClient}
        mode={route.mode}
        dictionaryText={shell.drafts.dictionaryQuery}
        vocabularyText={shell.drafts.vocabularyQuery}
        onMode={(mode) => setShell((current) => replaceTabRoot(current, 'dictionary', { name: 'dictionary', mode }))}
        onDictionaryText={(value) => setShell((current) => setMobileDraft(current, 'dictionaryQuery', value))}
        onVocabularyText={(value) => setShell((current) => setMobileDraft(current, 'vocabularyQuery', value))}
        onLexeme={(lexemeKey) => navigate({ name: 'lexeme', lexemeKey, hostTab: 'dictionary' })}
        onArticle={(publicationId, articleId) => navigate({ name: 'article', publicationId, articleId })}
        onOpenSettings={() => setShell((current) => replaceTabRoot(current, 'settings', { name: 'settings-section', section: 'dictionary' }))}
        onError={setError}
      />}
      {route.name === 'lexeme' && <MobileLexemeCenter client={dictionaryClient} speech={speechClient} lexemeKey={route.lexemeKey} onBack={goBack} onArticle={(publicationId, articleId) => navigate({ name: 'article', publicationId, articleId })} onError={setError} />}
      {route.name === 'study' && <MobileStudyDashboard client={studyClient} onSession={(session) => { setStudySession(session); navigate({ name: 'study-session' }) }} onCreatePlan={() => navigate({ name: 'study-plan-editor' })} onPlan={(planId) => navigate({ name: 'study-plan', planId })} onToday={(sessionId) => navigate({ name: 'study-today', sessionId })} onError={setError} />}
      {route.name === 'study-plan-editor' && <MobileStudyPlanEditor client={studyClient} planId={route.planId} onBack={goBack} onSaved={(planId) => setShell((current) => pushMobileRoute(popMobileRoute(current), { name: 'study-plan', planId }))} onError={setError} />}
      {route.name === 'study-plan' && <MobileStudyPlanDetail client={studyClient} planId={route.planId} onBack={goBack} onEdit={() => navigate({ name: 'study-plan-editor', planId: route.planId })} onError={setError} onNotice={setSnackbar} />}
      {route.name === 'study-today' && <MobileTodayWords client={studyClient} sessionId={route.sessionId} onBack={goBack} onLexeme={(lexemeKey) => navigate({ name: 'lexeme', lexemeKey, hostTab: 'study' })} onError={setError} />}
      {route.name === 'study-session' && studySession && <MobileStudySessionPage client={studyClient} speech={speechClient} session={studySession} onSession={setStudySession} onBack={goBack} onOpenLexeme={(lexemeKey) => navigate({ name: 'lexeme', lexemeKey, hostTab: 'study' })} onError={setError} onNotice={setSnackbar} />}
      {route.name === 'study-session' && !studySession && <div className="mobile-page"><Skeleton lines={5} /></div>}
      {route.name === 'settings' && <MobileSettingsHome preferences={preferences} developerVisible={developerVisible} onTitleTap={tapSettingsTitle} onOpen={(section) => navigate({ name: 'settings-section', section })} />}
      {route.name === 'settings-section' && <MobileSettingsSectionPage clients={mobileAppClient} section={route.section} preferences={preferences} onBack={goBack} onOpen={(section) => navigate({ name: 'settings-section', section })} onChange={(next) => void savePreferences(next)} onDataChanged={handleExternalDataChange} onError={setError} onNotice={setSnackbar} onTask={setTask} />}
      {appearanceOpen && (
        <AppearanceSheet preferences={preferences} onChange={(next) => void savePreferences(next)} onClose={() => setAppearanceOpen(false)} />
      )}
      {exitStudyConfirm && <ConfirmDialog title="退出本次答题？" description="当前学习进度已经保存在本机，退出不会提交尚未确认的答案。稍后可从“背单词”继续。" confirmLabel="退出并保留进度" onCancel={() => setExitStudyConfirm(false)} onConfirm={() => { setExitStudyConfirm(false); setShell((current) => popMobileRoute(current)) }} />}
    </MobileAppShell>
  )
}
