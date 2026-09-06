import type { ReaderRecord } from './reader-records'
export interface PortableSettingRecord {
  key: string
  value: string
  updatedAt: string
  deviceId: string
}

export interface PortableReadingPositionRecord {
  publicationId: string
  articleId: string
  scrollTop: number
  anchorBlockId: string | null
  anchorTokenIndex: number | null
  anchorFraction: number
  updatedAt: string
  deviceId: string
}

export interface PortablePublicationLifecycleRecord {
  publicationId: string
  contentHash: string
  formatId: string
  titleSnapshot: string
  state: 'present' | 'deleted'
  changedAt: string
  deviceId: string
}

export interface PortableUserLexemeRecord {
  lexemeKey: string
  lemmaSnapshot: string
  phoneticSnapshot: string | null
  briefMeaningsJson: string
  senseGroupsJson: string
  bncRank: number | null
  frequencyRank: number | null
  manualState: 'unrated' | 'learning' | 'known' | 'ignored'
  manualFamiliarity: number | null
  createdAt: string
  updatedAt: string
  deviceId: string
  snapshotProvider: 'ecdict' | 'baidu'
  snapshotQuality: number
}

export interface PortableLexemeExampleRecord {
  exampleId: string
  lexemeKey: string
  text: string
  translationZh: string | null
  partOfSpeech: string | null
  definition: string | null
  providerId: 'ecdict' | 'baidu'
  position: number
  createdAt: string
  updatedAt: string
  deviceId: string
}

export interface PortableStudyPlanRecord {
  planId: string
  name: string
  status: 'active' | 'paused' | 'archived'
  dailyNewLimit: number
  dailyReviewLimit: number
  newOrder: 'reader_first_frequency' | 'deterministic_random'
  createdAt: string
  updatedAt: string
  deviceId: string
  deletedAt: string | null
}

export interface PortableStudyPlanSourceRecord {
  sourceId: string
  planId: string
  sourceType: 'reader_manual' | 'exam_collection'
  sourceRef: string
  active: boolean
  addedAt: string
  removedAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableStudyPlanOriginRecord {
  originId: string
  planId: string
  planSourceId: string
  lexemeKey: string
  active: boolean
  discoveredAt: string
  removedAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableStudyPlanExclusionRecord {
  planId: string
  lexemeKey: string
  excluded: boolean
  excludedAt: string | null
  restoredAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableSchedulerProfileRecord {
  profileId: string
  fsrsVersion: string
  parametersJson: string
  parametersHash: string
  createdAt: string
}

export interface PortableReviewCardRecord {
  lexemeKey: string
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
  updatedAt: string
  deviceId: string
}

export interface PortableReviewEventRecord {
  eventId: string
  commandId: string
  lexemeKey: string
  planId: string | null
  answer: 'known' | 'unknown'
  rating: number
  profileId: string
  preCardJson: string
  postCardJson: string
  logJson: string
  reviewedAt: string
  deviceId: string
}

export interface PortableReinforcementEventRecord {
  eventId: string
  commandId: string
  lexemeKey: string
  planId: string | null
  answer: 'known' | 'unknown' | 'too_easy'
  consecutiveBefore: number
  consecutiveAfter: number
  createdAt: string
  deviceId: string
}

export interface PortableReviewSuspensionRecord {
  lexemeKey: string
  active: boolean
  reason: string
  suspendedAt: string
  restoredAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableStudyProgressStateRecord {
  stateId: 'global'
  resetAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableStudyLexemeResetRecord {
  lexemeKey: string
  resetAt: string
  updatedAt: string
  deviceId: string
}

export interface PortableVocabularySourceRecord {
  sourceId: string
  lexemeKey: string
  sourceType: string
  sourceRef: string
  active: boolean
  addedAt: string
  removedAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableSavedContextRecord {
  contextId: string
  lexemeKey: string
  surface: string
  publicationId: string | null
  publicationTitle: string
  articleId: string | null
  articleTitle: string
  blockId: string | null
  tokenIndex: number
  sentence: string
  paragraph: string
  sentenceHash: string
  active: boolean
  savedAt: string
  removedAt: string | null
  updatedAt: string
  deviceId: string
}

export interface PortableUserData {
  readerRecords?: ReaderRecord[]
  publicationLifecycle: PortablePublicationLifecycleRecord[]
  settings: PortableSettingRecord[]
  readingPositions: PortableReadingPositionRecord[]
  userLexemes: PortableUserLexemeRecord[]
  lexemeExamples: PortableLexemeExampleRecord[]
  vocabularySources: PortableVocabularySourceRecord[]
  savedContexts: PortableSavedContextRecord[]
  studyPlans: PortableStudyPlanRecord[]
  studyPlanSources: PortableStudyPlanSourceRecord[]
  studyPlanOrigins: PortableStudyPlanOriginRecord[]
  studyPlanExclusions: PortableStudyPlanExclusionRecord[]
  schedulerProfiles: PortableSchedulerProfileRecord[]
  reviewCards: PortableReviewCardRecord[]
  reviewEvents: PortableReviewEventRecord[]
  reinforcementEvents: PortableReinforcementEventRecord[]
  reviewSuspensions: PortableReviewSuspensionRecord[]
  studyProgressState: PortableStudyProgressStateRecord[]
  studyLexemeResets: PortableStudyLexemeResetRecord[]
}

export const PORTABLE_DATASET_KEYS = [
  'readerRecords',
  'publicationLifecycle',
  'settings',
  'readingPositions',
  'userLexemes',
  'lexemeExamples',
  'vocabularySources',
  'savedContexts',
  'studyPlans',
  'studyPlanSources',
  'studyPlanOrigins',
  'studyPlanExclusions',
  'schedulerProfiles',
  'studyProgressState',
  'studyLexemeResets',
  'reviewCards',
  'reviewEvents',
  'reinforcementEvents',
  'reviewSuspensions',
] as const

export type PortableDatasetKey = typeof PORTABLE_DATASET_KEYS[number]
export type PortableDatasetRecord = NonNullable<PortableUserData[PortableDatasetKey]>[number]

export interface PortableBookRecord {
  publicationId: string
  hash: string
  title: string
  formatId: string
  importedAt: string
}

export interface PortableMergeResult {
  publicationLifecycle: number
  settings: number
  readingPositions: number
  vocabulary: number
  vocabularySources: number
  savedContexts: number
  studyPlans: number
  reviewCards: number
  reviewEvents: number
  reinforcementEvents: number
  reviewSuspensions: number
  studyLexemeResets: number
}

export type PortableMergePolicy = 'newer-wins' | 'incoming-wins'

export function compareVersionedRecord(
  left: { updatedAt: string; deviceId: string },
  right: { updatedAt: string; deviceId: string },
): number {
  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)
  const time = Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? Math.sign(leftTime - rightTime)
    : left.updatedAt.localeCompare(right.updatedAt)
  return time || left.deviceId.localeCompare(right.deviceId)
}
