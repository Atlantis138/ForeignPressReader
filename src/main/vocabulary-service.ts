import type {
  DictionaryLookupRequest,
  LexemeDetail,
  LexemeKey,
  ReaderVocabularyState,
  SavedContextPage,
  VocabularyListPage,
  VocabularyListQuery,
} from '../shared/types'
import type { DictionaryService } from './dictionary-service'
import type { VocabularyContext, VocabularyRepository } from '../core/lexicon/ports'

export class VocabularyService {
  constructor(
    private readonly repository: VocabularyRepository,
    private readonly dictionary: DictionaryService,
  ) {}

  async getReaderState(
    request: DictionaryLookupRequest,
    lexemeKey: LexemeKey,
  ): Promise<ReaderVocabularyState> {
    const { context } = await this.resolveVerified(request, lexemeKey)
    return this.repository.getReaderState(context, lexemeKey)
  }

  async setFavorite(
    request: DictionaryLookupRequest,
    lexemeKey: LexemeKey,
    favorite: boolean,
  ): Promise<ReaderVocabularyState> {
    const { context, detail } = await this.resolveVerified(request, lexemeKey)
    return this.repository.setFavorite(context, detail, favorite)
  }

  async setContextSaved(
    request: DictionaryLookupRequest,
    lexemeKey: LexemeKey,
    saved: boolean,
  ): Promise<ReaderVocabularyState> {
    const { context, detail } = await this.resolveVerified(request, lexemeKey)
    return this.repository.setContextSaved(context, detail, saved)
  }

  listFavorites(query: VocabularyListQuery): VocabularyListPage {
    return this.repository.listFavorites(query)
  }

  listContexts(lexemeKey: LexemeKey, offset = 0): SavedContextPage {
    return this.repository.listContexts(lexemeKey, offset, 50)
  }

  removeFavorite(lexemeKey: LexemeKey): void {
    this.repository.removeFavorite(lexemeKey)
  }

  private async resolveVerified(
    request: DictionaryLookupRequest,
    lexemeKey: LexemeKey,
  ): Promise<{ context: VocabularyContext; detail: LexemeDetail }> {
    const result = await this.dictionary.lookupInContext(request, lexemeKey)
    if (!result.found || result.lexemeKey !== lexemeKey || result.requiresSelection) {
      throw new Error('当前词形尚未解析到可收藏的 ECDICT 词条')
    }
    const detail = await this.dictionary.getLexeme(lexemeKey)
    if (!detail.entries.length) throw new Error('当前词条不在已安装的 ECDICT 中')
    const context = this.repository.verifyContext(request)
    return { context, detail }
  }
}
