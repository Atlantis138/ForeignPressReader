import type {
  DictionaryCollection,
  DictionaryLookupRequest,
  DictionaryLearningPage,
  DictionarySearchPage,
  DictionarySearchQuery,
  LexemeCandidate,
  LexemeDetail,
  LexemeKey,
  ReaderVocabularyState,
  SavedContextPage,
  VocabularyListPage,
  VocabularyListQuery,
} from '../../shared/types'

export interface LexemeResolver {
  resolve(surface: string): Promise<LexemeCandidate[]>
}

export interface DictionaryLookupProvider {
  getLexeme(key: LexemeKey): Promise<LexemeDetail>
  version(): Promise<string>
  close(): Promise<void>
}

export interface DictionaryCatalogProvider {
  search(query: DictionarySearchQuery): Promise<DictionarySearchPage>
  listCollections(): Promise<DictionaryCollection[]>
  listCollectionMembers(tag: string, offset: number, limit?: number): Promise<DictionaryLearningPage>
}

export interface LexiconProvider extends LexemeResolver, DictionaryLookupProvider, DictionaryCatalogProvider {}

export interface VocabularyRepository {
  verifyContext(request: DictionaryLookupRequest): VocabularyContext
  getReaderState(context: VocabularyContext, lexemeKey: LexemeKey): ReaderVocabularyState
  setFavorite(context: VocabularyContext, detail: LexemeDetail, favorite: boolean): ReaderVocabularyState
  setContextSaved(context: VocabularyContext, detail: LexemeDetail, saved: boolean): ReaderVocabularyState
  listFavorites(query: VocabularyListQuery): VocabularyListPage
  listContexts(lexemeKey: LexemeKey, offset: number, limit: number): SavedContextPage
  removeFavorite(lexemeKey: LexemeKey): void
}

export interface VocabularyContext {
  publicationId: string
  publicationTitle: string
  articleId: string
  articleTitle: string
  blockId: string
  tokenIndex: number
  text: string
  surface: string
  normalized: string
  sentence: string
}
