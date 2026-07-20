import type {
  DictionaryApi,
  DictionaryInstallProgress,
  DictionaryLocalProfile,
  DictionaryLookupRequest,
  DictionaryLookupResult,
  DictionaryProviderId,
  DictionarySearchPage,
  DictionarySenseGroup,
  DictionaryStatus,
  LexemeDetail,
  LexemeKey,
  ManualLearningState,
  ReaderVocabularyState,
  SavedContextPage,
  StudyApi,
  VocabularyApi,
  VocabularyListPage,
  VocabularyListQuery,
} from './types'

export const MOBILE_LEARNING_CONTRACT_VERSION = 1 as const

export type MobileLearningErrorCode =
  | 'dictionaryNotInstalled'
  | 'dictionaryPackInvalid'
  | 'dictionaryPackIncompatible'
  | 'dictionaryInstallCancelled'
  | 'dictionaryQueryCancelled'
  | 'dictionaryStorageFull'
  | 'lexemeAmbiguous'
  | 'learningEntityMissing'
  | 'learningVersionConflict'
  | 'learningCommandReplay'
  | 'learningDatabaseUnavailable'

export type MobileLearningDataCategory =
  | 'userData'
  | 'deviceSession'
  | 'regenerableResource'
  | 'cache'
  | 'diagnostic'

export const MOBILE_LEARNING_DATA_POLICY = {
  dictionaryPacks: 'regenerableResource',
  dictionaryQueryCache: 'cache',
  userLexemesAndContexts: 'userData',
  plansCardsAndEvents: 'userData',
  activeStudySession: 'deviceSession',
  diagnosticLogs: 'diagnostic',
} as const satisfies Record<string, MobileLearningDataCategory>

export interface DictionaryPackManifest {
  formatVersion: 1
  resourceSchemaVersion: 4
  profile: 'standard-v1'
  datasetRevision: string
  entryCount: number
  formCount: number
  fileBytes: number
  sha256: string
  lexemeMapHash: string
}

export interface MobileDictionaryPackStatus {
  installed: boolean
  profile: 'standard-v1' | null
  datasetRevision: string | null
  entryCount: number
  formCount: number
  lexemeMapHash: string | null
}

export interface MobileDictionaryInstallResult {
  cancelled: boolean
  status: MobileDictionaryPackStatus
}

export interface MobileDictionaryClient {
  getDictionaryPackStatus(): Promise<MobileDictionaryPackStatus>
  selectAndInstallBasePack(): Promise<MobileDictionaryPackStatus | null>
  cancelDictionaryPackInstall(): Promise<void>
  removeBasePack(): Promise<void>
  lookupInContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<DictionaryLookupResult>
  getLexeme(lexemeKey: LexemeKey): Promise<LexemeDetail>
}

export interface MobileVocabularyClient {
  getReaderState(request: DictionaryLookupRequest, lexemeKey: LexemeKey): Promise<ReaderVocabularyState>
  setFavorite(request: DictionaryLookupRequest, lexemeKey: LexemeKey, favorite: boolean): Promise<ReaderVocabularyState>
  setContextSaved(request: DictionaryLookupRequest, lexemeKey: LexemeKey, saved: boolean): Promise<ReaderVocabularyState>
  listFavorites(query: VocabularyListQuery): Promise<VocabularyListPage>
  listContexts(lexemeKey: LexemeKey, offset?: number): Promise<SavedContextPage>
  removeFavorite(lexemeKey: LexemeKey): Promise<void>
}

export interface MobileDictionarySearchQuery {
  text: string
  offset: number
  limit: number
}

/** Read-only dictionary browsing capability. */
export interface MobileDictionaryBrowseClient {
  searchDictionary(query: MobileDictionarySearchQuery): Promise<DictionarySearchPage>
}

/** Explicit user-triggered upstream preload; never starts automatically. */
export interface MobileDictionaryOnlineInstallClient {
  installBasePackOnline(): Promise<MobileDictionaryPackStatus>
}

/** Formal Android dictionary and study-management contracts. */
export const MOBILE_DICTIONARY_CENTER_CONTRACT_VERSION = 1 as const
export const MOBILE_STUDY_MANAGEMENT_CONTRACT_VERSION = 1 as const

