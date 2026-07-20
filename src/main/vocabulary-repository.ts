import type {
  DictionaryLookupRequest,
  LexemeDetail,
  LexemeKey,
  ReaderVocabularyState,
  SavedContextPage,
  VocabularyListPage,
  VocabularyListQuery,
} from '../shared/types'
import type { VocabularyDatabase } from './database-ports'
import type { VocabularyContext, VocabularyRepository } from '../core/lexicon/ports'

export class SqliteVocabularyRepository implements VocabularyRepository {
  constructor(private readonly database: VocabularyDatabase) {}

  verifyContext(request: DictionaryLookupRequest): VocabularyContext {
    return this.database.getLookupContext(
      request.articleId, request.blockId, request.surface, request.tokenIndex,
    )
  }

  getReaderState(context: VocabularyContext, lexemeKey: LexemeKey): ReaderVocabularyState {
    return this.database.getReaderVocabularyState(context, lexemeKey)
  }

  setFavorite(
    context: VocabularyContext,
    detail: LexemeDetail,
    favorite: boolean,
  ): ReaderVocabularyState {
    return this.database.setVocabularyFavorite(context, detail, favorite)
  }

  setContextSaved(
    context: VocabularyContext,
    detail: LexemeDetail,
    saved: boolean,
  ): ReaderVocabularyState {
    return this.database.setVocabularyContext(context, detail, saved)
  }

  listFavorites(query: VocabularyListQuery): VocabularyListPage {
    return this.database.listVocabularyFavorites(query)
  }

  listContexts(lexemeKey: LexemeKey, offset: number, limit: number): SavedContextPage {
    return this.database.listSavedContexts(lexemeKey, offset, limit)
  }

  removeFavorite(lexemeKey: LexemeKey): void {
    this.database.removeManualFavorite(lexemeKey)
  }
}
