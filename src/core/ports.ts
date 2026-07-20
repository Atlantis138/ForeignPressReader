import type {
  ArticleDetail,
  ContextDefinition,
  DictionaryPreferences,
  ParsedPublication,
  PublicationDetail,
  PublicationSummary,
  ReadingPositionInput,
  ReaderPreferences,
} from '../shared/types'

export interface ContentHasher {
  sha256(value: Uint8Array | string): string
}

export interface PublicationImporter {
  parse(data: Uint8Array): Promise<ParsedPublication>
  cancel?(): void
}

export interface LibraryRepository {
  findPublicationIdByHash(hash: string): string | null
  savePublication(publication: ParsedPublication, formatId?: string, firstImportedAt?: string): void
  listRetainedPublicationSources(): PublicationSourceCleanupCandidate[]
  markPublicationParsedOnly(publicationId: string): void
  listPublications(): PublicationSummary[]
  getPublication(id: string): PublicationDetail
  getArticle(id: string): ArticleDetail
  deletePublication(id: string): void
  deletePublications(ids: string[]): void
  purgePublications(ids: string[]): void
}

export interface PublicationSourceCleanupCandidate {
  publicationId: string
  contentHash: string
  sourcePath: string
  expectedArticleCount: number
  actualArticleCount: number
  expectedSectionCount: number
  actualSectionCount: number
  referencedAssetPaths: string[]
}

export interface ReaderStateRepository {
  savePosition(publicationId: string, articleId: string, position: ReadingPositionInput): void
  getPreferences(): ReaderPreferences
  savePreferences(preferences: ReaderPreferences): ReaderPreferences
  getDictionaryPreferences(): DictionaryPreferences
  saveDictionaryPreferences(preferences: DictionaryPreferences): DictionaryPreferences
}

export interface TranslationRepository {
  getArticle(id: string): ArticleDetail
  getTranslatableBlocks(articleId: string): Array<{ id: string; type: string; text: string; sourceHash: string }>
  hasTranslation(blockId: string, sourceHash: string, model: string, promptVersion: string): boolean
  saveTranslation(blockId: string, sourceHash: string, text: string, model: string, promptVersion: string): void
}

export interface ApiKeyStore {
  getApiKey(providerId?: string): Promise<string | null>
}

export interface ContextDefinitionRepository {
  getContextDefinition(cacheKey: string): ContextDefinition | null
}

export interface BinaryFileStore {
  read(path: string): Promise<Uint8Array>
  write(path: string, data: Uint8Array): Promise<void>
  copy(source: string, destination: string): Promise<void>
  remove(path: string): Promise<void>
}
