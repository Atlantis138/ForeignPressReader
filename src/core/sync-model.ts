export const LEGACY_SYNC_MODEL_VERSION = 1 as const
export const SYNC_MODEL_VERSION = 2 as const

export type SyncModelVersion = typeof LEGACY_SYNC_MODEL_VERSION | typeof SYNC_MODEL_VERSION
export type MergePolicy = 'newer-wins' | 'incoming-wins'
export type SyncBatchMode = 'snapshot' | 'incremental'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

/**
 * Stable logical entity names used by the sync model. These names are part of
 * the cross-platform contract and deliberately do not mirror SQLite tables.
 */
export type SyncEntityType =
  | 'publication-lifecycle'
  | 'setting'
  | 'reading-position'
  | 'user-lexeme'
  | 'lexeme-example'
  | 'vocabulary-source'
  | 'saved-context'
  | 'study-plan'
  | 'study-plan-source'
  | 'study-plan-origin'
  | 'study-plan-exclusion'
  | 'scheduler-profile'
  | 'review-card'
  | 'review-event'
  | 'reinforcement-event'
  | 'review-suspension'
  | 'study-progress-state'
  | 'study-lexeme-reset'

export interface SyncEntityRef<TType extends SyncEntityType = SyncEntityType> {
  type: TType
  key: string
  /** Monotonic revision in the database that produced this reference. */
  revision: number
}

export interface VersionedValueV1 {
  updatedAt: string
  deviceId: string
}

export interface PublicationLifecycleValueV1 {
  publicationId: string
  contentHash: string
  formatId: string
  title: string
  state: 'present' | 'deleted'
  changedAt: string
  deviceId: string
}

export interface SettingValueV1 extends VersionedValueV1 {
  key: string
  value: JsonValue
}

export interface ReadingPositionValueV1 extends VersionedValueV1 {
  publicationId: string
  articleId: string
  scrollTop: number
  blockId: string | null
  tokenIndex: number | null
  blockFraction: number | null
}

export interface UserLexemeValueV1 extends VersionedValueV1 {
  lexemeKey: string
  lemmaSnapshot: string
  phoneticSnapshot: string | null
  briefMeanings: JsonValue[]
  senseGroups: JsonValue[]
  bncRank: number | null
  frequencyRank: number | null
  manualState: 'unrated' | 'learning' | 'known' | 'ignored'
  manualFamiliarity: number | null
  createdAt: string
  snapshotProvider: 'ecdict'|'baidu'
  snapshotQuality: number
}

export interface LexemeExampleValueV1 extends VersionedValueV1 {
  exampleId:string;lexemeKey:string;text:string;translationZh:string|null;partOfSpeech:string|null
  definition:string|null;providerId:'ecdict'|'baidu';position:number;createdAt:string
}

export interface VocabularySourceValueV1 extends VersionedValueV1 {
  sourceId: string
  lexemeKey: string
  sourceType: string
  sourceRef: string
  active: boolean
  addedAt: string
  removedAt: string | null
}

export interface SavedContextValueV1 extends VersionedValueV1 {
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
}

export interface StudyPlanValueV1 extends JsonObject {
  planId:string; name:string; status:'active'|'paused'|'archived'; dailyNewLimit:number; dailyReviewLimit:number
  newOrder:'reader_first_frequency'|'deterministic_random'; createdAt:string; updatedAt:string; deviceId:string; deletedAt:string|null
}
export interface StudyPlanSourceValueV1 extends JsonObject {
  sourceId:string; planId:string; sourceType:'reader_manual'|'exam_collection'; sourceRef:string; active:boolean
  addedAt:string; removedAt:string|null; updatedAt:string; deviceId:string
}
export interface StudyPlanOriginValueV1 extends JsonObject {
  originId:string; planId:string; planSourceId:string; lexemeKey:string; active:boolean
  discoveredAt:string; removedAt:string|null; updatedAt:string; deviceId:string
}
export interface StudyPlanExclusionValueV1 extends JsonObject {
  planId:string; lexemeKey:string; excluded:boolean; excludedAt:string|null; restoredAt:string|null; updatedAt:string; deviceId:string
}
export interface SchedulerProfileValueV1 extends JsonObject {
  profileId:string; fsrsVersion:string; parametersJson:string; parametersHash:string; createdAt:string
}
export interface ReviewCardValueV1 extends JsonObject {
  lexemeKey:string; dueAt:string; stability:number; difficulty:number; elapsedDays:number; scheduledDays:number
  learningSteps:number; reps:number; lapses:number; state:number; lastReviewAt:string|null; updatedAt:string; deviceId:string
}
export interface ReviewEventValueV1 extends JsonObject {
  eventId:string; commandId:string; lexemeKey:string; planId:string|null; answer:'known'|'unknown'; rating:number
  profileId:string; preCardJson:string; postCardJson:string; logJson:string; reviewedAt:string; deviceId:string
}
export interface ReinforcementEventValueV1 extends JsonObject {
  eventId:string; commandId:string; lexemeKey:string; planId:string|null; answer:'known'|'unknown'|'too_easy'
  consecutiveBefore:number; consecutiveAfter:number; createdAt:string; deviceId:string
}
export interface ReviewSuspensionValueV1 extends JsonObject {
  lexemeKey:string; active:boolean; reason:string; suspendedAt:string; restoredAt:string|null; updatedAt:string; deviceId:string
}
export interface StudyProgressStateValueV1 extends JsonObject {
  stateId:'global'; resetAt:string|null; updatedAt:string; deviceId:string
}
export interface StudyLexemeResetValueV1 extends JsonObject {
  lexemeKey:string; resetAt:string; updatedAt:string; deviceId:string
}

