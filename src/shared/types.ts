export type BlockType =
  | 'title'
  | 'rubric'
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'caption'
  | 'list-item'
  | 'quote'

export interface ContentBlock {
  id: string
  type: BlockType
  position: number
  text: string | null
  html: string | null
  assetUrl: string | null
  alt: string | null
  translation: string | null
}

export interface ArticleSummary {
  id: string
  sectionId: string | null
  title: string
  rubric: string | null
  publishedAt: string | null
  position: number
  blockCount: number
}

export interface SectionSummary {
  id: string
  title: string
  position: number
  articles: ArticleSummary[]
}

export interface PublicationSummary {
  id: string
  title: string
  originalTitle: string
  categoryId: string | null
  creator: string | null
  language: string | null
  coverUrl: string | null
  coverThumbnailUrl: string | null
  coverThumbnailWidth: number | null
  coverThumbnailHeight: number | null
  importedAt: string
  articleCount: number
  sectionCount: number
  lastArticleId: string | null
}

export interface LibraryCategory {
  id: string
  name: string
  createdAt: string
}

export type LibraryViewMode = 'grid' | 'list'
export type LibrarySortBy = 'name' | 'importedAt'
export type LibrarySortDirection = 'asc' | 'desc'

export interface LibraryPreferences {
  viewMode: LibraryViewMode
  sortBy: LibrarySortBy
  sortDirection: LibrarySortDirection
  activeCategoryId: string
}

export interface LibraryState {
  publications: PublicationSummary[]
  categories: LibraryCategory[]
  preferences: LibraryPreferences
}

export interface PublicationDetail extends PublicationSummary {
  sections: SectionSummary[]
  unsectionedArticles: ArticleSummary[]
}

export interface ReadingPositionInput {
  scrollTop: number
  anchorBlockId: string | null
  anchorTokenIndex: number | null
  anchorFraction: number
}

export interface ReadingPositionSnapshot extends ReadingPositionInput {}

export interface ArticleDetail extends ArticleSummary {
  publicationId: string
  publicationTitle: string
  sectionTitle: string | null
  blocks: ContentBlock[]
  savedPosition: ReadingPositionSnapshot
}

export interface ImportResult {
  publication: PublicationDetail
  duplicate: boolean
}

export interface ImportProgress {
  stage: 'reading' | 'parsing' | 'writing' | 'completed' | 'cancelled' | 'error'
  completed: number
  total: number
  message?: string
}

export type ReaderTheme = 'light' | 'dark'

export interface ReaderPreferences {
  theme: ReaderTheme
  fontSize: number
  lineHeight: number
  columnWidth: number
  paperTint: number
}

export type SpeechLocale = 'en-US' | 'en-GB'
// Provider IDs are registry-owned so adding a remote adapter does not require editing shared unions.
export type SpeechProviderId = string
export type RemoteSpeechProviderId = string
export type SpeechUsage = 'word' | 'article'

export interface SpeechProviderSetting {
  modelId: string
  voiceId: string
}

export interface SpeechPreferences {
  locale: SpeechLocale
  voiceId: string | null
  providerSettings: Record<RemoteSpeechProviderId, SpeechProviderSetting>
  rate: number
  autoPlayStudy: boolean
  wordProviderId: SpeechProviderId
  articleProviderId: SpeechProviderId
}

export interface SpeechVoice {
  id: string
  name: string
  lang: string
  default: boolean
  local: boolean
}

export type SpeechPlaybackStatus = 'idle' | 'playing' | 'paused' | 'error'

export interface SpeechPlaybackState {
  status: SpeechPlaybackStatus
  sourceId: string | null
  itemId: string | null
  index: number
  total: number
  error: string | null
}

export interface KeyStatus {
  configured: boolean
  masked: string | null
}

export interface SpeechProviderOption {
  id: SpeechProviderId
  name: string
  description: string
  requiresApiKey: boolean
  keyStatus: KeyStatus
  models: SpeechModelOption[]
  voices: SpeechVoiceOption[]
}

