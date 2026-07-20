import type { SqliteApplicationRepository } from './database'

/** Narrow database capabilities consumed outside SQLite repository code. */
export type PortableDataRepository = Pick<SqliteApplicationRepository,
  | 'clearPublicationLifecycleForRestore'
  | 'createSafetyBackup'
  | 'beginPortableMerge'
  | 'commitPortableMerge'
  | 'exportPortableUserData'
  | 'findPublicationIdByHash'
  | 'getPublicationLifecycle'
  | 'getPublicationLifecycleByHash'
  | 'getSchemaStatus'
  | 'getParsedPublicationPlan'
  | 'listPortableBooks'
  | 'iteratePortableDataset'
  | 'mergePortableUserData'
  | 'rollbackPortableMerge'
  | 'shouldAcceptPublicationLifecycle'
>

export type SyncDataRepository = Pick<SqliteApplicationRepository,
  | 'applyIncomingSyncData'
  | 'clearPublicationLifecycleForRestore'
  | 'exportPortableUserData'
  | 'findPublicationIdByHash'
  | 'getDeviceId'
  | 'getSyncPeerState'
  | 'getSyncRevision'
  | 'hasSyncReceipt'
  | 'getParsedPublicationPlan'
  | 'listPortableBooks'
  | 'listSyncEntityRevisions'
  | 'saveSyncPeerState'
>

export type DatabaseConnectionHost = Pick<SqliteApplicationRepository, 'getConnection' | 'getDeviceId'>
export type StudyDatabase = DatabaseConnectionHost & Pick<SqliteApplicationRepository,
  'listLexemeExamples' | 'saveLexemeExamples'
>
export type VocabularyDatabase = Pick<SqliteApplicationRepository,
  | 'getLookupContext'
  | 'getReaderVocabularyState'
  | 'listSavedContexts'
  | 'listVocabularyFavorites'
  | 'removeManualFavorite'
  | 'setVocabularyContext'
  | 'setVocabularyFavorite'
>
export type StorageDatabase = Pick<SqliteApplicationRepository, 'getConnection'>
export type DeveloperDatabase = Pick<SqliteApplicationRepository, 'getConnection' | 'getDeviceId'>