export interface LogicalRecordEnvelopeV1<
  TType extends SyncEntityType,
  TValue,
> {
  type: TType
  key: string
  revision: number
  value: TValue
}

export type LogicalRecordV1 =
  | LogicalRecordEnvelopeV1<'publication-lifecycle', PublicationLifecycleValueV1>
  | LogicalRecordEnvelopeV1<'setting', SettingValueV1>
  | LogicalRecordEnvelopeV1<'reading-position', ReadingPositionValueV1>
  | LogicalRecordEnvelopeV1<'user-lexeme', UserLexemeValueV1>
  | LogicalRecordEnvelopeV1<'lexeme-example', LexemeExampleValueV1>
  | LogicalRecordEnvelopeV1<'vocabulary-source', VocabularySourceValueV1>
  | LogicalRecordEnvelopeV1<'saved-context', SavedContextValueV1>
  | LogicalRecordEnvelopeV1<'study-plan', StudyPlanValueV1>
  | LogicalRecordEnvelopeV1<'study-plan-source', StudyPlanSourceValueV1>
  | LogicalRecordEnvelopeV1<'study-plan-origin', StudyPlanOriginValueV1>
  | LogicalRecordEnvelopeV1<'study-plan-exclusion', StudyPlanExclusionValueV1>
  | LogicalRecordEnvelopeV1<'scheduler-profile', SchedulerProfileValueV1>
  | LogicalRecordEnvelopeV1<'review-card', ReviewCardValueV1>
  | LogicalRecordEnvelopeV1<'review-event', ReviewEventValueV1>
  | LogicalRecordEnvelopeV1<'reinforcement-event', ReinforcementEventValueV1>
  | LogicalRecordEnvelopeV1<'review-suspension', ReviewSuspensionValueV1>
  | LogicalRecordEnvelopeV1<'study-progress-state', StudyProgressStateValueV1>
  | LogicalRecordEnvelopeV1<'study-lexeme-reset', StudyLexemeResetValueV1>

export interface PublicationSourceBlobRefV1 {
  kind: 'publication-source'
  publicationId: string
  formatId: string
  sha256: string
  byteLength: number
  mediaType: string
}

export interface PublicationPackageBlobRefV2 {
  kind: 'publication-package'
  publicationId: string
  formatId: string
  /** Stable identity of the original imported publication bytes. */
  contentSha256: string
  /** Hash of the normalized package payload transported by this batch. */
  sha256: string
  byteLength: number
  mediaType: 'application/vnd.foreign-press-reader.publication+zip'
}

export type SyncBlobRef = PublicationSourceBlobRefV1 | PublicationPackageBlobRefV2

/** Summary produced by the receiver before the sender plans a batch. */
export interface SyncPeerSummaryV1 {
  modelVersion: typeof LEGACY_SYNC_MODEL_VERSION
  deviceId: string
  currentRevision: number
  /** Highest revision from this sender that the peer has committed. */
  lastAppliedSenderRevision: number
  /** Peer revision immediately before changedEntities was enumerated. */
  changedEntitiesSinceRevision: number
  changedEntities: SyncEntityRef[]
  availableBlobHashes: string[]
}

export interface SyncPeerSummaryV2 extends Omit<SyncPeerSummaryV1, 'modelVersion'> {
  modelVersion: typeof SYNC_MODEL_VERSION
}

export type SyncPeerSummary = SyncPeerSummaryV1 | SyncPeerSummaryV2

export interface SyncBatchV1 {
  modelVersion: typeof LEGACY_SYNC_MODEL_VERSION
  batchId: string
  senderDeviceId: string
  recipientDeviceId: string
  createdAt: string
  mode: SyncBatchMode
  /** Null for a first-contact snapshot. */
  fromSenderRevisionExclusive: number | null
  senderRevision: number
  /** Revision of the peer state inspected while constructing this batch. */
  inspectedPeerRevision: number | null
  records: LogicalRecordV1[]
  blobs: PublicationSourceBlobRefV1[]
}

export interface SyncBatchV2 extends Omit<SyncBatchV1, 'modelVersion' | 'blobs'> {
  modelVersion: typeof SYNC_MODEL_VERSION
  blobs: PublicationPackageBlobRefV2[]
}

export type SyncBatch = SyncBatchV1 | SyncBatchV2

export interface SyncApplyResult {
  batchId: string
  status: 'applied' | 'duplicate'
  appliedRecords: number
  unchangedRecords: number
  importedBlobs: number
  senderRevision: number
  localRevision: number
}