export interface SpeechModelOption { id: string; name: string; description: string }
export interface SpeechVoiceOption { id: string; name: string; locales: SpeechLocale[] }

export interface SpeechSettings {
  preferences: SpeechPreferences
  providers: SpeechProviderOption[]
}

export interface SpeechSynthesisRequest {
  providerId: RemoteSpeechProviderId
  modelId: string
  text: string
  locale: SpeechLocale
  voiceId: string
  rate: number
}

export interface SpeechAudio {
  bytes: Uint8Array
  mimeType: 'audio/mpeg'
}

export interface TranslationModelOption {
  id: string
  name: string
  description: string
}

export interface TranslationProviderOption {
  id: string
  name: string
  keyStatus: KeyStatus
  models: TranslationModelOption[]
}

export interface TranslationPreferences {
  providerId: string
  modelId: string
}

export interface TranslationSettings {
  preferences: TranslationPreferences
  providers: TranslationProviderOption[]
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

export type TranslationStatus = 'started' | 'progress' | 'completed' | 'cancelled' | 'error'

export interface TranslationProgress {
  articleId: string
  completed: number
  total: number
  status: TranslationStatus
  message?: string
}

export interface TranslationResult {
  articleId: string
  translated: number
  total: number
  cached: boolean
}

export type DictionaryProviderId = 'ecdict' | 'baidu'
export type DictionaryLocalProfile = 'none' | 'standard' | 'full'

export interface DictionaryPreferences {
  enabled: boolean
  lookupProviderId: DictionaryProviderId
  fallbackToLocal: boolean
  contextExplanationEnabled: boolean
  translateExamples: boolean
}

export type DictionaryInstallStage =
  | 'downloading-dictionary'
  | 'downloading-lemma'
  | 'indexing-entries'
  | 'indexing-forms'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'error'

export interface DictionaryInstallProgress {
  stage: DictionaryInstallStage
  downloadedBytes: number
  totalBytes: number
  indexedEntries: number
  message?: string
}

export interface DictionaryPackStatus {
  installed: boolean
  installing: boolean
  version: string | null
  entryCount: number
  formCount: number
  sizeBytes: number
}

export interface DictionaryStatus {
  providerId: 'ecdict'
  installed: boolean
  baseInstalled: boolean
  fullExtensionInstalled: boolean
  extensionCompatible: boolean
  effectiveProfile: DictionaryLocalProfile
  installing: boolean
  base: DictionaryPackStatus
  full: DictionaryPackStatus
  version: string | null
  entryCount: number
  formCount: number
  sizeBytes: number
  source: string
  license: string
}

export interface DictionaryCredentialStatus {
  configured: boolean
  apiKey: KeyStatus
  secretKey: KeyStatus
}

export interface DictionaryLookupRequest {
  articleId: string
  blockId: string
  surface: string
  tokenIndex: number
}

export type LexemeKey = string

export interface LexemeCandidate {
  lexemeKey: LexemeKey
  lemma: string
  relation: 'exact' | 'inflection' | 'heuristic'
  confidence: number
  phonetic: string | null
  briefMeanings: string[]
}

export interface DictionarySenseGroup {
  partOfSpeech: string
  translations: string[]
  definitions: string[]
}

export interface DictionaryExample {
  exampleId: string
  text: string
  translationZh: string | null
  partOfSpeech: string | null
  definition: string | null
  providerId: DictionaryProviderId
}

export interface DictionaryEntryResult {
  word: string
  phonetic: string | null
  senses: DictionarySenseGroup[]
  positionWeights: string | null
  tags: string[]
  frequency: { bnc: number | null; contemporary: number | null }
  exchanges: string[]
}

export interface ContextDefinition {
  meaningZh: string
  partOfSpeech: string
  explanationZh: string
  phrase: string | null
  confidence: 'high' | 'medium' | 'low'
  cached: boolean
  basis?: 'selected-lexeme' | 'auto-candidates' | 'context-only'
  resolvedLexemeKey?: LexemeKey | null
  resolvedLemma?: string | null
}

export interface DictionaryLookupResult {
  surface: string
  normalized: string
  lemma: string
  sentence: string
  paragraph: string
  found: boolean
  entries: DictionaryEntryResult[]
  suggestions: string[]
  contextDefinition: ContextDefinition | null
  dictionaryVersion: string | null
  lexemeKey: LexemeKey | null
  candidates: LexemeCandidate[]
  requiresSelection: boolean
  requestedProviderId: DictionaryProviderId
  resolvedProviderId: DictionaryProviderId
  localProfile: DictionaryLocalProfile
  fallbackUsed: boolean
  examples: DictionaryExample[]
  metadata: {
    tags: string[]
    collections: DictionaryCollection[]
    oxford: boolean
    collins: number | null
    frequency: { bnc: number | null; contemporary: number | null }
    forms: string[]
  }
}

export type DictionarySearchSort = 'relevance' | 'frequency' | 'alphabetical'

export interface DictionarySearchQuery {
  text: string
  tags: string[]
  tagMatch: 'any' | 'all'
  oxfordOnly: boolean
  collinsMin: number | null
  bncMax: number | null
  contemporaryMax: number | null
  sort: DictionarySearchSort
  offset: number
  limit: number
}

export interface DictionarySearchItem {
  lexemeKey: LexemeKey
  lemma: string
  phonetic: string | null
  briefMeanings: string[]
  tags: string[]
  collins: number | null
  oxford: boolean
  frequency: { bnc: number | null; contemporary: number | null }
  matchedBy: 'lemma' | 'form' | 'translation' | 'filter'
}

export interface DictionarySearchPage {
  items: DictionarySearchItem[]
  total: number
  offset: number
  limit: number
}

export interface DictionaryCollection {
  id: string
  tag: string
  name: string
  count: number
}
export interface DictionaryLearningItem {
  lexemeKey: LexemeKey
  lemma: string
  phonetic: string | null
  briefMeanings: string[]
  senses: DictionarySenseGroup[]
  bnc: number | null
  frequency: number | null
}
export interface DictionaryLearningPage { items: DictionaryLearningItem[]; total: number; offset: number; limit: number }

export interface LexemeDetail extends DictionarySearchItem {
  entries: DictionaryEntryResult[]
  forms: string[]
  collections: DictionaryCollection[]
  providerId: DictionaryProviderId
  examples: DictionaryExample[]
  similarWords: string[]
}

export type ManualLearningState = 'unrated' | 'learning' | 'known' | 'ignored'

export interface ReaderVocabularyState {
  lexemeKey: LexemeKey
  favorite: boolean
  contextSaved: boolean
  manualState: ManualLearningState
}

export interface VocabularyListQuery {
  text: string
  offset: number
  limit: number
}

export interface VocabularyListItem {
  lexemeKey: LexemeKey
  lemma: string
  phonetic: string | null
  briefMeanings: string[]
  manualState: ManualLearningState
  addedAt: string
}

export interface VocabularyListPage {
  items: VocabularyListItem[]
  offset: number
  limit: number
  total: number
}

export interface SavedContextItem {
  contextId: string
  publicationId: string | null
  publicationTitle: string
  articleId: string | null
  articleTitle: string
  sentence: string
  surface: string
  paragraph: string
  savedAt: string
}

export interface SavedContextPage {
  items: SavedContextItem[]
  offset: number
  limit: number
  total: number
}

export type StudyPlanStatus = 'active' | 'paused' | 'archived'
export type StudySourceType = 'reader_manual' | 'exam_collection'
export type StudyQueueOrder = 'mixed' | 'review_first' | 'new_first'
export type StudyWordFilter = 'all' | 'due' | 'unseen' | 'learning' | 'consolidating' | 'mature' | 'suspended' | 'excluded'
export type StudySourceSyncStatus = 'pending' | 'syncing' | 'ready' | 'error'

export interface StudyPlanSourceInput { type: StudySourceType; ref: string }
export interface StudyPlanInput {
  name: string
  dailyNewLimit: number
  dailyReviewLimit: number
  sources: StudyPlanSourceInput[]
}
export interface StudyDeletePlanOptions {
  resetWordProgress: boolean
}
export interface StudyPlanSummary {
  planId: string
  name: string
  status: StudyPlanStatus
  dailyNewLimit: number
  dailyReviewLimit: number
  wordCount: number
  dueCount: number
  excludedCount: number
  availableNewCount: number
  syncStatus: StudySourceSyncStatus
  sourceLabels: string[]
  createdAt: string
}
export interface StudyDistribution { unseen: number; learning: number; consolidating: number; mature: number; suspended: number }
export interface StudyPlanDetail extends StudyPlanSummary {
  sources: Array<StudyPlanSourceInput & { sourceId: string; active: boolean; syncStatus: StudySourceSyncStatus; memberCount: number; lastSyncedAt: string | null; syncError: string | null }>
  distribution: StudyDistribution
}
export interface StudyPlanWordQuery { text: string; filter: StudyWordFilter; offset: number; limit: number }
export interface StudyPlanWord {
  lexemeKey: LexemeKey
  lemma: string
  phonetic: string | null
  meanings: string[]
  sources: string[]
  excluded: boolean
  suspended: boolean
  state: 'unseen' | 'learning' | 'consolidating' | 'mature' | 'suspended'
  difficulty: number | null
  stability: number | null
  retrievability: number | null
  dueAt: string | null
  scheduledDays: number | null
  reps: number
  lapses: number
  lastReviewAt: string | null
}
export interface StudyPlanWordPage { items: StudyPlanWord[]; total: number; offset: number; limit: number }
export interface StudyPreferences { cutoffHour: number; requestRetention: number; maximumInterval: number; queueOrder: StudyQueueOrder }
export interface StudyTodayWord {
  itemId: string; lexemeKey: LexemeKey; lemma: string; phonetic: string | null; meanings: string[]
  kind: 'new' | 'review' | 'carryover'; firstAnswer: 'known' | 'unknown' | 'too_easy' | null
  finalAnswer: 'known' | 'unknown' | 'too_easy' | null
  attemptCount: number; unknownCount: number; tooEasy: boolean; completed: boolean
  context: { articleTitle: string; sentence: string } | null
  examples: DictionaryExample[]
}
export type StudyTodayWordFilter = 'all' | 'new' | 'review' | 'known' | 'unknown' | 'too_easy'
export interface StudyTodayWordPage { items: StudyTodayWord[]; total: number; offset: number; limit: number }
export interface StudyTodaySummary {
  sessionId: string; logicalDate: string; status: 'active' | 'completed'; completed: number; total: number
  newCount: number; reviewCount: number; carryoverCount: number; unknownCount: number; tooEasyCount: number
  extraBatchCount: number; openedAt: string; completedAt: string | null; durationSeconds: number; nextRolloverAt: string; recentWords: StudyTodayWord[]
}
export interface StudyDashboard {
  plans: StudyPlanSummary[]
  today: StudyTodaySummary | null
  preview: { newCount: number; reviewCount: number }
  developerMode: boolean
}
export interface StudyCardView {
  itemId: string
  kind: 'new' | 'review' | 'carryover'
  version: number
  lexemeKey: LexemeKey
  lemma: string
  phonetic: string | null
  senseGroups: DictionarySenseGroup[]
  briefMeanings: string[]
  context: SavedContextItem | null
  examples: DictionaryExample[]
  revealed: boolean
  proposedAnswer: 'known' | 'unknown' | null
  hadFailure: boolean
  consecutiveKnown: number
  attemptCount: number
  canMarkTooEasy: boolean
}
export interface StudySessionState {
  sessionId: string
  logicalDate: string
  status: 'active' | 'completed'
  current: StudyCardView | null
  completed: number
  total: number
  remaining: number
  extraBatchCount: number
}
export interface StudyAnswerRequest {
  sessionId: string
  itemId: string
  commandId: string
  expectedVersion: number
  answer: 'known' | 'unknown'
}
export interface StudyStageAnswerRequest { sessionId: string; itemId: string; expectedVersion: number; answer: 'known' | 'unknown' }
export interface StudyTooEasyRequest { sessionId: string; itemId: string; commandId: string; expectedVersion: number }
export interface StudyTodayWordQuery { filter: StudyTodayWordFilter; offset: number; limit: number }
export interface StudySourceSyncResult { syncedSources: number; failedSources: number }
export interface StudyDebugState { enabled: boolean; lastResetAt: string | null }

export type DataTransferStage =
  | 'preparing'
  | 'validating'
  | 'exporting'
  | 'importing-books'
  | 'merging-data'
  | 'completed'
  | 'cancelled'
  | 'error'

export interface DataTransferProgress {
  operation: 'export' | 'import'
  stage: DataTransferStage
  completedBytes: number
  totalBytes: number
  message?: string
}

export interface DataStatus {
  schemaVersion: number
  formatVersion: number
  publicationCount: number
  vocabularyCount: number
}

export interface PortableImportPreview {
  token: string
  fileName: string
  totalBytes: number
  publicationCount: number
  newPublicationCount: number
  duplicatePublicationCount: number
  settingCount: number
  readingPositionCount: number
  vocabularyCount: number
  vocabularySourceCount: number
  savedContextCount: number
  studyPlanCount: number
  reviewCardCount: number
  reviewEventCount: number
  reinforcementEventCount: number
  suspendedWordCount: number
  createdAt: string
}

export interface PortableTransferResult {
  fileName: string
  bytes: number
  importedPublications?: number
  duplicatePublications?: number
  mergedSettings?: number
  mergedReadingPositions?: number
  mergedVocabulary?: number
  mergedVocabularySources?: number
  mergedSavedContexts?: number
  mergedStudyPlans?: number
  mergedReviewCards?: number
  mergedReviewEvents?: number
  mergedReinforcementEvents?: number
  mergedReviewSuspensions?: number
}

export type StorageCategoryId = 'necessary' | 'resources' | 'user-data' | 'cache'
export interface StorageEntry { id: string; label: string; bytes: number; clearable: boolean }
export interface StorageCategoryReport {
  id: StorageCategoryId
  label: string
  bytes: number
  clearable: boolean
  entries: StorageEntry[]
}
export interface StorageReport {
  scannedAt: string
  totalBytes: number
  packaged: boolean
  categories: StorageCategoryReport[]
}
export interface CacheClearResult { clearedBytes: number; report: StorageReport }
export interface DeveloperState {
  enabled: boolean
  loggingEnabled: boolean
  logBytes: number
  logFileCount: number
  lastStudyResetAt: string | null
}

export interface LibraryApi {
  importPublication(): Promise<ImportResult | null>
  cancelImport(): Promise<void>
  onImportProgress(callback: (progress: ImportProgress) => void): () => void
  listPublications(): Promise<PublicationSummary[]>
  getState(): Promise<LibraryState>
  savePreferences(preferences: LibraryPreferences): Promise<LibraryState>
  createCategory(name: string): Promise<LibraryState>
  renameCategory(categoryId: string, name: string): Promise<LibraryState>
  deleteCategory(categoryId: string): Promise<LibraryState>
  renamePublication(publicationId: string, title: string): Promise<LibraryState>
  assignPublications(publicationIds: string[], categoryId: string | null): Promise<LibraryState>
  deletePublications(publicationIds: string[]): Promise<LibraryState>
  getPublication(id: string): Promise<PublicationDetail>
}

export interface ReaderApi {
  getArticle(id: string): Promise<ArticleDetail>
  savePosition(publicationId: string, articleId: string, position: ReadingPositionInput): Promise<void>
  getPreferences(): Promise<ReaderPreferences>
  savePreferences(preferences: ReaderPreferences): Promise<ReaderPreferences>
}

export interface SpeechApi {
  getPreferences(): Promise<SpeechPreferences>
  savePreferences(preferences: SpeechPreferences): Promise<SpeechPreferences>
  getSettings(): Promise<SpeechSettings>
  saveProviderKey(providerId: RemoteSpeechProviderId, key: string): Promise<SpeechSettings>
  deleteProviderKey(providerId: RemoteSpeechProviderId): Promise<SpeechSettings>
  testConnection(providerId: RemoteSpeechProviderId): Promise<ConnectionTestResult>
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechAudio>
}

export interface TranslationApi {
  translateArticle(articleId: string): Promise<TranslationResult>
  cancel(articleId: string): Promise<void>
  onProgress(callback: (progress: TranslationProgress) => void): () => void
}

export interface SettingsApi {
  getTranslationSettings(): Promise<TranslationSettings>
  saveTranslationPreferences(preferences: TranslationPreferences): Promise<TranslationSettings>
  saveProviderKey(providerId: string, key: string): Promise<TranslationSettings>
  deleteProviderKey(providerId: string): Promise<TranslationSettings>
  testTranslationConnection(preferences: TranslationPreferences): Promise<ConnectionTestResult>
  openDataDirectory(): Promise<void>
}

export interface DictionaryApi {
  getStatus(): Promise<DictionaryStatus>
  install(profile?: Exclude<DictionaryLocalProfile, 'none'>): Promise<void>
  installFromLocal(profile?: Exclude<DictionaryLocalProfile, 'none'>): Promise<boolean>
  removeFullExtension(): Promise<void>
  cancelInstall(): Promise<void>
  remove(): Promise<void>
  lookup(request: DictionaryLookupRequest): Promise<DictionaryLookupResult>
  lookupInContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<DictionaryLookupResult>
  explainContext(request: DictionaryLookupRequest, preferredLexemeKey?: LexemeKey): Promise<ContextDefinition>
  search(query: DictionarySearchQuery): Promise<DictionarySearchPage>
  getLexeme(lexemeKey: LexemeKey): Promise<LexemeDetail>
  listCollections(): Promise<DictionaryCollection[]>
  getPreferences(): Promise<DictionaryPreferences>
  savePreferences(preferences: DictionaryPreferences): Promise<DictionaryPreferences>
  getCredentialStatus(): Promise<DictionaryCredentialStatus>
  saveBaiduCredentials(apiKey: string, secretKey: string): Promise<ConnectionTestResult>
  deleteBaiduCredentials(): Promise<void>
  testBaiduConnection(): Promise<ConnectionTestResult>
  onInstallProgress(callback: (progress: DictionaryInstallProgress) => void): () => void
}

export interface VocabularyApi {
  getReaderState(request: DictionaryLookupRequest, lexemeKey: LexemeKey): Promise<ReaderVocabularyState>
  setFavorite(request: DictionaryLookupRequest, lexemeKey: LexemeKey, favorite: boolean): Promise<ReaderVocabularyState>
  setContextSaved(request: DictionaryLookupRequest, lexemeKey: LexemeKey, saved: boolean): Promise<ReaderVocabularyState>
  listFavorites(query: VocabularyListQuery): Promise<VocabularyListPage>
  listContexts(lexemeKey: LexemeKey, offset?: number): Promise<SavedContextPage>
  removeFavorite(lexemeKey: LexemeKey): Promise<void>
}

export interface StudyApi {
  getDashboard(): Promise<StudyDashboard>
  listPlans(includeArchived?: boolean): Promise<StudyPlanSummary[]>
  createPlan(input: StudyPlanInput): Promise<StudyPlanDetail>
  updatePlan(planId: string, input: StudyPlanInput): Promise<StudyPlanDetail>
  setPlanStatus(planId: string, status: StudyPlanStatus): Promise<void>
  getPlan(planId: string): Promise<StudyPlanDetail>
  listPlanWords(planId: string, query: StudyPlanWordQuery): Promise<StudyPlanWordPage>
  setWordExcluded(planId: string, lexemeKey: LexemeKey, excluded: boolean): Promise<void>
  setWordSuspended(lexemeKey: LexemeKey, suspended: boolean): Promise<void>
  listTodayWords(sessionId: string, query: StudyTodayWordQuery): Promise<StudyTodayWordPage>
  openToday(): Promise<StudySessionState>
  hydrateCurrentExamples(request: { sessionId: string; itemId: string; expectedVersion: number }): Promise<DictionaryExample[]>
  stageAnswer(request: StudyStageAnswerRequest): Promise<StudySessionState>
  commitAnswer(request: StudyAnswerRequest): Promise<StudySessionState>
  markTooEasy(request: StudyTooEasyRequest): Promise<StudySessionState>
  addExtraBatch(planId: string): Promise<StudySessionState>
  syncSources(planId?: string): Promise<StudySourceSyncResult>
  getPreferences(): Promise<StudyPreferences>
  savePreferences(value: StudyPreferences): Promise<StudyPreferences>
  getDebugState(): Promise<StudyDebugState>
  setDeveloperMode(enabled: boolean): Promise<StudyDebugState>
  deletePlan(planId: string, confirmationName: string, options?: StudyDeletePlanOptions): Promise<void>
  resetAllProgress(confirmationToken: string): Promise<void>
  forceNextStudyDay(confirmationToken: string): Promise<StudySessionState>
}

export interface DataApi {
  getStatus(): Promise<DataStatus>
  exportPortable(): Promise<PortableTransferResult | null>
  selectPortableImport(): Promise<PortableImportPreview | null>
  confirmPortableImport(token: string): Promise<PortableTransferResult>
  cancelTransfer(): Promise<void>
  onProgress(callback: (progress: DataTransferProgress) => void): () => void
}

export interface StorageApi {
  scan(): Promise<StorageReport>
  clearSafeCache(): Promise<CacheClearResult>
  clearAiTextCache(confirmationToken: string): Promise<CacheClearResult>
}

export type SyncDevicePlatform = 'windows' | 'android'
export type SyncDeviceReachability = 'verifying' | 'online' | 'unreachable' | 'offline' | 'identity-changed'

export interface SyncDeviceDiagnostic {
  code: 'port-in-use' | 'permission-denied' | 'firewall-or-unreachable' | 'https-unreachable' | 'identity-changed' | 'discovery-unavailable'
  message: string
}

export interface SyncDeviceSummary {
  deviceId: string
  name: string
  platform: SyncDevicePlatform
  trusted: boolean
  /** Derived compatibility field. Prefer reachability in new UI. */
  online: boolean
  reachability: SyncDeviceReachability
  diagnostic: SyncDeviceDiagnostic | null
  lastSeenAt: string
  certificateSha256: string
}

export interface SyncPairingState {
  sessionId: string
  direction: 'incoming' | 'outgoing'
  peer: SyncDeviceSummary
  code: string
  localConfirmed: boolean
  remoteConfirmed: boolean
  status: 'waiting' | 'paired' | 'rejected' | 'expired' | 'error'
  message: string | null
  expiresAt: string
}

export interface SyncTransferPreview {
  transferId: string
  sender: SyncDeviceSummary
  totalRecords: number
  newPublications: number
  updatedRecords: number
  deletedPublications: number
  missingBlobs: number
  totalBytes: number
  expiresAt: string
}

export interface SyncOperationState {
  operationId: string
  direction: 'sending' | 'receiving'
  peer: SyncDeviceSummary
  stage: 'verifying-device' | 'summarizing' | 'preparing' | 'uploading-batch' | 'waiting-confirmation' | 'uploading' | 'resumable' | 'applying' | 'completed' | 'cancelled' | 'error'
  message: string
  completedBytes: number
  totalBytes: number
  resumable: boolean
}

export interface SyncResumableTransferSummary {
  transferId: string
  direction: 'sending' | 'receiving'
  peer: SyncDeviceSummary
  completedBytes: number
  totalBytes: number
  updatedAt: string
  expiresAt: string
}

export interface SyncCompletedResult {
  direction: 'sending' | 'receiving'
  peerName: string
  completedAt: string
  appliedRecords: number
  unchangedRecords: number
  importedPublications: number
}

export interface SyncPageState {
  active: boolean
  localDevice: SyncDeviceSummary | null
  nearbyDevices: SyncDeviceSummary[]
  trustedDevices: SyncDeviceSummary[]
  pairing: SyncPairingState | null
  incoming: SyncTransferPreview | null
  operation: SyncOperationState | null
  resumableTransfers: SyncResumableTransferSummary[]
  lastCompleted: SyncCompletedResult | null
  diagnostic: string | null
}

export interface SyncApi {
  openPage(): Promise<SyncPageState>
  closePage(): Promise<void>
  getState(): Promise<SyncPageState>
  refreshDiscovery(): Promise<SyncPageState>
  startPairing(deviceId: string): Promise<SyncPageState>
  confirmPairing(sessionId: string): Promise<SyncPageState>
  rejectPairing(sessionId: string): Promise<SyncPageState>
  sendTo(deviceId: string): Promise<SyncPageState>
  acceptIncoming(transferId: string): Promise<SyncPageState>
  rejectIncoming(transferId: string): Promise<SyncPageState>
  cancelOperation(): Promise<SyncPageState>
  discardPendingTransfer(transferId: string): Promise<SyncPageState>
  revokeTrust(deviceId: string): Promise<SyncPageState>
}

export interface DeveloperApi {
  getState(): Promise<DeveloperState>
  setEnabled(enabled: boolean): Promise<DeveloperState>
  setLoggingEnabled(enabled: boolean): Promise<DeveloperState>
  openLogDirectory(): Promise<void>
  clearLogs(): Promise<DeveloperState>
  factoryReset(confirmationToken: string): Promise<void>
}

export interface AppApi {
  library: LibraryApi
  reader: ReaderApi
  speech: SpeechApi
  translation: TranslationApi
  settings: SettingsApi
  dictionary: DictionaryApi
  vocabulary: VocabularyApi
  study: StudyApi
  data: DataApi
  storage: StorageApi
  sync: SyncApi
  developer: DeveloperApi
}

export interface ParsedBlock {
  id: string
  sourceKey: string
  type: BlockType
  position: number
  text: string | null
  html: string | null
  assetPath: string | null
  alt: string | null
}

export interface ParsedArticle {
  id: string
  sourceKey: string
  title: string
  rubric: string | null
  publishedAt: string | null
  position: number
  sourceHref: string
  blocks: ParsedBlock[]
}

export interface ParsedSection {
  id: string
  sourceKey: string
  title: string
  position: number
  articles: ParsedArticle[]
}

export interface ParsedPublication {
  id: string
  hash: string
  sourceKey: string
  profileId: string
  title: string
  creator: string | null
  language: string | null
  coverPath: string | null
  sections: ParsedSection[]
  unsectionedArticles: ParsedArticle[]
  assets: Map<string, Uint8Array>
}

/** Serializable EPUB parse result used across platform process boundaries. */
export type ParsedPublicationPlan = Omit<ParsedPublication, 'assets'> & {
  assetPaths: string[]
}
