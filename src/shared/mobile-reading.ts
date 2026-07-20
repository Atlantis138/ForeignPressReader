import type {
  ArticleDetail,
  ImportProgress,
  ImportResult,
  LibraryApi,
  LibraryPreferences,
  LibraryState,
  ParsedPublicationPlan,
  PublicationDetail,
  PublicationSummary,
  ReaderPreferences,
  ReaderApi,
  ReadingPositionInput,
} from './types'
import type { MobileReaderServiceSlots } from './mobile-reader-services'

export interface EpubEntryInfo {
  path: string
  directory: boolean
  compressedBytes: number
  uncompressedBytes: number
}

export type BeginEpubImportResult =
  | { kind: 'cancelled' }
  | { kind: 'duplicate'; result: ImportResult }
  | {
      kind: 'ready'
      sessionId: string
      displayName: string
      bytes: number
      contentHash: string
      entries: EpubEntryInfo[]
    }

export interface MobileReadingClient {
  readonly library: LibraryApi
  readonly reader: ReaderApi
  readonly services: MobileReaderServiceSlots
  importPublication(): Promise<ImportResult | null>
  cancelImport(): Promise<void>
  onImportProgress(callback: (progress: ImportProgress) => void): () => void
  listPublications(): Promise<PublicationSummary[]>
  getLibraryState(): Promise<LibraryState>
  saveLibraryPreferences(preferences: LibraryPreferences): Promise<LibraryState>
  createCategory(name: string): Promise<LibraryState>
  renameCategory(categoryId: string, name: string): Promise<LibraryState>
  deleteCategory(categoryId: string): Promise<LibraryState>
  renamePublication(publicationId: string, title: string): Promise<LibraryState>
  assignPublications(publicationIds: string[], categoryId: string | null): Promise<LibraryState>
  deletePublications(publicationIds: string[]): Promise<LibraryState>
  getPublication(publicationId: string): Promise<PublicationDetail>
  getArticle(articleId: string): Promise<ArticleDetail>
  savePosition(publicationId: string, articleId: string, position: ReadingPositionInput): Promise<void>
  getPreferences(): Promise<ReaderPreferences>
  savePreferences(preferences: ReaderPreferences): Promise<ReaderPreferences>
}

export interface ParseWorkerRequest {
  type: 'parse'
  sessionId: string
  contentHash: string
  entries: EpubEntryInfo[]
}

export type ParseWorkerMessage =
  | { type: 'read'; requestId: number; archivePath: string }
  | { type: 'result'; plan: ParsedPublicationPlan }
  | { type: 'error'; message: string }

export type ParseWorkerResponse =
  | ParseWorkerRequest
  | { type: 'entry'; requestId: number; text?: string; error?: string }
