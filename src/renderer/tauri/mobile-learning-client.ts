import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  DictionaryCollection,
  DictionaryCredentialStatus,
  DictionaryExample,
  DictionaryInstallProgress,
  DictionaryLocalProfile,
  DictionaryLookupRequest,
  DictionaryLookupResult,
  DictionaryPreferences,
  DictionarySearchQuery,
  DictionarySearchPage,
  ConnectionTestResult,
  ContextDefinition,
  LexemeDetail,
  LexemeKey,
  ReaderVocabularyState,
  SavedContextPage,
  StudyAnswerRequest,
  StudyDashboard,
  StudyDebugState,
  StudyDeletePlanOptions,
  StudyPlanDetail,
  StudyPlanInput,
  StudyPlanStatus,
  StudyPlanSummary,
  StudyPlanWordPage,
  StudyPlanWordQuery,
  StudyPreferences,
  StudySessionState,
  StudySourceSyncResult,
  StudyStageAnswerRequest,
  StudyTodayWordPage,
  StudyTodayWordQuery,
  StudyTooEasyRequest,
  VocabularyListPage,
  VocabularyListQuery,
} from '../../shared/types'
import type {
  MobileDictionaryBrowseClient,
  MobileDictionaryClient,
  MobileDictionaryInstallResult,
  MobileDictionaryPackStatus,
  MobileDictionarySearchQuery,
  MobileVocabularyClient,
  MobileDictionaryCenterStatus,
  MobileDictionaryCenterClient,
  MobileLexemeSource,
  MobileStudyManagementClient,
  MobileDictionaryInstallPreflight,
  MobileDictionaryOnlineInstallClient,
  StoredReviewCardContract,
} from '../../shared/mobile-learning'
import { normalizePlatformError } from './platform-error'
import { prepareMobileQueuePlanV2, prepareMobileReviewTransitionV2 } from '../../core/study/mobile-planning'
import { studyMoment } from '../../core/study/study-clock'
import { MobileRequestCache } from './mobile-request-cache'

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export class TauriMobileDictionaryClient implements MobileDictionaryClient, MobileDictionaryBrowseClient, MobileDictionaryOnlineInstallClient, MobileVocabularyClient, MobileDictionaryCenterClient {
  private activeInstall: string | null = null
  private activeLookup: string | null = null
  private activeSearch: string | null = null
  private readonly statusCache = new MobileRequestCache<MobileDictionaryCenterStatus>()
  private readonly collectionsCache = new MobileRequestCache<DictionaryCollection[]>()

  constructor(private readonly invokeCommand: InvokeFn = invoke) {}

  getDictionaryPackStatus(): Promise<MobileDictionaryPackStatus> {
    return this.call('get_mobile_dictionary_status')
  }

  getStatus(): Promise<MobileDictionaryCenterStatus> {
    return this.statusCache.get(() => this.call('get_mobile_dictionary_center_status'))
  }

  peekStatus(): MobileDictionaryCenterStatus | undefined { return this.statusCache.peek() }
  peekCollections(): DictionaryCollection[] | undefined { return this.collectionsCache.peek() }

  async installBasePackOnline(): Promise<MobileDictionaryPackStatus> {
    if (this.activeInstall) throw new Error('已有词典安装任务正在运行')
    const requestId = crypto.randomUUID()
    this.activeInstall = requestId
    try {
      return await this.call('install_mobile_dictionary_online', { requestId })
    } finally {
      this.invalidateResources()
      if (this.activeInstall === requestId) this.activeInstall = null
    }
  }

  async selectAndInstallBasePack(): Promise<MobileDictionaryPackStatus | null> {
    if (this.activeInstall) throw new Error('已有词典安装任务正在运行')
    const requestId = crypto.randomUUID()
    this.activeInstall = requestId
    try {
      const result = await this.call<MobileDictionaryInstallResult>('select_and_install_mobile_dictionary', { requestId })
      return result.cancelled ? null : result.status
    } finally {
      this.invalidateResources()
      if (this.activeInstall === requestId) this.activeInstall = null
    }
  }

  async cancelDictionaryPackInstall(): Promise<void> {
    const requestId = this.activeInstall
    if (!requestId) return
    await this.call('cancel_mobile_dictionary_install', { requestId })
  }

  async removeBasePack(): Promise<void> {
    await this.call('remove_mobile_dictionary')
    this.invalidateResources()
  }

  async install(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<void> {
    if (this.activeInstall) throw new Error('已有词典安装任务正在运行')
    const requestId = crypto.randomUUID()
    this.activeInstall = requestId
    try {
      await this.call('install_mobile_dictionary_online', { requestId, profile })
    } finally {
      this.invalidateResources()
      if (this.activeInstall === requestId) this.activeInstall = null
    }
  }

  async installFromLocal(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<boolean> {
    if (this.activeInstall) throw new Error('已有词典安装任务正在运行')
    const requestId = crypto.randomUUID()
    this.activeInstall = requestId
    try {
      const result = await this.call<MobileDictionaryInstallResult>('select_and_install_mobile_dictionary', { requestId, profile })
      return !result.cancelled
    } finally {
      this.invalidateResources()
      if (this.activeInstall === requestId) this.activeInstall = null
    }
  }

  async repair(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<void> {
    try {
      await this.call('repair_mobile_dictionary', { profile })
    } catch {
      // Failed deep verification rebuilds a separate generation; publication remains atomic.
      await this.install(profile)
    }
    this.invalidateResources()
  }

  async removeFullExtension(): Promise<void> {
    await this.call('remove_mobile_dictionary_full_extension')
    this.invalidateResources()
  }

  cancelInstall(): Promise<void> {
    return this.cancelDictionaryPackInstall()
  }

  remove(): Promise<void> {
    return this.removeBasePack()
  }

  async lookupInContext(
    request: DictionaryLookupRequest,
    preferredLexemeKey?: LexemeKey,
  ): Promise<DictionaryLookupResult> {
    const previous = this.activeLookup
    if (previous) void this.call('cancel_mobile_dictionary_query', { requestId: previous }).catch(() => undefined)
    const requestId = crypto.randomUUID()
    this.activeLookup = requestId
    try {
      return await this.call('lookup_mobile_dictionary', {
        requestId,
        request,
        preferredLexemeKey: preferredLexemeKey ?? null,
      })
    } finally {
      if (this.activeLookup === requestId) this.activeLookup = null
    }
  }

  lookup(request: DictionaryLookupRequest): Promise<DictionaryLookupResult> {
    return this.lookupInContext(request)
  }

  getLexeme(lexemeKey: LexemeKey): Promise<LexemeDetail> {
    return this.call('get_mobile_dictionary_lexeme', { lexemeKey })
  }

  async enrichExamples(lexemeKey: LexemeKey): Promise<DictionaryExample[]> {
    return (await this.getLexeme(lexemeKey)).examples
  }

  getLexemeSource(lexemeKey: LexemeKey): Promise<MobileLexemeSource> {
    return this.call('get_mobile_lexeme_source', { lexemeKey })
  }

  listCollections(): Promise<DictionaryCollection[]> {
    return this.collectionsCache.get(() => this.call('list_mobile_dictionary_collections'))
  }

  getPreferences(): Promise<DictionaryPreferences> {
    return this.call('get_mobile_dictionary_preferences')
  }

  savePreferences(value: DictionaryPreferences): Promise<DictionaryPreferences> {
    return this.call('save_mobile_dictionary_preferences', { value })
  }

  getCredentialStatus(): Promise<DictionaryCredentialStatus> {
    return this.call('get_mobile_dictionary_credential_status')
  }

  saveBaiduCredentials(apiKey: string, secretKey: string): Promise<ConnectionTestResult> {
    return this.call('save_mobile_baidu_credentials', { apiKey, secretKey })
  }

  deleteBaiduCredentials(): Promise<void> {
    return this.call('delete_mobile_baidu_credentials')
  }

  testBaiduConnection(): Promise<ConnectionTestResult> {
    return this.call('test_mobile_baidu_connection')
  }

  explainContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<ContextDefinition> {
    return this.call('explain_mobile_dictionary_context', {
      request,
      preferredLexemeKey: preferredLexemeKey ?? null,
    })
  }

  getReaderState(request: DictionaryLookupRequest, lexemeKey: LexemeKey): Promise<ReaderVocabularyState> {
    return this.call('get_mobile_reader_vocabulary_state', { request, lexemeKey })
  }

  setFavorite(request: DictionaryLookupRequest, lexemeKey: LexemeKey, favorite: boolean): Promise<ReaderVocabularyState> {
    return this.call('set_mobile_vocabulary_favorite', { request, lexemeKey, favorite })
  }

  setContextSaved(request: DictionaryLookupRequest, lexemeKey: LexemeKey, saved: boolean): Promise<ReaderVocabularyState> {
    return this.call('set_mobile_context_saved', { request, lexemeKey, saved })
  }

  listFavorites(query: VocabularyListQuery): Promise<VocabularyListPage> {
    return this.call('list_mobile_vocabulary_favorites', { query })
  }

  listContexts(lexemeKey: LexemeKey, offset = 0): Promise<SavedContextPage> {
    return this.call('list_mobile_saved_contexts', { lexemeKey, offset })
  }

  removeFavorite(lexemeKey: LexemeKey): Promise<void> {
    return this.call('remove_mobile_vocabulary_favorite', { lexemeKey })
  }

  async searchDictionary(query: MobileDictionarySearchQuery | DictionarySearchQuery): Promise<DictionarySearchPage> {
    const previous = this.activeSearch
    if (previous) void this.call('cancel_mobile_dictionary_query', { requestId: previous }).catch(() => undefined)
    const requestId = crypto.randomUUID()
    this.activeSearch = requestId
    try {
      return await this.call('search_mobile_dictionary', { requestId, query })
    } finally {
      if (this.activeSearch === requestId) this.activeSearch = null
    }
  }

  search(query: DictionarySearchQuery): Promise<DictionarySearchPage> {
    return this.searchDictionary(query)
  }

  async cancelSearch(): Promise<void> {
    const requestId = this.activeSearch
    if (!requestId) return
    await this.call('cancel_mobile_dictionary_query', { requestId })
  }

  preflightInstall(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<MobileDictionaryInstallPreflight> {
    return this.call('preflight_mobile_dictionary_install', { profile })
  }

  onInstallProgress(callback: (progress: DictionaryInstallProgress) => void): () => void {
    let active = true
    let dispose: (() => void) | undefined
    void listen<DictionaryInstallProgress>('mobile-dictionary-install-progress', (event) => {
      if (active) callback(event.payload)
    }).then((unlisten) => {
      if (active) dispose = unlisten
      else unlisten()
    })
    return () => { active = false; dispose?.() }
  }

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.invokeCommand<T>(command, args)
    } catch (reason) {
      throw normalizePlatformError(reason)
    }
  }

  private invalidateResources(): void {
    this.statusCache.invalidate()
    this.collectionsCache.invalidate()
  }
}

export class TauriMobileStudyClient implements MobileStudyManagementClient {
  private readonly dashboardCache = new MobileRequestCache<StudyDashboard>()

  constructor(private readonly invokeCommand: InvokeFn = invoke) {}

  getDashboard(): Promise<StudyDashboard> { return this.dashboardCache.get(() => this.call('get_mobile_study_dashboard')) }
  peekDashboard(): StudyDashboard | undefined { return this.dashboardCache.peek() }
  listPlans(includeArchived = false): Promise<StudyPlanSummary[]> { return this.call('list_mobile_study_plans', { includeArchived }) }
  createPlan(input: StudyPlanInput): Promise<StudyPlanDetail> { return this.mutate(() => this.call('create_mobile_study_plan', { input })) }
  updatePlan(planId: string, input: StudyPlanInput): Promise<StudyPlanDetail> { return this.mutate(() => this.call('update_mobile_study_plan', { planId, input })) }
  setPlanStatus(planId: string, status: StudyPlanStatus): Promise<void> { return this.mutate(() => this.call('set_mobile_study_plan_status', { planId, status })) }
  getPlan(planId: string): Promise<StudyPlanDetail> { return this.call('get_mobile_study_plan', { planId }) }
  listPlanWords(planId: string, query: StudyPlanWordQuery): Promise<StudyPlanWordPage> { return this.call('list_mobile_study_plan_words', { planId, query }) }
  setWordExcluded(planId: string, lexemeKey: LexemeKey, excluded: boolean): Promise<void> { return this.mutate(() => this.call('set_mobile_study_word_excluded', { planId, lexemeKey, excluded })) }
  setWordSuspended(lexemeKey: LexemeKey, suspended: boolean): Promise<void> { return this.mutate(() => this.call('set_mobile_study_word_suspended', { lexemeKey, suspended })) }
  listTodayWords(sessionId: string, query: StudyTodayWordQuery): Promise<StudyTodayWordPage> { return this.call('list_mobile_study_today_words', { sessionId, query }) }
  hydrateCurrentExamples(request: { sessionId: string; itemId: string; expectedVersion: number }): Promise<DictionaryExample[]> {
    return this.call('hydrate_mobile_study_examples', request)
  }

  async openToday(): Promise<StudySessionState> {
    const preferences = await this.getPreferences()
    const now = new Date()
    const preparation = await this.call<{
      order: StudyPreferences['queueOrder']
      stateFingerprint: string
      quotas: Array<{ planId: string; dailyNewLimit: number; dailyReviewLimit: number }>
      candidates: Array<{ lexemeKey: string; planId: string; kind: 'review' | 'new'; dueAt: string | null; rank: number | null }>
    }>('prepare_mobile_today_v2', { now: now.toISOString() })
    const moment = studyMoment(now, preferences.cutoffHour)
    const proposal = prepareMobileQueuePlanV2({
      seed: `${moment.logicalDate}:regular`,
      order: preparation.order,
      stateFingerprint: preparation.stateFingerprint,
      quotas: preparation.quotas,
      candidates: preparation.candidates,
    })
    return this.mutate(() => this.call('open_mobile_today_v2', { moment: { now: now.toISOString(), ...moment, cutoffHour: preferences.cutoffHour }, proposal }))
  }

  stageAnswer(request: StudyStageAnswerRequest): Promise<StudySessionState> {
    return this.mutate(() => this.call('stage_mobile_study_answer', { request }))
  }

  async commitAnswer(request: StudyAnswerRequest): Promise<StudySessionState> {
    const input = await this.call<{
      stored: StoredReviewCardContract | null
      preferences: StudyPreferences
      fsrsCommitted: boolean
    }>('get_mobile_review_transition_input', { sessionId: request.sessionId, itemId: request.itemId, expectedVersion: request.expectedVersion })
    const proposal = input.fsrsCommitted ? null : prepareMobileReviewTransitionV2({
      stored: input.stored,
      answer: request.answer,
      now: new Date(),
      preferences: input.preferences,
      expectedVersion: request.expectedVersion,
      commandId: request.commandId,
    })
    return this.mutate(() => this.call('commit_mobile_study_answer_v2', { request, proposal }))
  }

  markTooEasy(request: StudyTooEasyRequest): Promise<StudySessionState> { return this.mutate(() => this.call('mark_mobile_study_too_easy', { request })) }

  async addExtraBatch(planId: string): Promise<StudySessionState> {
    const now = new Date()
    const preparation = await this.call<{
      seed: string
      order: StudyPreferences['queueOrder']
      stateFingerprint: string
      quotas: Array<{ planId: string; dailyNewLimit: number; dailyReviewLimit: number }>
      candidates: Array<{ lexemeKey: string; planId: string; kind: 'review' | 'new'; dueAt: string | null; rank: number | null }>
    }>('prepare_mobile_study_extra_batch', { planId, now: now.toISOString() })
    const proposal = prepareMobileQueuePlanV2(preparation)
    return this.mutate(() => this.call('add_mobile_study_extra_batch', { planId, now: now.toISOString(), proposal }))
  }

  syncSources(planId?: string): Promise<StudySourceSyncResult> { return this.mutate(() => this.call('sync_mobile_study_sources', { planId: planId ?? null })) }
  getPreferences(): Promise<StudyPreferences> { return this.call('get_mobile_study_preferences') }
  savePreferences(value: StudyPreferences): Promise<StudyPreferences> { return this.mutate(() => this.call('save_mobile_study_preferences', { value })) }
  listDictionaryCollections(): Promise<DictionaryCollection[]> { return this.call('list_mobile_dictionary_collections') }
  getDebugState(): Promise<StudyDebugState> { return this.call('get_mobile_study_debug_state') }
  setDeveloperMode(enabled: boolean): Promise<StudyDebugState> { return this.call('set_mobile_study_developer_mode', { enabled }) }
  deletePlan(planId: string, confirmationName: string, options: StudyDeletePlanOptions = { resetWordProgress: false }): Promise<void> {
    return this.mutate(() => this.call('delete_mobile_study_plan', { planId, confirmationName, resetWordProgress: options.resetWordProgress }))
  }
  resetAllProgress(confirmationToken: string): Promise<void> {
    return this.mutate(() => this.call('reset_mobile_study_progress', { confirmationToken }))
  }
  async forceNextStudyDay(confirmationToken: string): Promise<StudySessionState> {
    await this.call('force_mobile_next_study_day', { confirmationToken })
    return this.openToday()
  }

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await this.invokeCommand<T>(command, args) }
    catch (reason) { throw normalizePlatformError(reason) }
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = await action()
    this.dashboardCache.invalidate()
    return result
  }
}