export type MobileDictionaryResourceHealth = 'missing' | 'checking' | 'ready' | 'damaged'
export type MobileDictionaryOnlineCacheStatus = 'disabled' | 'empty' | 'ready' | 'stale'

export interface MobileDictionaryInstallPreflight {
  profile: Exclude<DictionaryLocalProfile, 'none'>
  requiredBytes: number
  availableBytes: number
  canInstall: boolean
}

export interface MobileDictionaryCenterStatus extends DictionaryStatus {
  health: MobileDictionaryResourceHealth
  /** E2 reserves the product slot; provider networking and credentials remain an E4 capability. */
  onlineEnhancement: {
    available: false
    phase: 'reserved-e4'
    cacheStatus: MobileDictionaryOnlineCacheStatus
    updatedAt: string | null
  }
}

/** User-owned fallback fields retained when a regenerable dictionary pack is absent. */
export interface MobileLexemeSnapshot {
  lexemeKey: LexemeKey
  lemma: string
  phonetic: string | null
  briefMeanings: string[]
  senseGroups: DictionarySenseGroup[]
  frequency: { bnc: number | null; contemporary: number | null }
  providerId: DictionaryProviderId
}

interface MobileLexemeSourceState {
  localProfile: DictionaryLocalProfile
  favorite: boolean
  manualState: ManualLearningState
}

/** A detail can prefer the resource while carrying a user snapshot, or fall back to only that snapshot. */
export type MobileLexemeSource =
  | MobileLexemeSourceState & {
    source: 'resource'
    detail: LexemeDetail
    snapshot: MobileLexemeSnapshot | null
  }
  | MobileLexemeSourceState & {
    source: 'snapshot'
    detail: null
    snapshot: MobileLexemeSnapshot
  }

export type MobileDictionaryCenterApi =
  Pick<DictionaryApi,
    | 'lookup'
    | 'lookupInContext'
    | 'search'
    | 'listCollections'
    | 'getPreferences'
    | 'savePreferences'>
  & Pick<VocabularyApi,
    | 'getReaderState'
    | 'setFavorite'
    | 'setContextSaved'
    | 'listFavorites'
    | 'listContexts'
    | 'removeFavorite'>

/** Logical E2 client. It deliberately exposes no database path, SQL, resource URL or credential value. */
export interface MobileDictionaryCenterClient extends MobileDictionaryCenterApi {
  getStatus(): Promise<MobileDictionaryCenterStatus>
  getLexemeSource(lexemeKey: LexemeKey): Promise<MobileLexemeSource>
  cancelSearch(): Promise<void>
  preflightInstall(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<MobileDictionaryInstallPreflight>
  install(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<void>
  installFromLocal(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<boolean>
  repair(profile: Exclude<DictionaryLocalProfile, 'none'>): Promise<void>
  removeFullExtension(): Promise<void>
  cancelInstall(): Promise<void>
  remove(): Promise<void>
  onInstallProgress(callback: (progress: DictionaryInstallProgress) => void): () => void
}

export type MobileStudyManagementApi = Pick<StudyApi,
  | 'getDashboard'
  | 'listPlans'
  | 'createPlan'
  | 'updatePlan'
  | 'setPlanStatus'
  | 'getPlan'
  | 'listPlanWords'
  | 'setWordExcluded'
  | 'setWordSuspended'
  | 'listTodayWords'
  | 'openToday'
  | 'hydrateCurrentExamples'
  | 'stageAnswer'
  | 'commitAnswer'
  | 'markTooEasy'
  | 'addExtraBatch'
  | 'syncSources'
  | 'getPreferences'
  | 'savePreferences'>

/** Logical E3 client; answer sessions are device session data and are never shell-persisted. */
export interface MobileStudyManagementClient extends MobileStudyManagementApi {}

export interface StoredReviewCardContract {
  dueAt: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: number
  lastReviewAt: string | null
}

export interface MobileReviewTransitionProposal {
  contractVersion: 1
  engineVersion: 'fsrs-6/ts-fsrs-5.4.1/mobile-v1'
  expectedVersion: number
  commandId: string
  answer: 'known' | 'unknown'
  reviewedAt: string
  beforeFingerprint: string
  parametersFingerprint: string
  before: StoredReviewCardContract
  after: StoredReviewCardContract
  rating: 1 | 3
  log: Record<string, unknown>
}
